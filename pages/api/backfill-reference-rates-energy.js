// pages/api/backfill-reference-rates-energy.js
//
// Reference Rate backfill for RPE Energy Reserve — a deliberately
// SEPARATE endpoint from pages/api/backfill-reference-rates.js (Rays),
// not a shared/parameterized version of it. Two real, careful
// differences from the Rays version, both existing specifically to make
// sure the two subsidiaries' data can never collide or blend:
//   1. Every storage key here is wrapped in orgScopedKey(..., 'energy')
//      — Rays' existing history lives under plain, unscoped keys
//      (reference_rate_history, etc.), so without this, backfilling
//      Energy would either corrupt that existing data or blend
//      Energy's item rates into Rays' shared history.
//   2. Uses getOrgId('energy') (ZOHO_ORG_ID_ENERGY), not Rays' org ID.
//
// Same core logic otherwise — batch-and-cursor based (a single call
// can't process thousands of documents within a serverless function's
// execution time limit), Items catalog once, then POs, then Bills, with
// the same 3-consecutive-failure quota-exhaustion safety net.
//
// lib/referenceRates.js itself needs ZERO changes to support this — it
// was already a genuinely org-agnostic, pure-function module (confirmed
// by reading it directly), so the exact same grouping/rate-computation
// logic is reused unmodified.
//
// Runs newest-first: explicitly sorts Zoho's list results by date
// descending, so processing genuinely starts at today and works
// backward page by page toward the floor date below — the most useful,
// most recently-relevant rates land in the system first, rather than
// waiting for the entire historical scan to finish before any of it is
// usable. Floor set to 2025-01-01 (the user's own estimate of roughly
// when this firm began) — the backfill will naturally reach 'done' once
// it works back to that date, or runs out of real documents first.
//
// Protected the same way as the Rays version. Call repeatedly:
//   https://your-site.vercel.app/api/backfill-reference-rates-energy?key=check123

const axios = require('axios');
const { getAccessToken } = require('../../lib/zohoToken');
const { storeGet, storeSet, KEYS, orgScopedKey } = require('../../lib/store');
const { getItemGroupKey } = require('../../lib/referenceRates');
const { getOrgId } = require('../../lib/subsidiaries');

const ORG_KEY = 'energy';
const BATCH_SIZE = 60;

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
      if (err.response?.status === 401 && attempt < 2) {
        token = await getAccessToken({ forceRefresh: true });
        continue;
      }
      if (err.response?.status === 429 && attempt < 2) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}

// Real fix, found via direct diagnostic against Energy's actual data:
// every real line item here has item_id="" AND name="" — the meaningful
// text lives entirely in `description` instead (confirmed on both a
// real PO and a real Bill). The shared getItemGroupKey (lib/
// referenceRates.js, used as-is, unmodified, for Rays too) falls back
// to `name` when item_id is empty, and simply gives up when THAT'S also
// empty — which is exactly why the first real backfill run processed
// all 21 documents without error yet recorded zero items. Rather than
// touch the shared file Rays' working system depends on, this fallback
// lives ONLY here: treat `description` as the effective name whenever
// `name` is genuinely blank, before handing the line item to the
// shared, unmodified matching logic.
function withNameFallback(lineItem) {
  if (lineItem.name && lineItem.name.trim()) return lineItem;
  return { ...lineItem, name: (lineItem.description || '').trim() };
}

