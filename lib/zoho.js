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
    detailCache:   {},
    listSnapshot:  {},
    lastListFetch: 0,
    hydrated:      false, // have we tried loading from KV yet, this process lifetime?
  },
  bills: {
    detailCache:   {},
    listSnapshot:  {},
    lastListFetch: 0,
    hydrated:      false,
  },
};

const STORE_KEY = { pos: KEYS.ZOHO_DELTA_POS, bills: KEYS.ZOHO_DELTA_BILLS };

async function hydrateFromPersistedStore(type) {
  const store = STORE[type];
  if (store.hydrated) return; // already tried this process lifetime — in-memory is authoritative from here
  store.hydrated = true;
  try {
    const persisted = await storeGet(STORE_KEY[type]);
    if (persisted && Object.keys(persisted.listSnapshot || {}).length > 0) {
      store.detailCache   = persisted.detailCache   || {};
      store.listSnapshot  = persisted.listSnapshot  || {};
      store.lastListFetch = persisted.lastListFetch || 0;
    }
  } catch { /* KV unavailable — proceed with whatever's in memory (likely empty) */ }
}

async function persistStore(type) {
  const store = STORE[type];
  await storeSet(STORE_KEY[type], {
    detailCache:   store.detailCache,
    listSnapshot:  store.listSnapshot,
    lastListFetch: store.lastListFetch,
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
  if (!forceRefresh && Object.keys(store.listSnapshot).length > 0) {
    return Object.values(store.detailCache).filter(isJatinCurrentApprover);
  }

  // Fetch full list of pending_approval records
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
  store.lastListFetch = Date.now();

  // Step 2: Find what's new or changed
  const toFetch    = [];
  const currentIds = new Set();

  for (const item of currentListItems) {
    const id       = item[idField];
    const modified = item.last_modified_time || item.created_time || '';
    currentIds.add(id);

    const cached = store.listSnapshot[id];
    if (!cached || cached !== modified) {
      toFetch.push(id);
      store.listSnapshot[id] = modified;
    }
  }

  // Step 3: Remove items no longer in the list (approved/rejected)
  for (const id of Object.keys(store.detailCache)) {
    if (!currentIds.has(id)) {
      delete store.detailCache[id];
      delete store.listSnapshot[id];
    }
  }

  // Step 4: Fetch detail only for new/changed items
  if (toFetch.length > 0) {
    console.log(`${type}: ${currentListItems.length} pending total, fetching ${toFetch.length} new/changed details`);

    for (let i = 0; i < toFetch.length; i += 10) {
      const batch = toFetch.slice(i, i + 10);
      const details = await Promise.all(
        batch.map(id =>
          type === 'pos' ? getPODetail(id) : getBillDetail(id)
        )
      );
      for (const detail of details) {
        if (detail) {
          const id = detail[idField];
          store.detailCache[id] = detail;
        }
      }
      if (i + 10 < toFetch.length) await sleep(500);
    }
  } else {
    console.log(`${type}: ${currentListItems.length} pending, 0 changed — using cache`);
  }

  await persistStore(type);

  // Step 5: Return only Jatin's items from detail cache
  return Object.values(store.detailCache).filter(isJatinCurrentApprover);
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
    STORE[type].detailCache   = {};
    STORE[type].listSnapshot  = {};
    STORE[type].lastListFetch = 0;
  }
}

module.exports = {
  getPendingPOs, getPODetail, searchPOs,
  getPendingBills, getBillDetail, searchBills,
  getVendorDetail, getPendingCounts,
  debugListFields, testConnection, clearCache,
  APPROVER_EMAIL, JATIN_USER_ID,
};