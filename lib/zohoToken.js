// lib/zohoToken.js
// Single shared, persisted Zoho OAuth access-token cache — used by
// lib/zoho.js (POs/Bills), pmos.js, and project-financials.js.
//
// ROOT CAUSE of the repeating 401: those 3 files each kept their own
// separate in-memory token cache. After 15-20 idle minutes they all go
// cold at the same time, and when the dashboard's auto-refresh (or a
// manual refresh) fires POs+Bills+PMOs together, each cache independently
// refreshes the token at the same moment, using the same refresh_token.
// Zoho only keeps the most-recently-issued access token valid — whichever
// refresh lands a moment earlier gets silently invalidated by the next
// one, and every subsequent call with that now-dead token returns 401.
// This is the exact same mechanism as the very first 401, just narrowed
// to 3 caches instead of 4.
//
// Fix: one shared cache, ALSO persisted to the same KV/local-store this
// app already uses (lib/store.js) — so it's still correctly shared even
// if the dev server's bundler doesn't treat these 3 files as one module
// instance the way a plain Node process would. Concurrent callers within
// the same process also share a single in-flight refresh promise, so a
// simultaneous burst only ever triggers one real network refresh.
//
// This file does ONE thing — manage the token — and nothing else. It does
// not touch any of the actual Zoho data-fetching logic in any of the 3
// files that use it.

const axios = require('axios');
const { storeGet, storeSet } = require('./store');

const TOKEN_KEY = 'zoho_access_token';

let cachedToken = null;
let tokenExpiry = 0;
let refreshPromise = null;

async function refreshToken() {
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    },
  });
  if (!res.data.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(res.data));
  }
  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + 55 * 60 * 1000; // Zoho tokens last 60 min; refresh 5 min early
  await storeSet(TOKEN_KEY, { token: cachedToken, expiry: tokenExpiry }).catch(() => {});
  return cachedToken;
}

async function getAccessToken(opts = {}) {
  const { skipMemoryCache = false, forceRefresh = false } = opts;

  if (!skipMemoryCache && !forceRefresh && cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  if (!forceRefresh) {
    // Another file (or another serverless container, on Vercel) may have
    // already refreshed this recently — reuse it instead of refreshing
    // again. When skipMemoryCache is set (we're recovering from a 401), a
    // concurrent refresh elsewhere may simply not have finished writing
    // yet — so this polls the shared store a few times with a short delay
    // rather than checking only once and giving up immediately.
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
      } catch { /* KV/local-store unavailable — fall through */ }
    }
  }

  // Coalesce concurrent refresh attempts into ONE network call, so
  // POs+Bills+PMOs hitting a cold cache at once produce exactly one
  // refresh instead of 3 racing ones (within this module instance).
  if (!refreshPromise) {
    refreshPromise = refreshToken().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

module.exports = { getAccessToken };
