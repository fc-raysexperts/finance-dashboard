// check-zoho-usage.js
// Tells you how much of today's Zoho API daily quota has been used, right
// now, for this organization. Costs exactly ONE API call to check (reading
// the rate-limit headers Zoho already attaches to every response) — safe
// to run as often as you want.
//
// Run from your project root (so it can read .env.local):
//   node check-zoho-usage.js

require('dotenv').config({ path: '.env.local' });
if (!process.env.ZOHO_REFRESH_TOKEN) require('dotenv').config(); // fallback to .env

const axios = require('axios');

function fmtTime(date) {
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
}

async function main() {
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
  } catch (e) {
    console.log('Could not refresh token:', e.response?.data || e.message);
    return;
  }

  // Smallest possible real call — just to read the headers attached to it.
  // NOTE: /organizations does NOT return rate-limit headers (confirmed by
  // testing) — /purchaseorders does, so that's what we use, with per_page=1
  // to keep the response itself tiny.
  let headers, failed = false;
  try {
    const res = await axios.get('https://www.zohoapis.in/books/v3/purchaseorders', {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID, per_page: 1 },
    });
    headers = res.headers;
  } catch (e) {
    headers = e.response?.headers || {};
    failed = true;
  }

  const limit     = parseInt(headers['x-rate-limit-limit'], 10);
  const remaining = parseInt(headers['x-rate-limit-remaining'], 10);
  const resetSecs = parseInt(headers['x-rate-limit-reset'], 10);

  if (isNaN(limit) || isNaN(remaining)) {
    console.log('Zoho did not return rate-limit headers on this call. Raw headers:', headers);
    return;
  }

  const used    = limit - remaining;
  const pctUsed = ((used / limit) * 100).toFixed(1);
  const resetAt = new Date(Date.now() + resetSecs * 1000);

  console.log('────────────────────────────────────────────');
  console.log(`Zoho Books daily API usage — Org ${process.env.ZOHO_ORG_ID}`);
  console.log('────────────────────────────────────────────');
  console.log(`  Used today:     ${used} / ${limit}  (${pctUsed}%)`);
  console.log(`  Remaining:      ${remaining}`);
  console.log(`  Resets at:      ${fmtTime(resetAt)} IST`);
  if (failed) console.log('  (This check itself hit the limit — remaining is 0 right now.)');
  if (!failed && pctUsed >= 80) console.log('  ⚠  Over 80% used — other dashboards may start failing soon.');
  console.log('────────────────────────────────────────────');
}

main();
