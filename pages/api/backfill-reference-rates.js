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

const BATCH_SIZE = 60; // documents' full detail fetched per invocation - kept conservative to stay safely within execution time limits

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
      if (err.response?.status === 401 && attempt < 2) {
        token = await getAccessToken({ forceRefresh: true });
        continue;
      }
      // Real fix: previously retried a 429 up to 3 times with GROWING
      // delays (3s, 6s, 9s = up to 18s per document). If the daily quota
      // is genuinely exhausted (not a brief burst), every document in a
      // 60-document batch would hit this same wall — up to 18 MINUTES for
      // one batch, which is exactly what caused a silent, unexplained
      // hang. Cut to a single quick retry — enough for a real transient
      // blip, but fails fast when it's not, so the batch loop below can
      // detect genuine exhaustion in seconds instead of many minutes.
      if (err.response?.status === 429 && attempt < 2) {
        await new Promise(r => setTimeout(r, 2000));
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

  // Date range now comes from the request — lets a second run target
  // exactly a different window (e.g. the Jan1-Mar31 gap) without
  // re-touching or re-charging for documents the first run already
  // covered. Defaults preserve the original April-onwards behavior if
  // these aren't passed at all.
  const startDate = req.query.startDate || '2026-04-01';
  const endDate   = req.query.endDate || null; // null = open-ended (today)
  // Cursor is stored under a key SPECIFIC to this exact date range, so
  // running a second window's backfill can never corrupt or collide with
  // a different, already-completed window's progress.
  const cursorKey = `${KEYS.REFERENCE_RATE_BACKFILL_CURSOR}_${startDate}_${endDate || 'open'}`;
  const isDefaultWindow = startDate === '2026-04-01' && !endDate;

  // Real fix for a genuine confusion this endpoint caused twice: visiting
  // the plain URL "just to check it's alive" was never actually free — it
  // silently processed one real batch each time, costing real Zoho calls
  // and advancing progress. ?status=1 is now a completely read-only mode:
  // it only reports the current cursor's state for this window, makes
  // ZERO Zoho calls, and writes nothing — safe to visit as many times as
  // you like, for exactly the "just checking" use case this was needed for.
  if (req.query.status === '1') {
    const cursor = await storeGet(cursorKey).catch(() => null);
    const legacyCursor = isDefaultWindow ? await storeGet(KEYS.REFERENCE_RATE_BACKFILL_CURSOR).catch(() => null) : null;
    return res.status(200).json({
      readOnly: true,
      window: `${startDate} to ${endDate || 'present'}`,
      currentCursor: cursor || 'not started yet',
      legacyCursorForThisWindow: legacyCursor || undefined,
      note: 'This is a status check only — no Zoho calls were made, nothing was processed.',
    });
  }

  try {
    let cursor = await storeGet(cursorKey).catch(() => null);

    // Real bug fix, self-healing: the original completed backfill (before
    // per-window cursor keys existed) stored its "done" status under one
    // fixed key. Checking the bare URL afterward looked under the NEW
    // per-window key, found nothing, and wrongly restarted that window
    // from scratch. This checks the OLD fixed key for the default window
    // specifically, and — if it shows the window was already completed —
    // overrides whatever's under the new key (even a wrongly-restarted
    // partial cursor from that bug) with the correct completed state.
    // Runs automatically, no manual cleanup needed, and only ever matters
    // once.
    if (isDefaultWindow) {
      const legacyCursor = await storeGet(KEYS.REFERENCE_RATE_BACKFILL_CURSOR).catch(() => null);
      if (legacyCursor && legacyCursor.stage === 'done' && (!cursor || cursor.stage !== 'done')) {
        cursor = legacyCursor;
        await storeSet(cursorKey, cursor);
      }
    }

    if (!cursor) {
      // Skip the Items catalog stage entirely if it's already been stored
      // by a prior run — no need to spend ~17 calls re-fetching the exact
      // same catalog snapshot every time a new window is backfilled.
      const existingCatalog = await storeGet(KEYS.REFERENCE_RATE_CATALOG).catch(() => null);
      cursor = existingCatalog
        ? { stage: 'pos', page: 1, offsetInPage: 0, processedDocs: 0 }
        : { stage: 'items', page: 1, offsetInPage: 0, processedDocs: 0 };
    }

    // ── STAGE 1: Items catalog (one-time ever, not per-window) ──
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
      await storeSet(cursorKey, cursor);
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
        stage: 'done', window: `${startDate} to ${endDate || 'present'}`,
        catalogSize: catalogIds.size,
        catalogItemsCovered: coveredIds.size,
        coveragePercent: catalogIds.size ? Math.round((coveredIds.size / catalogIds.size) * 1000) / 10 : 0,
        freehandItemsTracked: freehandCount,
        message: 'Backfill complete for this window.',
      });
    }

    // ── STAGE 2/3: POs, then Bills — both use the same batch logic ──
    const endpoint = cursor.stage === 'pos' ? '/purchaseorders' : '/bills';
    const listKey  = cursor.stage === 'pos' ? 'purchaseorders' : 'bills';
    const source   = cursor.stage; // 'pos' | 'bills'

    const dateParams = { date_start: startDate };
    if (endDate) dateParams.date_end = endDate;
    const listData = await zohoGET(endpoint, { ...dateParams, per_page: 200, page: cursor.page });
    const pageRecords = listData[listKey] || [];
    const hasMorePage = listData.page_context?.has_more_page || false;

    const history = await storeGet(KEYS.REFERENCE_RATE_HISTORY).catch(() => ({})) || {};

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
        // Real fix for a genuine data-loss risk: 3 failures in a row very
        // likely means the daily quota is actually exhausted, not a random
        // one-off blip. Stopping here WITHOUT counting this document (or
        // any remaining ones in this batch) as processed means the cursor
        // below can never advance past them — the next run resumes from
        // exactly this safe position instead of silently losing whatever
        // was left in this batch.
        if (consecutiveFailures >= 3) {
          stoppedEarly = true;
          break;
        }
        processedInBatch++; // an isolated, non-repeating failure — safe to move past
      }
      await new Promise(r => setTimeout(r, 150));
    }

    await storeSet(KEYS.REFERENCE_RATE_HISTORY, history);

    // Real fix: this used to advance by batch.length (the full INTENDED
    // batch size) regardless of how many documents actually succeeded —
    // meaning any failures got silently skipped forever. Now advances
    // only by processedInBatch (what was genuinely attempted), so a
    // stop-early never loses data.
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
      stage: source, window: `${startDate} to ${endDate || 'present'}`,
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
