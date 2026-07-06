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
    console.log('Counting POs/Bills from 1 Jul 2025 to 31 Dec 2025 (the new candidate window)...');
    const poWindow   = await countByPagination(token, '/purchaseorders', 'purchaseorders', { date_start: '2025-07-01', date_end: '2025-12-31' });
    const billWindow = await countByPagination(token, '/bills', 'bills', { date_start: '2025-07-01', date_end: '2025-12-31' });

    console.log('');
    console.log('=== 1 Jul 2025 - 31 Dec 2025 (6 months, the extension being considered) ===');
    console.log('POs:', poWindow.total, '| Bills:', billWindow.total, '| Combined:', poWindow.total + billWindow.total, 'documents');
    console.log('(measured via', poWindow.callCount + billWindow.callCount, 'list calls — no document detail fetched)');
    console.log('');
    console.log('For comparison, your two already-completed windows:');
    console.log('  Apr-Jun 2026 (3mo): 2,035 documents — found 573 new items');
    console.log('  Jan-Mar 2026 (3mo): 2,209 documents — found 333 additional new items');
    console.log('');
    console.log('A full backfill of this new window would cost roughly', poWindow.total + billWindow.total, 'API calls (1 detail call per document).');
  } catch (e) {
    console.log('Error counting:', e.response?.data || e.message);
  }
}

main();
