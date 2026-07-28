// lib/zoho.js — Smart delta cache version, now multi-organization aware
// Strategy: fetch list always (2 calls), fetch detail ONLY for new/changed items
// Result: ~100-200 API calls per day instead of 17,000, PER ORGANIZATION
//
// MULTI-ORG SUPPORT ADDED: every exported function now accepts an
// optional trailing `orgKey` parameter ('rays' | 'energy' | 'om' | 'tech').
// Deliberately defaults to 'rays' everywhere, so every EXISTING call site
// that doesn't pass anything keeps working exactly as before, with zero
// behavior change for the current org. Real design decision (confirmed
// with the user): Rays' existing cache keys and in-memory state are
// NEVER renamed or restructured — they stay exactly as they were. Only
// the 3 new subsidiaries get their own separate, freshly-namespaced
// in-memory state and KV cache keys, isolated from each other and from
// Rays, via lib/store.js's orgScopedKey() helper.
//
// PERSISTENCE: the delta-cache below (detailCache/checkedSnapshot) is
// persisted to KV so it survives Vercel's serverless cold starts/redeploys.
//
// MANUAL-REFRESH-ONLY: getPendingPOs()/getPendingBills() take an optional
// forceRefresh flag. When false (a normal page load), this serves
// directly from the persisted cache — no Zoho call at all — unless no
// cache exists yet. A real fetch only happens when forceRefresh is true.

const axios = require('axios');
const { storeGet, storeSet, KEYS, orgScopedKey } = require('./store');
const { getOrgId } = require('./subsidiaries');

const JATIN_USER_ID  = '2346113000000742107';
const APPROVER_EMAIL = 'jatin.srivastava@raysexperts.com';

// ── TOKEN MANAGER ─────────────────────────────────────────────
const { getAccessToken } = require('./zohoToken');

