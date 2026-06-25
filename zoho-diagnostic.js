// zoho-diagnostic.js
// Standalone test — completely independent of pos.js/bills.js/pmos.js/
// zoho.js. Does exactly ONE token refresh and ONE single GET call, with
// no retries, no caching, no Promise.all. If THIS fails with 429, it
// proves the problem is on Zoho's side for this org/credential right now
// — not anywhere in the dashboard's code. If it succeeds, the problem is
// still something about how the app calls Zoho, and we keep digging there.
//
// Run from your project root (so it can read .env.local):
//   node zoho-diagnostic.js

require('dotenv').config({ path: '.env.local' });
if (!process.env.ZOHO_REFRESH_TOKEN) require('dotenv').config(); // fallback to .env

const axios = require('axios');

async function main() {
  console.log('--- Step 1: refreshing access token ---');
  let token;
  try {
    const tokenRes = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
      params: {
        refresh_token: process.env.ZOHO_REFRESH_TOKEN,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: 'refresh_token',
      },
    });
    token = tokenRes.data.access_token;
    console.log('Token refresh: SUCCESS');
    console.log('Response body:', JSON.stringify(tokenRes.data, null, 2));
  } catch (e) {
    console.log('Token refresh: FAILED');
    console.log('Status:', e.response?.status);
    console.log('Response body:', JSON.stringify(e.response?.data, null, 2));
    console.log('Response headers:', JSON.stringify(e.response?.headers, null, 2));
    return;
  }

  console.log('\n--- Step 2: one single GET to /purchaseorders ---');
  try {
    const res = await axios.get('https://www.zohoapis.in/books/v3/purchaseorders', {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID, per_page: 5 },
    });
    console.log('API call: SUCCESS');
    console.log('Status:', res.status);
    console.log('Total POs reported by Zoho:', res.data.page_context?.total);
    console.log('Response headers:', JSON.stringify(res.headers, null, 2));
  } catch (e) {
    console.log('API call: FAILED');
    console.log('Status:', e.response?.status);
    console.log('Response body:', JSON.stringify(e.response?.data, null, 2));
    console.log('Response headers (look for Retry-After / X-RateLimit-*):', JSON.stringify(e.response?.headers, null, 2));
  }
}

main();
