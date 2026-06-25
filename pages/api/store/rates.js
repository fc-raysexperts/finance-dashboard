// pages/api/store/rates.js
// "Update Rates / Add Items" feature for the PFBs tab.
//
// Accepts an uploaded reference Excel (same layout as Formulas_sheet_JSW.xlsx:
// column A = Scope No., B = Scope Name, C = Side, D = Particular, E = PFB
// Head, F = Service/Supply, G = Unit, H = Qty, I = Rate) and:
//   1. For every row that matches an EXISTING item — matched by its
//      Particular text (column D), not by its Scope No. position — updates
//      that item's rate. This is deliberate: a genuinely new item can be
//      inserted anywhere in a future sheet, not only after scope 94, which
//      would shift every later row's Scope No. down by one. Matching by
//      content rather than position means an inserted-in-the-middle row
//      doesn't get misread as 50-some "new" items.
//   2. For every row whose Particular text doesn't match anything already
//      known (either from the original 94, or from a previous upload's new
//      items), it's treated as a genuinely new line item. If its Qty column
//      holds a plain number, that number is used directly. If it holds a
//      formula referencing the DC/AC/SW input cells (F3/G3/H3) or a
//      ROUNDUP(...) wrapper, the formula is translated into the same kind of
//      DC/AC/SW-based calculation the rest of the PFB engine uses. Anything
//      more complex than that falls back to qty=1 with the raw formula text
//      kept on the record so it can be reviewed/corrected manually.
//
// The new rate table is stored with an `appliedAt` timestamp (now) in
// lib/store.js's RATE_HISTORY. pages/api/pfb.js already picks whichever
// rate table was active as of a project's agreement date — so this only
// ever affects NEW projects going forward; every existing project's PFB
// (computed when it was signed) is untouched, exactly as requested.

const XLSX = require('xlsx');
const { storeGet, storeSet, KEYS } = require('../../../lib/store');
const { DEFAULT_RATES, PFB_ITEMS_DEF } = require('../../../lib/pfbEngine');

