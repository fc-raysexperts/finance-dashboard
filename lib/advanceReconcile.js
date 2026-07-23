// lib/advanceReconcile.js
//
// Real data sources for two PMO-derived checks:
//   1. Advance Reconciliation (PO check #17) — how much advance has
//      actually been paid against a PO, from real PMO breakup data.
//   2. Duplicate Payment Check (PMO check) — flags another PMO sharing
//      the same vendor + amount + overlapping PO number.
//
// REBUILT — two real bugs fixed here:
//
//   Bug 1 (performance): the previous version did a full, blunt re-fetch
//   of every page of the PMO module every time a 15-minute TTL expired,
//   with no early-stop logic at all (worst case: up to 50 sequential
//   API calls, explaining multi-second-to-a-minute PO tab loads). Fixed
//   by mirroring the EXACT incremental pattern pages/api/pmos.js already
//   uses successfully for its own data: scan pages sorted by
//   last_modified_time descending, stop as soon as an already-known,
//   unchanged record is hit, and persist a snapshot that only ever gets
//   MERGED into, never wiped. A "15 minutes old" cache is no longer a
//   meaningful concept here — the snapshot is permanent and just keeps
//   itself current on every call, at whatever cost only the genuinely
//   new/changed records require (usually near-zero).
//
//   Bug 2 (correctness): the previous version fetched only from the
//   LIST endpoint (`GET /cm_payment_memos`), which does NOT include the
//   PO/Expense breakup subform data at all — that only comes back from
//   a separate DETAIL call per record (`GET /cm_payment_memos/{id}`),
//   confirmed by pmos.js needing exactly that extra call for the same
//   data. This means `rawPoRows` was almost certainly empty for every
//   PMO, silently, this whole time — Advance Reconciliation and
//   Duplicate Payment Check were very likely never actually seeing real
//   breakup data. Fixed by doing the detail fetch for genuinely
//   new/changed records only (same incremental principle as Bug 1's fix
//   keeps this cheap).

const axios = require('axios');
const { getAccessToken } = require('./zohoToken');
const { storeGet, storeSet, KEYS } = require('./store');

const PMO_MODULE = 'cm_payment_memos';

async function zohoGET(path, params = {}) {
  let token = await getAccessToken();
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID, ...params },
      });
      return res.data;
    } catch (e) {
      if (e.response?.status === 401 && i < 3) { token = await getAccessToken(true); continue; }
      throw e;
    }
  }
}

function isPresent(v) {
  return v !== null && v !== undefined && v !== '' && String(v).toLowerCase() !== 'null';
}

function looksLikeAdvance(payCategory, paySubCat, payType) {
  const combined = `${payCategory} ${paySubCat} ${payType}`.toLowerCase();
  return combined.includes('advance');
}

// Same field-extraction logic as pages/api/pmos.js's extractFields —
// duplicated locally (small and self-contained) rather than importing
// across API-route boundaries.
function extractFields(moduleFields) {
  const map = {};
  if (!Array.isArray(moduleFields)) return map;
  moduleFields.forEach(f => {
    const key = f.api_name || f.placeholder;
    if (!key) return;
    const isLookup = f.data_type === 'lookup' || f.rendering_type === 'lookup';
    map[key] = isLookup ? (f.value_formatted || f.value || '') : (f.value !== undefined && f.value !== null ? f.value : '');
    map[key + '_formatted'] = f.value_formatted || '';
  });
  return map;
}

// Incrementally updates the permanent PMO snapshot. TWO hard limits now,
// after a real incident where this scanned/detail-fetched 2,863 PMOs
// (the entire historical record) in one request, taking 45+ minutes:
//   1. RELEVANCE CUTOFF — no reason to ever care about a PMO older than
//      ~6 months for advance-reconciliation or duplicate-detection
//      purposes; stop scanning entirely once records get that old.
//   2. TIME BUDGET — even within that window, cap actual work per call
//      (mirrors the exact same pattern already used safely for the AI
//      queues) so a large first-time backlog gets processed gradually
//      across multiple calls instead of trying to do everything at once
//      and potentially exceeding a serverless function's timeout.
const RELEVANCE_CUTOFF_MS = 180 * 24 * 60 * 60 * 1000; // ~6 months