// ── BASE CALLER — with 401 and 429 retry ───────────────────────
// orgKey defaults to 'rays' — resolves to the real numeric Zoho
// organization_id via lib/subsidiaries.js's getOrgId(), which itself
// falls back to the existing ZOHO_ORG_ID env var for 'rays', so this is
// a no-op change for every existing call site.
async function zohoGET(path, params = {}, orgKey = 'rays') {
  let token = await getAccessToken();
  const organizationId = getOrgId(orgKey);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(
        `https://www.zohoapis.in/books/v3${path}`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          params:  { organization_id: organizationId, ...params },
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

// ── SMART DELTA CACHE — now keyed per-organization ─────────────
// STORE['rays'].pos / STORE['energy'].bills / etc. Each org gets its
// own completely independent slot, created on first use.
const STORE = {};
function getStoreSlot(orgKey) {
  if (!STORE[orgKey]) {
    STORE[orgKey] = {
      pos:   { detailCache: {}, checkedSnapshot: {}, hydrated: false },
      bills: { detailCache: {}, checkedSnapshot: {}, hydrated: false },
    };
  }
  return STORE[orgKey];
}

function storeKeyFor(type, orgKey) {
  const base = type === 'pos' ? KEYS.ZOHO_DELTA_POS : KEYS.ZOHO_DELTA_BILLS;
  return orgScopedKey(base, orgKey);
}

const hydratePromises = {}; // keyed by `${orgKey}_${type}`

// Concurrent callers (e.g. bills.js checking many linked POs via
// Promise.all) must all wait for the SAME hydration to actually finish —
// a simple "already tried?" boolean flag isn't enough, since several
// concurrent calls can all see "not yet" before the very first one has
// actually finished loading the cache, and proceed as if it's empty even
// though it genuinely isn't.
async function hydrateFromPersistedStore(type, orgKey = 'rays') {
  const store = getStoreSlot(orgKey)[type];
  if (store.hydrated) return;

  const promiseKey = `${orgKey}_${type}`;
  if (!hydratePromises[promiseKey]) {
    hydratePromises[promiseKey] = (async () => {
      try {
        const persisted = await storeGet(storeKeyFor(type, orgKey));
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
  return hydratePromises[promiseKey];
}

async function persistStore(type, orgKey = 'rays') {
  const store = getStoreSlot(orgKey)[type];
  await storeSet(storeKeyFor(type, orgKey), {
    detailCache:     store.detailCache,     // ONLY Jatin's items' full detail
    checkedSnapshot: store.checkedSnapshot, // EVERY item's {modified, isJatin} — tiny
  }).catch(() => {});
}

async function smartFetch(type, forceRefresh, orgKey = 'rays') {
  const store      = getStoreSlot(orgKey)[type];
  const endpoint   = type === 'pos' ? '/purchaseorders' : '/bills';
  const listKey    = type === 'pos' ? 'purchaseorders' : 'bills';
  const idField    = type === 'pos' ? 'purchaseorder_id' : 'bill_id';

  await hydrateFromPersistedStore(type, orgKey);

  // Normal page load (not an explicit refresh): serve straight from
  // whatever's cached, with NO Zoho call at all — unless there's no
  // cache yet (very first call ever for this data, for this org).
  if (!forceRefresh && Object.keys(store.checkedSnapshot).length > 0) {
    return Object.values(store.detailCache);
  }

  // Fetch full list of pending_approval records — Zoho's status filter is
  // company-wide ("pending SOMEONE's approval"), not "pending Jatin's
  // approval" specifically, so this naturally includes everyone else's
  // pending items too. Every item's approver status can only be known
  // via its detail.
  let currentListItems = [];
  let page = 1;
  while (true) {
    const data  = await zohoGET(endpoint, {
      status:   'pending_approval',
      per_page: 200,
      page,
    }, orgKey);
    currentListItems = currentListItems.concat(data[listKey] || []);
    if (!data.page_context?.has_more_page) break;
    page++;
    await sleep(200);
  }

  // Step 2: Find what's new or changed SINCE WE LAST CHECKED IT.
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

  // Step 4: Detail-fetch only items that are new or genuinely changed.
  if (toFetch.length > 0) {
    console.log(`[${orgKey}] ${type}: ${currentListItems.length} pending company-wide, ${toFetch.length} new/changed since last check`);

    for (let i = 0; i < toFetch.length; i += 10) {
      const batch = toFetch.slice(i, i + 10);
      const details = await Promise.all(
        batch.map(id =>
          type === 'pos' ? getPODetail(id, orgKey) : getBillDetail(id, orgKey)
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
    console.log(`[${orgKey}] ${type}: ${currentListItems.length} pending company-wide, 0 changed since last check — using cache`);
  }

  await persistStore(type, orgKey);

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

// ── PUBLIC API — every function now takes an optional trailing orgKey ──
async function getPendingPOs(forceRefresh, orgKey = 'rays') {
  return smartFetch('pos', forceRefresh, orgKey);
}

async function getPODetail(poId, orgKey = 'rays') {
  const data = await zohoGET(`/purchaseorders/${poId}`, {}, orgKey);
  return data.purchaseorder || null;
}

// Used by bills.js for the bill-vs-linked-PO line comparison. First
// checks the main POs cache (free reuse when the linked PO also happens
// to be one of Jatin's own pending items). Otherwise falls back to a
// SEPARATE small cache — not the main detailCache, since that must only
// ever contain Jatin's own items — for everything else, e.g. an
// already-approved historical PO that a bill happens to reference. Now
// keyed per-organization the same way as everything else in this file.
const linkedPOCache = {};          // orgKey -> { poId -> detail }
const linkedPOHydratePromise = {}; // orgKey -> promise
const linkedPOFetchInFlight = {};  // orgKey -> { poId -> promise }

function linkedPOCacheKey(orgKey) {
  return orgScopedKey(KEYS.ZOHO_LINKED_PO_CACHE, orgKey);
}

async function ensureLinkedPOCacheHydrated(orgKey = 'rays') {
  if (!linkedPOCache[orgKey]) linkedPOCache[orgKey] = {};
  if (!linkedPOHydratePromise[orgKey]) {
    linkedPOHydratePromise[orgKey] = (async () => {
      try {
        const persisted = await storeGet(linkedPOCacheKey(orgKey));
        if (persisted) linkedPOCache[orgKey] = persisted;
      } catch { /* proceed with whatever's in memory */ }
    })();
  }
  return linkedPOHydratePromise[orgKey];
}

async function getCachedPODetail(poId, orgKey = 'rays') {
  await hydrateFromPersistedStore('pos', orgKey);
  const slot = getStoreSlot(orgKey);
  if (slot.pos.detailCache[poId]) return slot.pos.detailCache[poId];

  await ensureLinkedPOCacheHydrated(orgKey);
  if (!linkedPOFetchInFlight[orgKey]) linkedPOFetchInFlight[orgKey] = {};
  // Validate completeness even on a cache hit — a PO cached from a moment
  // where Zoho returned it without line_items (a transient hiccup, not
  // genuinely empty) would otherwise stay stuck broken forever instead of
  // retrying. An empty line_items array is allowed through (a PO can
  // legitimately have none); only a missing/malformed array is rejected.
  const cached = linkedPOCache[orgKey][poId];
  if (cached && Array.isArray(cached.line_items)) return cached;

  // If another concurrent call (a different bill referencing the same PO)
  // is already fetching this exact poId, share that one instead of also
  // fetching it independently.
  if (!linkedPOFetchInFlight[orgKey][poId]) {
    linkedPOFetchInFlight[orgKey][poId] = (async () => {
      const detail = await getPODetail(poId, orgKey);
      if (detail && Array.isArray(detail.line_items)) {
        linkedPOCache[orgKey][poId] = detail;
        await storeSet(linkedPOCacheKey(orgKey), linkedPOCache[orgKey]).catch(() => {});
      }
      return detail;
    })().finally(() => { delete linkedPOFetchInFlight[orgKey][poId]; });
  }
  return linkedPOFetchInFlight[orgKey][poId];
}

async function searchPOs(query, orgKey = 'rays') {
  const data = await zohoGET('/purchaseorders', {
    search_text: query,
    per_page:    50,
  }, orgKey);
  return data.purchaseorders || [];
}

async function getPendingBills(forceRefresh, orgKey = 'rays') {
  return smartFetch('bills', forceRefresh, orgKey);
}

async function getBillDetail(billId, orgKey = 'rays') {
  const data = await zohoGET(`/bills/${billId}`, {}, orgKey);
  return data.bill || null;
}

async function searchBills(query, orgKey = 'rays') {
  const data = await zohoGET('/bills', {
    search_text: query,
    per_page:    50,
  }, orgKey);
  return data.bills || [];
}

async function getVendorDetail(vendorId, orgKey = 'rays') {
  const data = await zohoGET(`/contacts/${vendorId}`, {}, orgKey);
  return data.contact || null;
}

async function getPendingCounts(orgKey = 'rays') {
  const [pos, bills] = await Promise.all([getPendingPOs(undefined, orgKey), getPendingBills(undefined, orgKey)]);
  return {
    pendingPOs:   pos.length,
    pendingBills: bills.length,
    total:        pos.length + bills.length,
  };
}

// ── DEBUG ─────────────────────────────────────────────────────
async function debugListFields(orgKey = 'rays') {
  const data  = await zohoGET('/purchaseorders', {
    status: 'pending_approval', per_page: 3,
  }, orgKey);
  const items = data.purchaseorders || [];
  console.log('Total pending in Zoho:', data.page_context?.total);
  console.log('List-level keys:', Object.keys(items[0] || {}).join(', '));
  items.forEach(p => {
    console.log(`PO: ${p.purchaseorder_number} | approver_id: ${p.approver_id} | isJatin: ${p.approver_id === JATIN_USER_ID}`);
  });
}

// ── CONNECTION TEST ───────────────────────────────────────────
async function testConnection(orgKey = 'rays') {
  try {
    const data = await zohoGET('/organizations', {}, orgKey);
    return { success: true, orgName: data.organizations?.[0]?.name || 'Connected' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── CLEAR CACHE (force full refresh) ─────────────────────────
function clearCache(orgKey = 'rays') {
  const slot = getStoreSlot(orgKey);
  slot.pos.detailCache     = {};
  slot.pos.checkedSnapshot = {};
  slot.bills.detailCache     = {};
  slot.bills.checkedSnapshot = {};
}

module.exports = {
  getPendingPOs, getPODetail, getCachedPODetail, searchPOs,
  getPendingBills, getBillDetail, searchBills,
  getVendorDetail, getPendingCounts,
  debugListFields, testConnection, clearCache,
  APPROVER_EMAIL, JATIN_USER_ID,
};
