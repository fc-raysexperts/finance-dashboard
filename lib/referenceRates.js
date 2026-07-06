// lib/referenceRates.js
//
// Reference Rate system - core logic, kept separate from any specific API
// route so both the one-time backfill and the ongoing PO/Bill enrichment
// (a later build step) can share the exact same rules.
//
// GROUPING — explicitly NOT fuzzy matching, per direct instruction: fuzzy
// name-similarity was found to produce false-positive matches between
// genuinely different items (e.g. different cable sizes). Instead:
//   1. If a line item has a real item_id (picked from Zoho's own Items
//      catalog), that ID is the group key — authoritative, zero ambiguity,
//      since Zoho's own catalog already treats different specs as
//      different registered items.
//   2. Only when item_id is absent (freehand-typed line item) does this
//      fall back to a STRICT normalized-name key — case, whitespace, and
//      punctuation differences are ignored, but nothing else. Numbers/
//      specs/units are never touched, so "Solar Cable 4mm" and
//      "Solar Cable 6mm" can never collapse into the same group.

function normalizeItemName(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[.,()/\\-]+/g, ' ')   // punctuation -> space (not deleted, so "4-mm" and "4 mm" still separate from "4mm")
    .replace(/\s+/g, ' ')          // collapse repeated whitespace
    .trim();
}

// Returns the group key for a line item, and whether it was matched via
// the authoritative item_id (catalogMatched=true) or the strict name
// fallback (catalogMatched=false).
function getItemGroupKey(lineItem) {
  if (lineItem.item_id) {
    return { key: `id:${lineItem.item_id}`, catalogMatched: true };
  }
  const normalized = normalizeItemName(lineItem.name);
  if (!normalized) return null; // nothing usable to group by at all
  return { key: `name:${normalized}`, catalogMatched: false };
}

// Reference Rate = average of the last 3 occurrences within 30 days of
// `asOfDate` (defaults to now). Falls back to averaging however many
// exist within that window (1 or 2) if fewer than 3. If literally none
// fall within the last 30 days, falls back to the single most recent
// occurrence ever, regardless of age — so an item is never left with "no
// reference rate at all" as long as it has at least one recorded price.
//
// Computed fresh from raw stored occurrences every time this is called —
// deliberately NOT frozen at backfill time, so the 30-day window keeps
// shifting forward correctly as real time passes, with zero need to ever
// re-run the backfill just to keep numbers current.
function computeReferenceRate(occurrences, asOfDate) {
  if (!occurrences || occurrences.length === 0) return null;
  const now = asOfDate ? new Date(asOfDate) : new Date();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  const sorted = [...occurrences].sort((a, b) => new Date(b.date) - new Date(a.date));
  const within30 = sorted.filter(o => (now - new Date(o.date)) <= THIRTY_DAYS_MS && (now - new Date(o.date)) >= 0);

  let used;
  if (within30.length > 0) {
    used = within30.slice(0, 3); // most recent up to 3, within the window
  } else {
    used = [sorted[0]]; // fallback: single most recent occurrence ever, regardless of age
  }

  const avg = used.reduce((s, o) => s + (Number(o.rate) || 0), 0) / used.length;
  return {
    rate: Math.round(avg * 100) / 100,
    occurrenceCount: used.length,
    usedFallback: within30.length === 0,
    mostRecentDate: used[0].date,
  };
}

// Real fix for a gap correctly spotted: the raw occurrence list already
// tags every entry with its source ('pos' or 'bills'), but until now
// nothing actually split on that tag — computeReferenceRate() alone would
// blend PO and Bill prices into one combined average. This computes BOTH
// as genuinely separate numbers from the same stored history, which is
// what the original design called for (PO-sourced and Bill-sourced
// tracked separately). Nothing needs to be re-fetched or re-backfilled —
// the source tag was already being captured correctly all along, this
// just actually uses it.
function computeReferenceRates(occurrences, asOfDate) {
  const poOccurrences   = (occurrences || []).filter(o => o.source === 'pos');
  const billOccurrences = (occurrences || []).filter(o => o.source === 'bills');
  return {
    po:       computeReferenceRate(poOccurrences, asOfDate),
    bill:     computeReferenceRate(billOccurrences, asOfDate),
    combined: computeReferenceRate(occurrences, asOfDate), // kept too — useful when only one source has any history at all
  };
}

// Records one line item's rate as a new occurrence in the shared history -
// moved here from the backfill endpoint so both the one-time backfill AND
// live PO/Bill approval monitoring (a later hook) use IDENTICAL logic,
// never two slightly-different implementations that could drift apart.
function recordOccurrence(history, lineItem, date, source, docNumber) {
  const grouped = getItemGroupKey(lineItem);
  if (!grouped) return;
  const key = grouped.key;
  if (!history[key]) {
    history[key] = { name: lineItem.name || '(unnamed)', catalogMatched: grouped.catalogMatched, occurrences: [] };
  }
  history[key].occurrences.push({ date, rate: Number(lineItem.rate) || 0, source, docNumber });
  if (history[key].occurrences.length > 10) {
    history[key].occurrences.sort((a, b) => new Date(b.date) - new Date(a.date));
    history[key].occurrences = history[key].occurrences.slice(0, 10);
  }
}

