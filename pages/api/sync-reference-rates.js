// pages/api/sync-reference-rates.js
//
// Monitors for POs/Bills that have been genuinely APPROVED recently, and
// records their line items into the shared Reference Rate history — this
// is what makes the dataset grow automatically going forward, per the
// explicit requirement that only approved documents should count.
//
// Why this needs to be a SEPARATE endpoint rather than hooking into the
// existing pos.js/bills.js fetch logic: that logic (lib/zoho.js's
// smartFetch) only ever queries Zoho for status=pending_approval — when a
// document gets approved and drops out of that list, the existing code
// just deletes it from its own cache with ZERO further API call. It never
// actually sees that document's approved detail. So there's no existing
// hook point to attach to; this checks for recent activity independently.
//
// Protected the same way the backfill endpoint is. Call periodically
// (e.g. once a day) — for now, manually via the URL below; can be wired
// into the same GitHub Actions scheduled workflow planned for Phase 5
// notifications once that's built, so it runs automatically.
//
//   https://your-site.vercel.app/api/sync-reference-rates?key=check123

const axios = require('axios');
const { getAccessToken } = require('../../lib/zohoToken');
const { storeGet, storeSet, KEYS } = require('../../lib/store');
const { recordOccurrence, getItemGroupKey } = require('../../lib/referenceRates');

const SYNC_CURSOR_KEY = 'reference_rate_sync_cursor'; // persisted "last checked" timestamp

async function zohoGET(path, params = {}) {
  let token = await getAccessToken();
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID, ...params },
      });
      return res.data;
    } catch (err) {
      if (err.response?.status === 401 && attempt < 2) { token = await getAccessToken({ forceRefresh: true }); continue; }
      if (err.response?.status === 429 && attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
      throw err;
    }
  }
}

// Conservative, honestly-flagged heuristic: a document counts as
// "genuinely approved" if it's no longer pending_approval AND doesn't
// look like a rejection/void. Real Zoho status values vary by org
// configuration — this logs every status it sees once per run so the
// heuristic can be confirmed/tightened against real data, the same
// pattern that correctly resolved every other Zoho-shape question in
// this project so far.
function looksGenuinelyApproved(status) {
  const s = (status || '').toLowerCase();
  if (s === 'pending_approval') return false;
  if (s === 'void' || s === 'rejected' || s === 'draft' || s === 'cancelled') return false;
  return true; // open, billed, paid, closed, partially_billed, partially_paid, etc. all look like real approval outcomes
}

// Avoids double-recording the same document if this sync runs again
// before the cursor advances far enough to exclude it, or on manual re-runs.
function alreadyRecorded(history, groupKey, docNumber, date) {
  const entry = history[groupKey];
  if (!entry) return false;
  return entry.occurrences.some(o => o.docNumber === docNumber && o.date === date);
}

export default async function handler(req, res) {
  if (req.query.key !== 'check123') {
    return res.status(403).json({ error: 'Add ?key=check123 to the URL' });
  }

  try {
    const lookbackDays = parseInt(req.query.lookbackDays) || 7;
    const cursor = await storeGet(SYNC_CURSOR_KEY).catch(() => null);
    const sinceDate = cursor?.lastSyncDate
      || new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const history = await storeGet(KEYS.REFERENCE_RATE_HISTORY).catch(() => ({})) || {};
    const statusesSeen = {};
    let newOccurrences = 0;
    let documentsChecked = 0;

    for (const [endpoint, listKey, docType, idField, numberField] of [
      ['/purchaseorders', 'purchaseorders', 'pos', 'purchaseorder_id', 'purchaseorder_number'],
      ['/bills', 'bills', 'bills', 'bill_id', 'bill_number'],
    ]) {
      let page = 1;
      while (true) {
        const data = await zohoGET(endpoint, { date_start: sinceDate, per_page: 200, page });
        const records = data[listKey] || [];
        for (const rec of records) {
          documentsChecked++;
          statusesSeen[rec.status] = (statusesSeen[rec.status] || 0) + 1;
          if (!looksGenuinelyApproved(rec.status)) continue;

          try {
            const detailData = await zohoGET(`${endpoint}/${rec[idField]}`);
            const doc = docType === 'pos' ? detailData.purchaseorder : detailData.bill;
            const lineItems = doc?.line_items || [];
            const docNumber = doc?.[numberField];
            const docDate   = doc?.date;
            lineItems.forEach(li => {
              const grouped = getItemGroupKey(li);
              if (grouped && alreadyRecorded(history, grouped.key, docNumber, docDate)) return;
              recordOccurrence(history, li, docDate, docType, docNumber);
              newOccurrences++;
            });
          } catch { /* skip this one document, keep going */ }
          await new Promise(r => setTimeout(r, 150));
        }
        if (!data.page_context?.has_more_page) break;
        page++;
        await new Promise(r => setTimeout(r, 150));
      }
    }

    await storeSet(KEYS.REFERENCE_RATE_HISTORY, history);
    await storeSet(SYNC_CURSOR_KEY, { lastSyncDate: new Date().toISOString().slice(0, 10) });

    return res.status(200).json({
      sincDate: sinceDate,
      documentsChecked,
      newOccurrencesRecorded: newOccurrences,
      statusesSeenThisRun: statusesSeen,
      note: 'statusesSeenThisRun shows every real status value encountered - use this to confirm/tune looksGenuinelyApproved() if some approved documents seem to be missed.',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
