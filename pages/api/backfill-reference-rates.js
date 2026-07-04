// pages/api/backfill-reference-rates.js
//
// One-time (well, repeatable-until-done) backfill for the Reference Rate
// system. Designed to be called REPEATEDLY by a small local script
// (run-backfill.js) rather than once — a single call can't realistically
// process all ~2,035 documents in one HTTP request/response cycle
// (serverless functions have execution time limits; 2,000+ sequential
// Zoho detail calls would take many minutes), so this processes one safe
// batch per call and remembers exactly where it left off via a persisted
// cursor, so calling it again continues rather than restarts.
//
// Protected via a URL key parameter, same pattern as the earlier
// debug-kv-sizes.js diagnostic — this is a write-capable, cost-incurring
// endpoint and shouldn't be triggerable by anyone just guessing the URL.
//
// Visit/call repeatedly:
//   https://your-site.vercel.app/api/backfill-reference-rates?key=check123
// (the local run-backfill.js script does this automatically in a loop)

const axios = require('axios');
const { getAccessToken } = require('../../lib/zohoToken');
const { storeGet, storeSet, KEYS } = require('../../lib/store');
const { getItemGroupKey } = require('../../lib/referenceRates');

const BACKFILL_START_DATE = '2026-04-01'; // the confirmed 3-month window
const BATCH_SIZE = 60; // documents' full detail fetched per invocation - kept conservative to stay safely within execution time limits

async function zohoGET(path, params = {}) {
  let token = await getAccessToken();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID, ...params },
      });
      return res.data;
    } catch (err) {
      if (err.response?.status === 401 && attempt < 3) {
        token = await getAccessToken({ forceRefresh: attempt === 2 });
        continue;
      }
      if (err.response?.status === 429 && attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 3000));
        continue;
      }
      throw err;
    }
  }
}

function recordOccurrence(history, lineItem, date, source, docNumber) {
  const grouped = getItemGroupKey(lineItem);
  if (!grouped) return;
  const key = grouped.key;
  if (!history[key]) {
    history[key] = { name: lineItem.name || '(unnamed)', catalogMatched: grouped.catalogMatched, occurrences: [] };
  }
  history[key].occurrences.push({ date, rate: Number(lineItem.rate) || 0, source, docNumber });
  // Keep each item's history bounded — we only ever need the last handful
  // to compute "average of last 3 within 30 days", so cap stored
  // occurrences per item rather than let this grow forever.
  if (history[key].occurrences.length > 10) {
    history[key].occurrences.sort((a, b) => new Date(b.date) - new Date(a.date));
    history[key].occurrences = history[key].occurrences.slice(0, 10);
  }
}

export default async function handler(req, res) {
  if (req.query.key !== 'check123') {
    return res.status(403).json({ error: 'Add ?key=check123 to the URL' });
  }

  try {
    let cursor = await storeGet(KEYS.REFERENCE_RATE_BACKFILL_CURSOR).catch(() => null);
    if (!cursor) {
      cursor = { stage: 'items', page: 1, offsetInPage: 0, processedDocs: 0 };
    }

    // ── STAGE 1: Items catalog (one-time, done fully in a single call —
    // ~17 list calls for the whole catalog, safely within limits) ──
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
      await storeSet(KEYS.REFERENCE_RATE_CATALOG, catalog);
      cursor = { stage: 'pos', page: 1, offsetInPage: 0, processedDocs: 0 };
      await storeSet(KEYS.REFERENCE_RATE_BACKFILL_CURSOR, cursor);
      return res.status(200).json({
        stage: 'items_done', catalogSize: Object.keys(catalog).length,
        message: 'Items catalog stored. Call again to begin processing POs.',
      });
    }

    if (cursor.stage === 'done') {
      const history = await storeGet(KEYS.REFERENCE_RATE_HISTORY).catch(() => ({})) || {};
      const catalog = await storeGet(KEYS.REFERENCE_RATE_CATALOG).catch(() => ({})) || {};
      const catalogIds = new Set(Object.keys(catalog));
      const coveredIds = new Set(Object.keys(history).filter(k => k.startsWith('id:')).map(k => k.slice(3)).filter(id => catalogIds.has(id)));
      const freehandCount = Object.keys(history).filter(k => k.startsWith('name:')).length;
      return res.status(200).json({
        stage: 'done',
        catalogSize: catalogIds.size,
        catalogItemsCovered: coveredIds.size,
        coveragePercent: catalogIds.size ? Math.round((coveredIds.size / catalogIds.size) * 1000) / 10 : 0,
        freehandItemsTracked: freehandCount,
        message: 'Backfill complete.',
      });
    }

    // ── STAGE 2/3: POs, then Bills — both use the same batch logic ──
    const endpoint = cursor.stage === 'pos' ? '/purchaseorders' : '/bills';
    const listKey  = cursor.stage === 'pos' ? 'purchaseorders' : 'bills';
    const source   = cursor.stage; // 'pos' | 'bills'

    const listData = await zohoGET(endpoint, { date_start: BACKFILL_START_DATE, per_page: 200, page: cursor.page });
    const pageRecords = listData[listKey] || [];
    const hasMorePage = listData.page_context?.has_more_page || false;

    const history = await storeGet(KEYS.REFERENCE_RATE_HISTORY).catch(() => ({})) || {};

    const batch = pageRecords.slice(cursor.offsetInPage, cursor.offsetInPage + BATCH_SIZE);
    let processedInBatch = 0;
    for (const rec of batch) {
      const id = source === 'pos' ? rec.purchaseorder_id : rec.bill_id;
      try {
        const detail = await zohoGET(`${endpoint}/${id}`);
        const doc = source === 'pos' ? detail.purchaseorder : detail.bill;
        const lineItems = doc?.line_items || [];
        const docNumber = source === 'pos' ? doc.purchaseorder_number : doc.bill_number;
        const docDate   = doc?.date;
        lineItems.forEach(li => recordOccurrence(history, li, docDate, source, docNumber));
      } catch { /* skip this one document, keep going — a single failure shouldn't stop the whole backfill */ }
      processedInBatch++;
      await new Promise(r => setTimeout(r, 150));
    }

    await storeSet(KEYS.REFERENCE_RATE_HISTORY, history);

    const newOffset = cursor.offsetInPage + batch.length;
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
    await storeSet(KEYS.REFERENCE_RATE_BACKFILL_CURSOR, nextCursor);

    const distinctItemsSoFar = Object.keys(history).length;

    return res.status(200).json({
      stage: source,
      processedThisBatch: processedInBatch,
      totalProcessedSoFar: nextCursor.processedDocs,
      distinctItemsFound: distinctItemsSoFar,
      done: nextCursor.stage === 'done',
      nextStage: nextCursor.stage,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