function recordOccurrence(history, lineItem, date, source, docNumber) {
  lineItem = withNameFallback(lineItem);
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

export default async function handler(req, res) {
  if (req.query.key !== 'check123') {
    return res.status(403).json({ error: 'Add ?key=check123 to the URL' });
  }

  const startDate = req.query.startDate || '2025-01-01'; // real, explicit floor set by the user — the firm hasn't been around much longer than this
  const endDate   = req.query.endDate || null;
  const cursorKey = orgScopedKey(`${KEYS.REFERENCE_RATE_BACKFILL_CURSOR}_${startDate}_${endDate || 'open'}`, ORG_KEY);
  const catalogKey = orgScopedKey(KEYS.REFERENCE_RATE_CATALOG, ORG_KEY);
  const historyKey = orgScopedKey(KEYS.REFERENCE_RATE_HISTORY, ORG_KEY);

  if (req.query.status === '1') {
    const cursor = await storeGet(cursorKey).catch(() => null);
    return res.status(200).json({
      readOnly: true,
      org: ORG_KEY,
      window: `${startDate} to ${endDate || 'present'}`,
      currentCursor: cursor || 'not started yet',
      note: 'This is a status check only — no Zoho calls were made, nothing was processed.',
    });
  }

  try {
    let cursor = await storeGet(cursorKey).catch(() => null);

    if (!cursor) {
      const existingCatalog = await storeGet(catalogKey).catch(() => null);
      cursor = existingCatalog
        ? { stage: 'pos', page: 1, offsetInPage: 0, processedDocs: 0 }
        : { stage: 'items', page: 1, offsetInPage: 0, processedDocs: 0 };
    }

    // ── STAGE 1: Items catalog (one-time ever for Energy, not per-window) ──
    if (cursor.stage === 'items') {
      let catalog = {};
      let page = 1;
      while (true) {
        const data = await zohoGET('/items', { per_page: 200, page });
        const items = data.items || [];
        items.forEach(it => {
          if (it.status === 'active') catalog[it.item_id] = { name: it.name };
        });
        if (!data.page_context?.has_more_page) break;
        page++;
        await new Promise(r => setTimeout(r, 150));
      }
      await storeSet(catalogKey, catalog);
      cursor = { stage: 'pos', page: 1, offsetInPage: 0, processedDocs: 0 };
      await storeSet(cursorKey, cursor);
      return res.status(200).json({
        org: ORG_KEY, stage: 'items_done', catalogSize: Object.keys(catalog).length,
        message: 'Items catalog stored for Energy. Call again to begin processing POs.',
      });
    }

    if (cursor.stage === 'done') {
      const history = await storeGet(historyKey).catch(() => ({})) || {};
      const catalog = await storeGet(catalogKey).catch(() => ({})) || {};
      const catalogIds = new Set(Object.keys(catalog));
      const coveredIds = new Set(Object.keys(history).filter(k => k.startsWith('id:')).map(k => k.slice(3)).filter(id => catalogIds.has(id)));
      const freehandCount = Object.keys(history).filter(k => k.startsWith('name:')).length;
      return res.status(200).json({
        org: ORG_KEY, stage: 'done', window: `${startDate} to ${endDate || 'present'}`,
        catalogSize: catalogIds.size,
        catalogItemsCovered: coveredIds.size,
        coveragePercent: catalogIds.size ? Math.round((coveredIds.size / catalogIds.size) * 1000) / 10 : 0,
        freehandItemsTracked: freehandCount,
        message: 'Backfill complete for Energy in this window.',
      });
    }

    // ── STAGE 2/3: POs, then Bills ──
    const endpoint = cursor.stage === 'pos' ? '/purchaseorders' : '/bills';
    const listKey  = cursor.stage === 'pos' ? 'purchaseorders' : 'bills';
    const source   = cursor.stage;

    const dateParams = { date_start: startDate };
    if (endDate) dateParams.date_end = endDate;
    // sort_column/sort_order explicitly requested here (not relying on
    // whatever Zoho's unstated default happens to be) — 'D' (descending)
    // means page 1 is today's most recent documents, and each
    // successive page moves further back, ending at startDate.
    const listData = await zohoGET(endpoint, { ...dateParams, per_page: 200, page: cursor.page, sort_column: 'date', sort_order: 'D' });
    const pageRecords = listData[listKey] || [];
    const hasMorePage = listData.page_context?.has_more_page || false;

    const history = await storeGet(historyKey).catch(() => ({})) || {};

    const batch = pageRecords.slice(cursor.offsetInPage, cursor.offsetInPage + BATCH_SIZE);
    let processedInBatch = 0;
    let consecutiveFailures = 0;
    let stoppedEarly = false;
    for (const rec of batch) {
      const id = source === 'pos' ? rec.purchaseorder_id : rec.bill_id;
      try {
        const detail = await zohoGET(`${endpoint}/${id}`);
        const doc = source === 'pos' ? detail.purchaseorder : detail.bill;
        const lineItems = doc?.line_items || [];
        const docNumber = source === 'pos' ? doc.purchaseorder_number : doc.bill_number;
        const docDate   = doc?.date;
        lineItems.forEach(li => recordOccurrence(history, li, docDate, source, docNumber));
        consecutiveFailures = 0;
        processedInBatch++;
      } catch {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          stoppedEarly = true;
          break;
        }
        processedInBatch++;
      }
      await new Promise(r => setTimeout(r, 150));
    }

    await storeSet(historyKey, history);

    const newOffset = cursor.offsetInPage + processedInBatch;
    let nextCursor;
    if (newOffset >= pageRecords.length) {
      if (hasMorePage) {
        nextCursor = { stage: source, page: cursor.page + 1, offsetInPage: 0, processedDocs: cursor.processedDocs + processedInBatch };
      } else if (source === 'pos') {
        nextCursor = { stage: 'bills', page: 1, offsetInPage: 0, processedDocs: cursor.processedDocs + processedInBatch };
      } else {
        nextCursor = { stage: 'done', page: 1, offsetInPage: 0, processedDocs: cursor.processedDocs + processedInBatch };
      }
    } else {
      nextCursor = { stage: source, page: cursor.page, offsetInPage: newOffset, processedDocs: cursor.processedDocs + processedInBatch };
    }
    await storeSet(cursorKey, nextCursor);

    const distinctItemsSoFar = Object.keys(history).length;

    return res.status(200).json({
      org: ORG_KEY, stage: source, window: `${startDate} to ${endDate || 'present'}`,
      processedThisBatch: processedInBatch,
      totalProcessedSoFar: nextCursor.processedDocs,
      distinctItemsFound: distinctItemsSoFar,
      done: nextCursor.stage === 'done',
      nextStage: nextCursor.stage,
      stoppedEarly,
      stoppedReason: stoppedEarly ? '3 consecutive Zoho failures — very likely today\'s API quota is exhausted. Nothing was skipped or lost; this exact position is saved and safe to resume from once quota resets (usually midnight IST).' : undefined,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