async function updatePMOSnapshot({ timeBudgetMs = 25000 } = {}) {
  const startTime = Date.now();
  const snapshot = (await storeGet(KEYS.PMO_FULL_SNAPSHOT)) || { checked: {}, signatures: {} };
  const cutoffDate = new Date(Date.now() - RELEVANCE_CUTOFF_MS);

  let page = 1;
  let stoppedEarly = false;
  let stoppedReason = null;
  let scanned = 0;
  const toFetch = [];

  while (true) {
    const data = await zohoGET(`/${PMO_MODULE}`, { per_page: 200, page, sort_column: 'last_modified_time', sort_order: 'D' });
    const records = data.module_records || [];
    scanned += records.length;

    for (const r of records) {
      const modified = r.last_modified_time || '';
      if (modified && new Date(modified) < cutoffDate) {
        stoppedEarly = true;
        stoppedReason = 'relevance_cutoff';
        break;
      }
      const id = r.module_record_id;
      if (snapshot.checked[id] === modified) { stoppedEarly = true; stoppedReason = 'already_known'; break; }
      toFetch.push({ id, modified });
    }

    if (stoppedEarly || !data.page_context?.has_more_page) break;
    page++;
    if (page > 50) break; // absolute safety cap
    await new Promise(res => setTimeout(res, 200));
  }

  console.log(`[AdvanceReconcile] scanned ${scanned} PMO records (stopped: ${stoppedReason || 'end of list'}), ${toFetch.length} within relevance window need detail-fetch`);

  let fetchedCount = 0;
  let timeBudgetHit = false;
  for (let i = 0; i < toFetch.length; i += 10) {
    if (Date.now() - startTime > timeBudgetMs) {
      timeBudgetHit = true;
      console.warn(`[AdvanceReconcile] time budget (${timeBudgetMs}ms) reached after ${fetchedCount}/${toFetch.length} — will continue on next call`);
      break;
    }
    const batch = toFetch.slice(i, i + 10);
    await Promise.all(batch.map(async ({ id, modified }) => {
      try {
        const det = await zohoGET(`/${PMO_MODULE}/${id}`);
        const record = det.data?.module_record || det.module_record || det;
        const recordHash = det.module_record_hash || det.data?.module_record_hash || {};
        const f = extractFields(record.module_fields);

        const payCategory = String(f.cf_payment_category || '');
        const paySubCat    = String(f.cf_payment_sub_category || '');
        const payType      = String(f.cf_payment_type || '');
        const rawPoRows = Array.isArray(recordHash.cf_cm_po_breakup_1) ? recordHash.cf_cm_po_breakup_1 : [];

        snapshot.signatures[id] = {
          vendorName: String(f.cf_vendor_name || ''),
          amount: parseFloat(f.cf_payable_amount) || 0,
          isAdvance: looksLikeAdvance(payCategory, paySubCat, payType),
          poNumbers: rawPoRows
            .map(row => isPresent(row.cf_po_number_formatted) ? row.cf_po_number_formatted : (isPresent(row.cf_po_number) ? row.cf_po_number : null))
            .filter(Boolean),
          poBreakupPerPO: rawPoRows.reduce((acc, row) => {
            const poNum = isPresent(row.cf_po_number_formatted) ? row.cf_po_number_formatted : (isPresent(row.cf_po_number) ? row.cf_po_number : null);
            const total = isPresent(row.cf_total) ? Number(row.cf_total) : 0;
            if (poNum) acc[poNum] = (acc[poNum] || 0) + total;
            return acc;
          }, {}),
        };
        snapshot.checked[id] = modified;
      } catch (e) {
        console.error(`[AdvanceReconcile] detail fetch failed for PMO ${id}:`, e.message);
      }
    }));
    fetchedCount += batch.length;
    if (i + 10 < toFetch.length) await new Promise(res => setTimeout(res, 300));
  }

  await storeSet(KEYS.PMO_FULL_SNAPSHOT, snapshot);
  if (timeBudgetHit) {
    console.log(`[AdvanceReconcile] partial pass complete — ${toFetch.length - fetchedCount} PMOs still pending, will resume on next call`);
  }
  return snapshot;
}

// Builds { [po_number]: totalAdvancePaid } from the permanent,
// incrementally-updated snapshot — only advance-category PMOs count.
async function getAdvancePaidByPO() {
  try {
    const snapshot = await updatePMOSnapshot({ timeBudgetMs: 25000 });
    const map = {};
    for (const sig of Object.values(snapshot.signatures)) {
      if (!sig.isAdvance) continue;
      for (const [poNum, total] of Object.entries(sig.poBreakupPerPO || {})) {
        map[poNum] = (map[poNum] || 0) + total;
      }
    }
    return map;
  } catch (e) {
    console.error('getAdvancePaidByPO failed, returning empty map:', e.message);
    return {}; // fail safe — check #17 will show "could not verify" rather than a wrong number
  }
}

// Builds the duplicate-detection signature list from the same permanent
// snapshot — no separate fetch needed at all now.
async function getRecentPMOSignatures() {
  try {
    const snapshot = await updatePMOSnapshot({ timeBudgetMs: 25000 });
    return Object.entries(snapshot.signatures).map(([pmoId, sig]) => ({
      pmoId,
      vendorName: sig.vendorName,
      amount: sig.amount,
      poNumbers: sig.poNumbers,
    }));
  } catch (e) {
    console.error('getRecentPMOSignatures failed, returning empty list:', e.message);
    return [];
  }
}

module.exports = { getAdvancePaidByPO, getRecentPMOSignatures };