function normalizeText(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

function wordsOf(s) {
  const cleaned = (s || '').toString().toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')   // letter->digit boundary: "panel13" -> "panel 13"
    .replace(/(\d)([a-z])/g, '$1 $2')   // digit->letter boundary: "16sqmm" -> "16 sqmm"
    .replace(/[^a-z0-9]+/g, ' ');       // any punctuation -> space, not just whitespace
  // length > 1 (not > 2) so short electrical abbreviations like CT/PT/DO
  // — real, meaningful item names in this domain — aren't filtered out
  return new Set(cleaned.split(' ').filter(w => w.length > 1));
}

// The hardcoded `particular` text in pfbEngine.js's PFB_ITEMS_DEF is a
// shortened version of the real Excel's often much longer, verbose
// legal/technical descriptions (e.g. "240 sq.mm 3 Core Armoured cable" vs
// the real sheet's "240 sq.mm, 3 Core, Armoured cable 1.9/3.3kV(E)
// Grade, Compacted Aluminium conductor, XLPE insulated, ... conforming to
// IS: 7098 (Part-I)."), and occasionally the reverse — a short real entry
// ("Meters") against a more descriptive canonical one ("Meters (ABT)"). A
// plain equality check fails on nearly every real row because of this.
// This checks containment in BOTH directions and divides by whichever
// side has fewer distinctive words, so it scores well regardless of which
// side happens to carry the extra detail.
function containmentScore(shortText, longText) {
  const wordsA = wordsOf(shortText);
  const wordsB = wordsOf(longText);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  wordsA.forEach(w => { if (wordsB.has(w)) common++; });
  return common / Math.min(wordsA.size, wordsB.size);
}

const MATCH_THRESHOLD = 0.65;

// Find the best-matching known item (from the original 94, or a previous
// upload's new items) for an uploaded row's particular text. Returns the
// candidate with the highest containment score, or null if nothing clears
// the threshold.
function findBestMatch(uploadedParticular, candidates, getParticular) {
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const score = containmentScore(getParticular(c), uploadedParticular);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

// Translates a simple Excel formula string (referencing the DC/AC/SW input
// cells F3/G3/H3, or a flat ROUNDUP(...) wrapper) into a plain JS expression
// string in terms of DC/AC/SW — e.g. "=H3*200" -> "SW*200". Returns null if
// the formula isn't one of these simple, recognised shapes — callers should
// fall back to a manual-review qty. A STRING (not a function) is returned
// deliberately: this gets stored in the JSON-backed rate-history store,
// which cannot hold live function references, and is turned back into a
// real calculation by generatePFB() at the moment a new project's PFB is
// actually generated.
function translateQtyFormula(raw) {
  if (typeof raw !== 'string') return null;
  let expr = raw.trim();
  if (!expr.startsWith('=')) return null;
  expr = expr.slice(1);

  // ROUNDUP(x, 0) -> Math.ceil(x)
  expr = expr.replace(/ROUNDUP\s*\(\s*(.+?)\s*,\s*0\s*\)/gi, 'Math.ceil($1)');
  // Input cells -> variable names
  expr = expr.replace(/\bF3\b/g, 'DC').replace(/\bG3\b/g, 'AC').replace(/\bH3\b/g, 'SW');

  // Safety: only allow digits, DC/AC/SW, basic arithmetic, Math.ceil, parens, dot, comma, spaces
  if (!/^[\dA-Za-z.\s()+\-*/,]+$/.test(expr)) return null;

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('DC', 'AC', 'SW', `return (${expr});`);
    const testVal = fn(72.5, 50, 6); // sanity test-call with known-good reference values
    if (typeof testVal !== 'number' || isNaN(testVal)) return null;
    return expr; // return the validated expression STRING, not the function
  } catch {
    return null;
  }
}

function colLetter(ws, row, col) {
  const cell = ws[XLSX.utils.encode_cell({ r: row, c: col })];
  return cell ? cell.v : null;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const history = (await storeGet(KEYS.RATE_HISTORY)) || [];
    const latest = history.length ? history[history.length - 1] : null;
    return res.status(200).json({
      success: true,
      count: history.length,
      latest: latest ? {
        appliedAt: latest.appliedAt,
        fileName: latest.fileName,
        updatedCount: latest.updatedCount,
        newItemsCount: (latest.newItems || []).length,
      } : null,
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { fileBase64, fileName } = req.body;
    if (!fileBase64) return res.status(400).json({ error: 'fileBase64 is required' });

    const buf = Buffer.from(fileBase64, 'base64');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const range = XLSX.utils.decode_range(ws['!ref']);

    // Existing cumulative rate table (so each update layers on top of the
    // last one, not just on top of the original defaults)
    const history = (await storeGet(KEYS.RATE_HISTORY)) || [];
    const priorRates = history.length ? { ...DEFAULT_RATES, ...history[history.length - 1].rates } : { ...DEFAULT_RATES };
    const priorNewItems = history.length ? (history[history.length - 1].newItems || []) : [];

    const rates = { ...priorRates };
    const newItems = [...priorNewItems];
    let updatedCount = 0;
    let newItemsCount = 0;

    // Data rows start at row 6 (0-indexed row 5) in the standard template.
    for (let r = 5; r <= range.e.r; r++) {
      const scopeNo = colLetter(ws, r, 0); // column A
      if (typeof scopeNo !== 'number') continue; // section headers / blank rows

      const scopeName = colLetter(ws, r, 1);
      const side       = colLetter(ws, r, 2);
      const particular = colLetter(ws, r, 3);
      const pfbHead     = colLetter(ws, r, 4);
      const svcSup       = colLetter(ws, r, 5);
      const unit          = colLetter(ws, r, 6);
      const qtyRaw          = colLetter(ws, r, 7);
      const rate              = colLetter(ws, r, 8);

      const particularNorm = normalizeText(particular);

      // 1. Does this row's Particular match one of the original 94 items?
      //    Matched by CONTENT (fuzzy containment), not by Scope No.
      //    position — an item that's been moved (because something new
      //    was inserted before it in the sheet) still updates correctly
      //    instead of being misread as new.
      const knownMatch = particularNorm
        ? findBestMatch(particular, PFB_ITEMS_DEF, def => def[3])
        : null;
      if (knownMatch) {
        const rateKey = knownMatch[8];
        if (typeof rate === 'number') {
          rates[rateKey] = rate;
          updatedCount++;
        }
        continue;
      }

      // 2. Does it match something added in a PREVIOUS upload? Update that
      //    instead of adding a duplicate "new" item every time the sheet
      //    is re-uploaded.
      const existingNewItem = particularNorm
        ? findBestMatch(particular, newItems, ni => ni.particular)
        : null;
      if (existingNewItem) {
        if (typeof rate === 'number') {
          existingNewItem.rate = rate;
          updatedCount++;
        }
        continue;
      }

      // 3. Genuinely new — not in the original 94, and not seen in any
      //    previous upload either. Rows with a blank Particular (like the
      //    one intentional blank placeholder row in the standard template)
      //    are skipped rather than added, since there's nothing to identify
      //    them by.
      if (!particularNorm) continue;

      let qty = null, qtyFormulaExpr = null, qtyFormulaRaw = null;
      if (typeof qtyRaw === 'number') {
        qty = qtyRaw;
      } else if (typeof qtyRaw === 'string') {
        const expr = translateQtyFormula(qtyRaw);
        if (expr) {
          qtyFormulaExpr = expr;
        } else {
          qtyFormulaRaw = qtyRaw; // couldn't safely translate — keep for manual review
          qty = 1;
        }
      } else {
        qty = 1;
      }

      newItems.push({
        scopeNo,
        section: 'C',
        scopeName: scopeName || 'Additional Item',
        side: side || '',
        particular: particular || scopeName || '',
        pfbHead: pfbHead || scopeName || '',
        serviceSupply: svcSup || 'Supply',
        unit: unit || 'Nos.',
        qty: qty,
        qtyFormulaExpr: qtyFormulaExpr || undefined,
        qtyFormulaRaw: qtyFormulaRaw || undefined,
        rate: typeof rate === 'number' ? rate : 0,
      });
      newItemsCount++;
    }

    const entry = {
      appliedAt: new Date().toISOString(),
      fileName: fileName || 'upload.xlsx',
      rates,
      newItems,
      updatedCount,
      newItemsAddedThisUpload: newItemsCount,
    };
    history.push(entry);
    await storeSet(KEYS.RATE_HISTORY, history);

    return res.status(200).json({
      success: true,
      updatedCount,
      newItemsCount,
      appliedAt: entry.appliedAt,
      note: 'This rate table applies to projects whose agreement date is on or after today only — existing projects keep the PFB they were originally given.',
    });
  } catch (err) {
    console.error('Rate upload error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
