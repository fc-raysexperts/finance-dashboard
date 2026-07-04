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

module.exports = { normalizeItemName, getItemGroupKey, computeReferenceRate, computeReferenceRates };
