// pages/api/sync-reference-rates-energy.js
//
// Ongoing Reference Rate sync for RPE Energy Reserve — a deliberately
// SEPARATE endpoint from pages/api/sync-reference-rates.js (Rays), same
// reasoning as the backfill: every storage key here is org-scoped to
// 'energy', and it queries Energy's own org ID, so this can never touch
// or blend with Rays' existing sync cursor or reference rate history.
//
// Monitors for recently-approved POs/Bills and records their line items
// as new occurrences — this is what keeps the dataset growing after the
// initial backfill completes. Same "genuinely approved" heuristic as
// the Rays version (excludes pending/draft/void/rejected/cancelled).
//
//   https://your-site.vercel.app/api/sync-reference-rates-energy?key=check123

const axios = require('axios');
const { getAccessToken } = require('../../lib/zohoToken');
const { storeGet, storeSet, KEYS, orgScopedKey } = require('../../lib/store');
const { recordOccurrence, getItemGroupKey } = require('../../lib/referenceRates');
const { getOrgId } = require('../../lib/subsidiaries');

const ORG_KEY = 'energy';
const SYNC_CURSOR_KEY = orgScopedKey('reference_rate_sync_cursor', ORG_KEY);

async function zohoGET(path, params = {}) {
  let token = await getAccessToken();
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: getOrgId(ORG_KEY), ...params },
      });
      return res.data;
    } catch (err) {
      if (err.response?.status === 401 && attempt < 2) { token = await getAccessToken({ forceRefresh: true }); continue; }
      if (err.response?.status === 429 && attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
      throw err;
    }
  }
}

function looksGenuinelyApproved(status) {
  const s = (status || '').toLowerCase();
  if (s === 'pending_approval') return false;
  if (s === 'void' || s === 'rejected' || s === 'draft' || s === 'cancelled') return false;
  return true;
}

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

    const historyKey = orgScopedKey(KEYS.REFERENCE_RATE_HISTORY, ORG_KEY);
    const history = await storeGet(historyKey).catch(() => ({})) || {};
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
              // Same real fix as the backfill file: Energy's real line
              // items have name="" with the actual text in `description`
              // instead — fall back before handing off to the shared,
              // unmodified matching logic.
              const withName = (li.name && li.name.trim()) ? li : { ...li, name: (li.description || '').trim() };
              const grouped = getItemGroupKey(withName);
              if (grouped && alreadyRecorded(history, grouped.key, docNumber, docDate)) return;
              recordOccurrence(history, withName, docDate, docType, docNumber);
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

    await storeSet(historyKey, history);
    await storeSet(SYNC_CURSOR_KEY, { lastSyncDate: new Date().toISOString().slice(0, 10) });

    return res.status(200).json({
      org: ORG_KEY,
      sinceDate,
      documentsChecked,
      newOccurrencesRecorded: newOccurrences,
      statusesSeenThisRun: statusesSeen,
      note: 'statusesSeenThisRun shows every real status value encountered - use this to confirm/tune looksGenuinelyApproved() if some approved documents seem to be missed.',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
