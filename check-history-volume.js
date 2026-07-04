// check-history-volume.js
// Measures: (1) how many POs/Bills exist in a few candidate backfill
// windows, and (2) how many individual items are officially listed in
// Zoho's own Items catalog — both needed to decide a sensible, bounded
// scope for the Reference Rate backfill instead of guessing.
//
// Still cheap: everything here is counted via list pagination only
// (per_page=200, tallying page-by-page) — no PO/Bill document detail and
// no per-item detail is ever fetched.
//
// Run from your project root (so it can read .env.local):
//   node check-history-volume.js

require('dotenv').config({ path: '.env.local' });
if (!process.env.ZOHO_REFRESH_TOKEN) require('dotenv').config();

const axios = require('axios');

async function getToken() {
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });
  return res.data.access_token;
}

async function countByPagination(token, endpoint, listKey, extraParams, onPage) {
  let total = 0;
  let page = 1;
  let callCount = 0;
  while (true) {
    const res = await axios.get(`https://www.zohoapis.in/books/v3${endpoint}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: {
        organization_id: process.env.ZOHO_ORG_ID,
        per_page: 200,
        page,
        ...extraParams,
      },
    });
    callCount++;
    const records = res.data[listKey] || [];
    total += records.length;
    if (onPage) onPage(records);
    if (!res.data.page_context?.has_more_page) break;
    page++;
    await new Promise(r => setTimeout(r, 200));
  }
  return { total, callCount };
}

async function main() {
  let token;
  try {
    token = await getToken();
  } catch (e) {
    console.log('Could not refresh token:', e.response?.data || e.message);
    return;
  }

  console.log('────────────────────────────────────────────');
  console.log('Backfill window sizing — Org', process.env.ZOHO_ORG_ID);
  console.log('(all counts via list pagination only — no document/item detail fetched)');
  console.log('────────────────────────────────────────────');

  try {
    console.log('Counting POs/Bills from 1 Apr 2026 onwards...');
    const poApr   = await countByPagination(token, '/purchaseorders', 'purchaseorders', { date_start: '2026-04-01' });
    const billApr = await countByPagination(token, '/bills', 'bills', { date_start: '2026-04-01' });

    console.log('Counting POs/Bills from 1 Jan 2026 onwards...');
    const poJan   = await countByPagination(token, '/purchaseorders', 'purchaseorders', { date_start: '2026-01-01' });
    const billJan = await countByPagination(token, '/bills', 'bills', { date_start: '2026-01-01' });

    console.log('Counting the Items catalog...');
    let activeCount = 0, inactiveCount = 0;
    const items = await countByPagination(token, '/items', 'items', {}, (records) => {
      records.forEach(r => { if (r.status === 'active') activeCount++; else inactiveCount++; });
    });

    console.log('');
    console.log('=== Candidate backfill windows ===');
    console.log('From 1 Apr 2026 (3 months): POs', poApr.total, '+ Bills', billApr.total, '=', poApr.total + billApr.total, 'documents  (', poApr.callCount + billApr.callCount, 'list calls to measure)');
    console.log('From 1 Jan 2026 (6 months): POs', poJan.total, '+ Bills', billJan.total, '=', poJan.total + billJan.total, 'documents  (', poJan.callCount + billJan.callCount, 'list calls to measure)');
    console.log('');
    console.log('=== Items catalog (Zoho\'s own official item list) ===');
    console.log('Active items:', activeCount, '| Inactive items:', inactiveCount, '| Total:', items.total);
    console.log('');
    console.log('Note: this tells us how many documents would need detail-fetching');
    console.log('for each window — it does NOT yet tell us how many of the', items.total,
      'catalog items would actually be COVERED by that window (that requires really');
    console.log('inspecting each document\'s line items, which is the real backfill');
    console.log('itself). Once you pick a window, running that backfill will report');
    console.log('real coverage against this item count as it goes.');
  } catch (e) {
    console.log('Error counting:', e.response?.data || e.message);
  }
}

main();
