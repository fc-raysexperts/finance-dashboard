// lib/zohoAnalyticsToken.js
// Token manager for the Zoho ANALYTICS API — completely separate from
// lib/zohoToken.js (which manages the Books token used by
// pos.js/bills.js/pmos.js/project-financials.js's current implementation).
// Different product, different OAuth scope, different refresh token
// (ZOHO_ANALYTICS_REFRESH_TOKEN), different persisted cache key. Nothing
// here touches the Books token flow at all.

const axios = require('axios');
const { storeGet, storeSet } = require('./store');

const TOKEN_KEY = 'zoho_analytics_access_token';

let cachedToken = null;
let tokenExpiry = 0;
let refreshPromise = null;

async function refreshToken() {
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_ANALYTICS_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });
  if (!res.data.access_token) {
    throw new Error('Zoho Analytics token refresh failed: ' + JSON.stringify(res.data));
  }
  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  await storeSet(TOKEN_KEY, { token: cachedToken, expiry: tokenExpiry }).catch(() => {});
  return cachedToken;
}

async function getAnalyticsAccessToken(opts = {}) {
  const { skipMemoryCache = false, forceRefresh = false } = opts;

  if (!skipMemoryCache && !forceRefresh && cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  if (!forceRefresh) {
    const checkDelaysMs = skipMemoryCache ? [0, 400, 900] : [0];
    for (const delay of checkDelaysMs) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      try {
        const shared = await storeGet(TOKEN_KEY);
        const isNewer = shared && shared.token && (!skipMemoryCache || shared.token !== cachedToken);
        if (isNewer && Date.now() < shared.expiry) {
          cachedToken = shared.token;
          tokenExpiry = shared.expiry;
          return cachedToken;
        }
      } catch { /* fall through */ }
    }
  }

  if (!refreshPromise) {
    refreshPromise = refreshToken().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

module.exports = { getAnalyticsAccessToken };
