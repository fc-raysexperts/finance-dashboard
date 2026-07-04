// lib/zoho.js — Smart delta cache version
// Strategy: fetch list always (2 calls), fetch detail ONLY for new/changed items
// Result: ~100-200 API calls per day instead of 17,000
//
// PERSISTENCE ADDED: the delta-cache below (detailCache/listSnapshot/
// lastListFetch) was pure in-memory — fine on a long-running local dev
// server, but on Vercel every serverless function gets recycled
// constantly (idle periods, scaling, and every single redeploy), wiping
// this cache back to empty. Once that happens, the "smart" delta logic
// has no memory of what it already fetched, so it treats every pending
// item as new again and re-fetches full detail for all of them — the
// exact expensive behavior this cache exists to prevent. It's now also
// persisted to the same KV store used elsewhere, so it survives cold
// starts and redeploys.
//
// MANUAL-REFRESH-ONLY ADDED: getPendingPOs()/getPendingBills() now take
// an optional forceRefresh flag. When false (a normal page load), this
// serves directly from the persisted cache — no Zoho call at all, not
// even the list endpoint — unless no cache exists yet. A real fetch only
// happens when forceRefresh is true (the user clicked Refresh) or on the
// very first call ever.

const axios = require('axios');
const { storeGet, storeSet, KEYS } = require('./store');

const JATIN_USER_ID  = '2346113000000742107';
const APPROVER_EMAIL = 'jatin.srivastava@raysexperts.com';

// ── TOKEN MANAGER ─────────────────────────────────────────────
const { getAccessToken } = require('./zohoToken');

