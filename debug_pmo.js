require('dotenv').config({path:'.env.local'});
const axios = require('axios');

async function run() {
  const t = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: { refresh_token:process.env.ZOHO_REFRESH_TOKEN, client_id:process.env.ZOHO_CLIENT_ID, client_secret:process.env.ZOHO_CLIENT_SECRET, grant_type:'refresh_token' }
  });
  const token = t.data.access_token;
  const h = { Authorization: 'Zoho-oauthtoken ' + token };
  const b = { organization_id: process.env.ZOHO_ORG_ID };

  // Get first pending PMO
  const d = await axios.get('https://www.zohoapis.in/books/v3/cm_payment_memos', {
    headers: h, params: { ...b, per_page: 200, page: 1 }
  });
  const first = (d.data.module_records || []).find(r => r.status === 'pending_approval');
  if (!first) { console.log('No pending on page 1'); return; }

  const det = await axios.get('https://www.zohoapis.in/books/v3/cm_payment_memos/' + first.module_record_id, { headers: h, params: b });
  const rec = det.data.module_record || det.data;
  const mf = rec.module_fields || [];

  console.log('PMO:', first.record_name);
  console.log('module_fields type:', typeof mf, Array.isArray(mf) ? 'array len='+mf.length : '');

  // Print ALL keys of first item to find the real field name key
  if (Array.isArray(mf) && mf[0]) {
    console.log('\nFIRST ITEM KEYS:', Object.keys(mf[0]));
    console.log('FIRST ITEM FULL:', JSON.stringify(mf[0], null, 2));
  }

  // Print every item with ALL its keys and values
  console.log('\n=== ALL MODULE_FIELDS ITEMS ===');
  mf.forEach((item, i) => {
    const keys = Object.keys(item);
    // Find which key holds the field identifier
    const nameKey = keys.find(k => typeof item[k] === 'string' && item[k].startsWith('cf_')) || 
                    keys.find(k => k === 'api_name' || k === 'name' || k === 'key' || k === 'placeholder') ||
                    keys[0];
    console.log('['+i+']', nameKey+'='+item[nameKey], '| value='+JSON.stringify(item.value) + ' | keys:', keys.join(','));
  });
}

run().catch(e => console.error('ERROR:', e.response?.status, e.response?.data?.message || e.message));