// Assembles one full row for the dedicated Reference Rate table — every
// field explicitly requested: this document's own item name, the closest
// official Zoho catalog name we can offer (exact when item_id matched,
// a best-effort textual match otherwise — used ONLY for display, never
// for grouping/merging data, since fuzzy matching for grouping was
// explicitly rejected earlier), tags, account, today's rate vs the
// relevant Reference Rate with a real status, and — critically — the
// LAST-USED date and document number always point at the single most
// recent real occurrence, never a blended/averaged date, even when the
// rate itself is an average of up to 3 occurrences.
function buildReferenceRateRow(lineItem, docType, catalog, history, nameSimilarityFn, asOfDate) {
  const grouped = getItemGroupKey(lineItem);
  if (!grouped) return null;
  const entry = history[grouped.key];
  if (!entry || entry.occurrences.length === 0) {
    return {
      itemName: lineItem.name || '(unnamed)',
      hasHistory: false,
    };
  }

  const rates = computeReferenceRates(entry.occurrences, asOfDate);
  // Real bug fixed: previously this was ONLY the source-matched rate
  // (po-only for POs, bill-only for Bills) with no fallback — but
  // Last Used Date/Doc below always looks across BOTH sources, so an
  // item that's only ever appeared on POs would correctly show a real
  // "last used" PO reference while the Reference Rate itself came back
  // blank on a Bill (confirmed: BESS TRANSFORMER 1650KVA on Bill
  // STS/26-27/037). Falls back to the combined rate when the
  // same-source-only figure isn't available, so a real number is always
  // shown whenever ANY history exists — clearly flagged via
  // usedCrossSource so the table can note it's blended across both.
  const sameSource = docType === 'po' ? rates.po : rates.bill;
  const relevant = sameSource || rates.combined;
  const usedCrossSource = !sameSource && !!rates.combined;

  // Official ZB name: exact if item_id matched a real catalog entry;
  // otherwise a best-effort closest name purely for readability.
  let officialName = null;
  let officialNameIsExact = false;
  if (lineItem.item_id && catalog[lineItem.item_id]) {
    officialName = catalog[lineItem.item_id].name;
    officialNameIsExact = true;
  } else if (nameSimilarityFn) {
    let best = null, bestScore = 0;
    for (const id of Object.keys(catalog)) {
      const score = nameSimilarityFn((lineItem.name || '').toLowerCase(), (catalog[id].name || '').toLowerCase());
      if (score > bestScore) { bestScore = score; best = catalog[id].name; }
    }
    if (best && bestScore > 0.4) officialName = best;
  }

  // Last-used date/doc always come from the single most recent occurrence
  // overall (not filtered to just PO or just Bill), since that's the
  // genuinely last time this item was priced at all, on either side.
  const mostRecent = [...entry.occurrences].sort((a, b) => new Date(b.date) - new Date(a.date))[0];

  const currentRate = Number(lineItem.rate) || 0;
  const status = relevant ? compareValueLocal(currentRate, relevant.rate) : { status: 'na', variance: null };

  // Tags kept as an ordered array (Project Head first, then PFB Head)
  // rather than a single joined string, so the table can show each on
  // its own line as requested, in a consistent, predictable order
  // regardless of what order Zoho itself returns them in.
  const tagMap = {};
  (lineItem.tags || []).forEach(t => { tagMap[t.tag_name] = t.tag_option_name; });
  const orderedTags = [];
  if (tagMap['Project Head']) orderedTags.push(`Project Head: ${tagMap['Project Head']}`);
  if (tagMap['PFB Head']) orderedTags.push(`PFB Head: ${tagMap['PFB Head']}`);
  Object.keys(tagMap).forEach(k => { if (k !== 'Project Head' && k !== 'PFB Head') orderedTags.push(`${k}: ${tagMap[k]}`); });

  return {
    itemName: lineItem.name || '(unnamed)',
    officialName, officialNameIsExact,
    tags: orderedTags,
    projectHead: tagMap['Project Head'] || null,
    pfbHead: tagMap['PFB Head'] || null,
    account: lineItem.account_name || '',
    currentRate,
    refRatePO: rates.po ? rates.po.rate : null,
    refRateBill: rates.bill ? rates.bill.rate : null,
    refRateUsed: relevant ? relevant.rate : null,
    refStatus: status.status,
    usedCrossSource,
    refVariance: status.variance,
    lastUsedDate: mostRecent.date,
    lastUsedDocNumber: mostRecent.docNumber,
    lastUsedSource: mostRecent.source,
    hasHistory: true,
  };
}

// Minimal local copy of the same direction-aware comparison used
// elsewhere (pfbEngine.js's compareValue) — duplicated rather than
// imported to keep this file dependency-free or callers can pass their
// own; kept intentionally identical in behavior.
function compareValueLocal(actual, reference) {
  if (reference == null || reference <= 0 || actual == null) return { variance: null, status: 'na' };
  const variance = Math.round(((actual - reference) / reference) * 1000) / 10;
  let status;
  if (Math.abs(variance) <= 10) status = 'ok';
  else if (variance > 25) status = 'over_severe';
  else if (variance > 10) status = 'over_caution';
  else if (variance < -25) status = 'under_severe';
  else status = 'under_caution';
  return { variance, status };
}

module.exports = { normalizeItemName, getItemGroupKey, computeReferenceRate, computeReferenceRates, recordOccurrence, buildReferenceRateRow };