// ── BASE CALLER — with 401 and 429 retry ───────────────────────
async function zohoGET(path, params = {}) {
  let token = await getAccessToken();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(
        `https://www.zohoapis.in/books/v3${path}`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          params:  { organization_id: process.env.ZOHO_ORG_ID, ...params },
        }
      );
      return res.data;
    } catch (err) {
      if (err.response?.status === 401 && attempt === 1) {
        token = await getAccessToken({ skipMemoryCache: true });
        continue;
      }
      if (err.response?.status === 401 && attempt === 2) {
        token = await getAccessToken({ forceRefresh: true });
        continue;
      }
      if (err.response?.status === 429 && attempt < 3) {
        await sleep(attempt * 3000);
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── SMART DELTA CACHE ─────────────────────────────────────────
const STORE = {
  pos: {
    detailCache:     {}, // id -> full detail object, ONLY for items confirmed to be Jatin's
    checkedSnapshot: {}, // id -> { modified, isJatin } for EVERY item ever checked, tiny
    hydrated:        false, // have we tried loading from KV yet, this process lifetime?
  },
  bills: {
    detailCache:     {},
    checkedSnapshot: {},
    hydrated:        false,
  },
};

const STORE_KEY = { pos: KEYS.ZOHO_DELTA_POS, bills: KEYS.ZOHO_DELTA_BILLS };
const hydratePromises = { pos: null, bills: null };

// Concurrent callers (e.g. bills.js checking many linked POs via
// Promise.all) must all wait for the SAME hydration to actually finish —
// a simple "already tried?" boolean flag isn't enough, since several
// concurrent calls can all see "not yet" before the very first one has
// actually finished loading the cache, and proceed as if it's empty even
// though it genuinely isn't. This is the same category of bug the token
// refresh had earlier — fixed there with a shared promise, missing here
// until now.
async function hydrateFromPersistedStore(type) {
  const store = STORE[type];
  if (store.hydrated) return;

  if (!hydratePromises[type]) {
    hydratePromises[type] = (async () => {
      try {
        const persisted = await storeGet(STORE_KEY[type]);
        // checkedSnapshot is the new shape — old persisted caches (pre-
        // redesign) won't have it, so they're treated as "nothing usable
        // yet" and this does one clean bootstrap under the new structure.
        if (persisted && persisted.checkedSnapshot && Object.keys(persisted.checkedSnapshot).length > 0) {
          store.detailCache     = persisted.detailCache     || {};
          store.checkedSnapshot = persisted.checkedSnapshot || {};
        }
      } catch { /* KV unavailable — proceed with whatever's in memory (likely empty) */ }
      store.hydrated = true;
    })();
  }
  return hydratePromises[type];
}

async function persistStore(type) {
  const store = STORE[type];
  await storeSet(STORE_KEY[type], {
    detailCache:     store.detailCache,     // ONLY Jatin's items' full detail
    checkedSnapshot: store.checkedSnapshot, // EVERY item's {modified, isJatin} — tiny
  }).catch(() => {});
}

async function smartFetch(type, forceRefresh) {
  const store      = STORE[type];
  const endpoint   = type === 'pos' ? '/purchaseorders' : '/bills';
  const listKey    = type === 'pos' ? 'purchaseorders' : 'bills';
  const idField    = type === 'pos' ? 'purchaseorder_id' : 'bill_id';

  await hydrateFromPersistedStore(type);

  // Normal page load (not an explicit refresh): serve straight from
  // whatever's cached, with NO Zoho call at all — unless there's no
  // cache yet (very first call ever for this data).
  if (!forceRefresh && Object.keys(store.checkedSnapshot).length > 0) {
    return Object.values(store.detailCache);
  }

  // Fetch full list of pending_approval records — Zoho's status filter is
  // company-wide ("pending SOMEONE's approval"), not "pending Jatin's
  // approval" specifically, so this naturally includes everyone else's
  // pending items too. Confirmed via production logs that this account's
  // list response doesn't expose a usable approver field, so unlike an
  // earlier attempt, there's no list-level pre-filtering here — every
  // item's approver status can only be known via its detail.
  let currentListItems = [];
  let page = 1;
  while (true) {
    const data  = await zohoGET(endpoint, {
      status:   'pending_approval',
      per_page: 200,
      page,
    });
    currentListItems = currentListItems.concat(data[listKey] || []);
    if (!data.page_context?.has_more_page) break;
    page++;
    await sleep(200);
  }

  // Step 2: Find what's new or changed SINCE WE LAST CHECKED IT — this is
  // the key fix. Previously, "changed" was compared against a snapshot
  // that only existed for items already confirmed to be Jatin's, so any
  // company-wide item being seen for the first time (which is most of
  // them, every time, since they were never kept in detailCache at all if
  // they weren't his) looked "new" and got needlessly considered. Now
  // EVERY item — Jatin's or not — gets a permanent tiny marker the first
  // time it's checked, so something that's already been confirmed as
  // "not mine, and hasn't changed since" is skipped immediately, with no
  // detail call, no matter how many times other people's documents get
  // refreshed over time.
  const toFetch    = [];
  const currentIds = new Set();

  for (const item of currentListItems) {
    const id       = item[idField];
    const modified = item.last_modified_time || item.created_time || '';
    currentIds.add(id);

    const checked = store.checkedSnapshot[id];
    if (checked && checked.modified === modified) {
      continue; // already know this exact version's approver status — skip entirely
    }
    toFetch.push(id);
  }

  // Step 3: Remove anything no longer in the live list at all (approved/
  // rejected/deleted company-wide) from BOTH the detail cache and the
  // marker snapshot.
  for (const id of Object.keys(store.checkedSnapshot)) {
    if (!currentIds.has(id)) {
      delete store.checkedSnapshot[id];
      delete store.detailCache[id];
    }
  }

  // Step 4: Detail-fetch only items that are new or genuinely changed
  // since we last checked them — regardless of whose they turn out to be.
  // This part is unavoidable: Zoho doesn't expose enough at the list level
  // for this account to know in advance whether a changed item is now
  // Jatin's without checking. But the result of checking is now recorded
  // permanently (the tiny marker), so the SAME item never costs a call
  // again unless it changes yet again — company-wide churn that has
  // nothing to do with Jatin's queue only ever costs once per item, not
  // once per refresh forever.
  if (toFetch.length > 0) {
    console.log(`${type}: ${currentListItems.length} pending company-wide, ${toFetch.length} new/changed since last check`);

    for (let i = 0; i < toFetch.length; i += 10) {
      const batch = toFetch.slice(i, i + 10);
      const details = await Promise.all(
        batch.map(id =>
          type === 'pos' ? getPODetail(id) : getBillDetail(id)
        )
      );
      for (const detail of details) {
        if (!detail) continue;
        const id       = detail[idField];
        const modified = detail.last_modified_time || detail.created_time || '';
        const isJatin  = isJatinCurrentApprover(detail);
        store.checkedSnapshot[id] = { modified, isJatin };
        if (isJatin) {
          store.detailCache[id] = detail; // keep full detail ONLY for his own items
        } else {
          delete store.detailCache[id]; // never store full detail for anyone else's
        }
      }
      if (i + 10 < toFetch.length) await sleep(500);
    }
  } else {
    console.log(`${type}: ${currentListItems.length} pending company-wide, 0 changed since last check — using cache`);
  }

  await persistStore(type);

  // Step 5: Return Jatin's items — detailCache only ever contains his own
  // by construction now, so no extra filter pass is needed here.
  return Object.values(store.detailCache);
}

// ── APPROVER CHECK ────────────────────────────────────────────
function isJatinCurrentApprover(detail) {
  if (!detail) return false;
  if (detail.approver_id === JATIN_USER_ID) return true;
  if (Array.isArray(detail.approvers_list)) {
    return detail.approvers_list.some(a =>
      a.email === APPROVER_EMAIL &&
      a.is_next_approver === true &&
      a.has_approved === false
    );
  }
  return false;
}

// ── PUBLIC API ────────────────────────────────────────────────
async function getPendingPOs(forceRefresh) {
  return smartFetch('pos', forceRefresh);
}

async function getPODetail(poId) {
  const data = await zohoGET(`/purchaseorders/${poId}`);
  return data.purchaseorder || null;
}

// Used by bills.js for the bill-vs-linked-PO line comparison. Confirmed
// via real production logs: this used to call getPODetail() directly,
// completely bypassing any cache — meaning every pending bill with a
// linked PO re-fetched that PO's full detail from Zoho on EVERY single
// bills refresh, even when nothing about that PO had changed since the
// last check.
//
// First checks the main POs cache (free reuse when the linked PO also
// happens to be one of Jatin's own pending items). Otherwise falls back
// to a SEPARATE small cache — not the main detailCache, since that must
// only ever contain Jatin's own items (the rest of this file relies on
// that to know who a returned item belongs to without re-checking) — for
// everything else, e.g. an already-approved historical PO that a bill
// happens to reference.
let linkedPOCache = {};
let linkedPOHydratePromise = null;
const linkedPOFetchInFlight = {};

async function ensureLinkedPOCacheHydrated() {
  if (!linkedPOHydratePromise) {
    linkedPOHydratePromise = (async () => {
      try {
        const persisted = await storeGet(KEYS.ZOHO_LINKED_PO_CACHE);
        if (persisted) linkedPOCache = persisted;
      } catch { /* proceed with whatever's in memory */ }
    })();
  }
  return linkedPOHydratePromise;
}

async function getCachedPODetail(poId) {
  await hydrateFromPersistedStore('pos');
  if (STORE.pos.detailCache[poId]) return STORE.pos.detailCache[poId];

  await ensureLinkedPOCacheHydrated();
  // Validate completeness even on a cache hit — a PO cached from a moment
  // where Zoho returned it without line_items (a transient hiccup, not
  // genuinely empty) would otherwise stay stuck broken forever instead of
  // retrying. An empty line_items array is allowed through (a PO can
  // legitimately have none); only a missing/malformed array is rejected.
  const cached = linkedPOCache[poId];
  if (cached && Array.isArray(cached.line_items)) return cached;

  // If another concurrent call (a different bill referencing the same PO)
  // is already fetching this exact poId, share that one instead of also
  // fetching it independently.
  if (!linkedPOFetchInFlight[poId]) {
    linkedPOFetchInFlight[poId] = (async () => {
      const detail = await getPODetail(poId);
      if (detail && Array.isArray(detail.line_items)) {
        linkedPOCache[poId] = detail;
        await storeSet(KEYS.ZOHO_LINKED_PO_CACHE, linkedPOCache).catch(() => {});
      }
      return detail;
    })().finally(() => { delete linkedPOFetchInFlight[poId]; });
  }
  return linkedPOFetchInFlight[poId];
}

async function searchPOs(query) {
  const data = await zohoGET('/purchaseorders', {
    search_text: query,
    per_page:    50,
  });
  return data.purchaseorders || [];
}

async function getPendingBills(forceRefresh) {
  return smartFetch('bills', forceRefresh);
}

async function getBillDetail(billId) {
  const data = await zohoGET(`/bills/${billId}`);
  return data.bill || null;
}

async function searchBills(query) {
  const data = await zohoGET('/bills', {
    search_text: query,
    per_page:    50,
  });
  return data.bills || [];
}

async function getVendorDetail(vendorId) {
  const data = await zohoGET(`/contacts/${vendorId}`);
  return data.contact || null;
}

async function getPendingCounts() {
  const [pos, bills] = await Promise.all([getPendingPOs(), getPendingBills()]);
  return {
    pendingPOs:   pos.length,
    pendingBills: bills.length,
    total:        pos.length + bills.length,
  };
}

// ── DEBUG ─────────────────────────────────────────────────────
async function debugListFields() {
  const data  = await zohoGET('/purchaseorders', {
    status: 'pending_approval', per_page: 3,
  });
  const items = data.purchaseorders || [];
  console.log('Total pending in Zoho:', data.page_context?.total);
  console.log('List-level keys:', Object.keys(items[0] || {}).join(', '));
  items.forEach(p => {
    console.log(`PO: ${p.purchaseorder_number} | approver_id: ${p.approver_id} | isJatin: ${p.approver_id === JATIN_USER_ID}`);
  });
}

// ── CONNECTION TEST ───────────────────────────────────────────
async function testConnection() {
  try {
    const data = await zohoGET('/organizations');
    return { success: true, orgName: data.organizations?.[0]?.name || 'Connected' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── CLEAR CACHE (force full refresh) ─────────────────────────
function clearCache() {
  for (const type of ['pos', 'bills']) {
    STORE[type].detailCache     = {};
    STORE[type].checkedSnapshot = {};
  }
}

module.exports = {
  getPendingPOs, getPODetail, getCachedPODetail, searchPOs,
  getPendingBills, getBillDetail, searchBills,
  getVendorDetail, getPendingCounts,
  debugListFields, testConnection, clearCache,
  APPROVER_EMAIL, JATIN_USER_ID,
};