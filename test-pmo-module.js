// test-pmo-module.js
//
// ONE-TIME diagnostic — checks whether the "Payment Memos" CUSTOM MODULE
// (not custom field — these are two different Zoho Books features)
// actually exists for each of the 4 organizations, and if so, reveals
// its real API name (which might differ from Rays' "cm_payment_memos").
//
// HOW TO RUN:
//   node test-pmo-module.js
//
// Delete this file afterward — it's a throwaway diagnostic.

require('dotenv').config({ path: '.env.local' });
const axios = require('axios');
const { getAccessToken } = require('./lib/zohoToken');

const ORGS = {
  rays:   { name: 'Rays Power Experts Ltd. (known-working)', orgId: process.env.ZOHO_ORG_ID },
  energy: { name: 'RPE Energy Reserve Private Limited',      orgId: process.env.ZOHO_ORG_ID_ENERGY },
  om:     { name: 'Rays O&M Experts Private Limited',        orgId: process.env.ZOHO_ORG_ID_OM },
  tech:   { name: 'RPE Technologies Private Limited',        orgId: process.env.ZOHO_ORG_ID_TECH },
};

async function test() {
  const token = await getAccessToken();

  for (const [key, org] of Object.entries(ORGS)) {
    console.log(`\n--- ${key}: ${org.name} (org ${org.orgId}) ---`);
    if (!org.orgId) {
      console.log('  SKIPPED — env var not set for this org yet.');
      continue;
    }
    try {
      const res = await axios.get('https://www.zohoapis.in/books/v3/settings/modules', {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: org.orgId },
      });
      const modules = res.data.custom_modules || res.data.modules || [];
      if (modules.length === 0) {
        console.log('  No custom modules found for this organization at all.');
      } else {
        console.log(`  Found ${modules.length} custom module(s):`);
        modules.forEach(m => {
          console.log(`    - api_name: "${m.api_name}"  |  label: "${m.plural_label || m.module_name || m.name}"`);
        });
        const pmoLike = modules.find(m => /payment|memo|pmo/i.test(m.plural_label || m.module_name || m.name || ''));
        if (pmoLike) {
          console.log(`  >>> Likely PMO match: real api_name is "${pmoLike.api_name}" <<<`);
        } else {
          console.log('  >>> No module here looks like "Payment Memos" by name. <<<');
        }
      }
    } catch (e) {
      const status = e.response?.status;
      console.log(`  ERROR ${status || ''}: ${e.message}`);
      if (status === 403) {
        console.log('  A 403 here likely means Custom Modules aren\'t available on this organization\'s Zoho Books plan at all.');
      }
    }
  }
}

test().catch(e => console.error('Fatal error:', e.message));
