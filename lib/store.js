// lib/store.js
// Persistent cross-device store for: user-added projects, user-added parks,
// per-project Zoho Name overrides, per-project DC/AC/SW/Piling/Wall/Road overrides,
// and per-project rate overrides (from PFB Excel uploads).
//
// Uses Vercel KV in production (set up via Vercel dashboard → Storage → KV).
// Falls back to a local JSON file (.local-store.json) when KV env vars are
// absent, so `npm run dev` works before you've connected KV — this lets you
// test everything locally first, exactly as you asked.

const fs = require('fs');
const path = require('path');

const LOCAL_FILE = path.join(process.cwd(), '.local-store.json');
const KV_AVAILABLE = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

let kvClient = null;
function getKV() {
  if (!KV_AVAILABLE) return null;
  if (kvClient) return kvClient;
  // Lazy require so this never breaks local dev when @vercel/kv isn't needed
  const { kv } = require('@vercel/kv');
  kvClient = kv;
  return kvClient;
}

// ── LOCAL FILE FALLBACK ────────────────────────────────────────
function readLocalFile() {
  try {
    if (!fs.existsSync(LOCAL_FILE)) return {};
    return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeLocalFile(data) {
  try {
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Local store write failed:', e.message);
  }
}

// ── PUBLIC API — same shape regardless of backend ──────────────
async function storeGet(key) {
  const kv = getKV();
  if (kv) {
    const val = await kv.get(key);
    return val ?? null;
  }
  const data = readLocalFile();
  return data[key] ?? null;
}

async function storeSet(key, value) {
  const kv = getKV();
  if (kv) {
    await kv.set(key, value);
    return true;
  }
  const data = readLocalFile();
  data[key] = value;
  writeLocalFile(data);
  return true;
}

async function storeDelete(key) {
  const kv = getKV();
  if (kv) {
    await kv.del(key);
    return true;
  }
  const data = readLocalFile();
  delete data[key];
  writeLocalFile(data);
  return true;
}

// ── KEY NAMES (single source of truth) ──────────────────────────
const KEYS = {
  USER_PROJECTS:    'user_added_projects',     // array of project objects
  USER_PARKS:       'user_added_parks',        // array of park objects
  ZOHO_NAME_OVR:    'zoho_name_overrides',     // { [projectId]: string[] }
  VARIABLE_OVR:     'variable_overrides',      // { [projectId]: {dc,ac,sw,piling,wall,road, appliedAt} }
  RATE_HISTORY:     'rate_history',            // array of {appliedAt, rates:{scopeNo:rate}, newItems:[...]}
  PROJECT_OVR:       'project_field_overrides',// { [projectId]: {name,bess,totalValue,epcCost,agreementDate,endDate,park} }
  ZOHO_DELTA_POS:    'zoho_delta_cache_pos',   // persisted version of lib/zoho.js's in-memory POs delta-cache
  ZOHO_DELTA_BILLS:  'zoho_delta_cache_bills', // persisted version of lib/zoho.js's in-memory Bills delta-cache
  ZOHO_DELTA_PMOS:   'zoho_delta_cache_pmos',  // persisted version of pmos.js's in-memory delta-cache
  ZOHO_LINKED_PO_CACHE: 'zoho_linked_po_cache',// PO details looked up for bill-linking that aren't Jatin's own pending items
  REFERENCE_RATE_CATALOG: 'reference_rate_catalog',             // { [item_id]: { name } } - Zoho's own active Items catalog, snapshotted once
  REFERENCE_RATE_HISTORY: 'reference_rate_history',             // { [groupKey]: { name, catalogMatched, occurrences: [...] } }
  REFERENCE_RATE_BACKFILL_CURSOR: 'reference_rate_backfill_cursor', // { stage, page, offsetInPage, processedDocs } - resume point for the one-time backfill
};

module.exports = { storeGet, storeSet, storeDelete, KEYS, KV_AVAILABLE };
