// lib/zoho.js — Smart delta cache version
// Strategy: fetch list always (2 calls), fetch detail ONLY for new/changed items
// Result: ~100-200 API calls per day instead of 17,000

const axios = require('axios');

const JATIN_USER_ID  = '2346113000000742107';
const APPROVER_EMAIL = 'jatin.srivastava@raysexperts.com';

// ── TOKEN MANAGER ─────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry  = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await axios.post(
    'https://accounts.zoho.in/oauth/v2/token', null,
    { params: {
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id:     process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type:    'refresh_token',
    }}
  );
  if (!res.data.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(res.data));
  }
  cachedToken = res.data.access_token;
  tokenExpiry  = Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

// ── BASE CALLER — with 429 retry and backoff ──────────────────
async function zohoGET(path, params = {}) {
  const token = await getAccessToken();
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
// For each record type (pos, bills), we store:
//   detailCache: { [id]: detailObject }       — full detail objects
//   listSnapshot: { [id]: last_modified_time } — last known state
//   lastFetch: timestamp                       — when we last fetched list
//
// On each refresh:
//   1. Fetch the list (1 API call)
//   2. Compare each item's last_modified_time against snapshot
//   3. Fetch detail ONLY for items that are new or have changed
//   4. Remove items from cache that are no longer in the list
//   5. Filter by approver_id in memory (no extra API calls)

const STORE = {
  pos: {
    detailCache:   {},  // id → full PO detail object
    listSnapshot:  {},  // id → last_modified_time
    lastListFetch: 0,
  },
  bills: {
    detailCache:   {},
    listSnapshot:  {},
    lastListFetch: 0,
  },
};

// How often to refresh the list (not details — list is always fresh)
const LIST_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

async function smartFetch(type) {
  const store      = STORE[type];
  const endpoint   = type === 'pos' ? '/purchaseorders' : '/bills';
  const listKey    = type === 'pos' ? 'purchaseorders' : 'bills';
  const idField    = type === 'pos' ? 'purchaseorder_id' : 'bill_id';

  const now = Date.now();

  // Step 1: Fetch the current list (always — cheap, 1 call)
  // Only skip if fetched within last 5 minutes
  let currentListItems = [];
  if (now - store.lastListFetch < LIST_REFRESH_MS && Object.keys(store.listSnapshot).length > 0) {
    // Use cached list snapshot, return cached details
    return Object.values(store.detailCache).filter(isJatinCurrentApprover);
  }

  // Fetch full list of pending_approval records
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
  store.lastListFetch = now;

  // Step 2: Find what's new or changed
  const toFetch    = [];
  const currentIds = new Set();

  for (const item of currentListItems) {
    const id       = item[idField];
    const modified = item.last_modified_time || item.created_time || '';
    currentIds.add(id);

    const cached = store.listSnapshot[id];
    if (!cached || cached !== modified) {
      // New item or modified since last fetch — needs detail call
      toFetch.push(id);
      store.listSnapshot[id] = modified;
    }
    // If cached and not modified — skip, use existing detail cache
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

    // Batch in groups of 10, with small pause between batches
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

  // Step 5: Return only Jatin's items from detail cache
  return Object.values(store.detailCache).filter(isJatinCurrentApprover);
}

// ── APPROVER CHECK ────────────────────────────────────────────
function isJatinCurrentApprover(detail) {
  if (!detail) return false;
  // Primary check: top-level approver_id (present in detail response)
  if (detail.approver_id === JATIN_USER_ID) return true;
  // Fallback: approvers_list array
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
async function getPendingPOs() {
  return smartFetch('pos');
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

async function getPendingBills() {
  return smartFetch('bills');
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