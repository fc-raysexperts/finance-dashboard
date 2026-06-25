// debug_pfb_head.js
// Run: node debug_pfb_head.js
// Finds the exact custom field api_names for "Project Head" and "PFB Head"
// tags on PO/Bill line items, so the alignment matcher in pfbEngine.js
// can use the correct keys.

require('dotenv').config({ path: '.env.local' });
const axios = require('axios');

let cachedToken = null;
async function getToken() {
  if (cachedToken) return cachedToken;
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    }
  });
  cachedToken = res.data.access_token;
  return cachedToken;
}

async function zohoGET(path, params = {}) {
  const token = await getToken();
  const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params:  { organization_id: process.env.ZOHO_ORG_ID, ...params }
  });
  return res.data;
}

function dumpLineItemFields(items, label) {
  console.log(`\n--- ${label}: ${items.length} line item(s) ---`);
  items.forEach((li, i) => {
    console.log(`  [item ${i}] name="${li.name}"`);
    const allKeys = Object.keys(li);
    console.log(`    all keys:`, allKeys.join(', '));
    // Print anything that looks like a tag/head/project field
    allKeys
      .filter(k => /head|project|tag|scope|pfb/i.test(k))
      .forEach(k => console.log(`    >>> ${k}:`, JSON.stringify(li[k])));
    // Print custom_field_hash / line_item_custom_fields if present
    if (li.line_item_custom_fields) {
      console.log('    line_item_custom_fields:', JSON.stringify(li.line_item_custom_fields, null, 2));
    }
    if (li.custom_field_hash) {
      console.log('    custom_field_hash:', JSON.stringify(li.custom_field_hash, null, 2));
    }
  });
}

async function run() {
  // Get a handful of pending POs and inspect line item fields
  const poList = await zohoGET('/purchaseorders', { status: 'pending_approval', per_page: 5 });
  const pos = poList.purchaseorders || [];
  console.log('Pending POs found:', pos.length);

  for (const p of pos.slice(0, 3)) {
    const det = await zohoGET(`/purchaseorders/${p.purchaseorder_id}`);
    const po = det.purchaseorder;
    dumpLineItemFields(po.line_items || [], `PO ${po.purchaseorder_number}`);
  }

  // Also check bills
  const billList = await zohoGET('/bills', { status: 'pending_approval', per_page: 5 });
  const bills = billList.bills || [];
  console.log('\nPending Bills found:', bills.length);

  for (const b of bills.slice(0, 2)) {
    const det = await zohoGET(`/bills/${b.bill_id}`);
    const bill = det.bill;
    dumpLineItemFields(bill.line_items || [], `Bill ${bill.bill_number}`);
  }
}

run().catch(e => console.error('ERROR:', e.response?.status, e.response?.data || e.message));
