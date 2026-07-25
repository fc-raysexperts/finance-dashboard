// test-organizations.js
//
// ONE-TIME diagnostic script — confirms whether your EXISTING refresh
// token (already set up in .env.local) can access the 3 new subsidiary
// organizations, or whether any of them need their own separate OAuth
// setup. Reuses your app's own token logic — no new credentials needed
// to run this.
//
// HOW TO RUN:
//   1. Open a terminal in your project folder (same place you run `npm run dev`)
//   2. Run: node test-organizations.js
//   3. Read the printed list — see what it tells you below.
//
// Delete this file afterward — it's just a throwaway diagnostic, not
// part of the actual dashboard.

const axios = require('axios');
const { getAccessToken } = require('./lib/zohoToken');

// The 4 real organizations in question:
const EXPECTED_ORGS = {
  '60038956413': 'Rays Power Experts Ltd. (current, already working)',
  '60045349059': 'RPE Energy Reserve Private Limited (BESS)',
  '60040067911': 'Rays O&M Experts Private Limited',
  '60052617054': 'RPE Technologies Private Limited',
};

async function test() {
  console.log('Fetching the list of ALL organizations your Zoho login has access to...\n');
  const token = await getAccessToken();
  const res = await axios.get('https://www.zohoapis.in/books/v3/organizations', {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  const foundOrgs = res.data.organizations || [];
  console.log(`Found ${foundOrgs.length} organization(s) total:\n`);
  foundOrgs.forEach(org => {
    console.log(`  - ${org.organization_id}  |  ${org.name}`);
  });

  console.log('\n--- Checking against the 4 expected organizations ---\n');
  let allFound = true;
  for (const [orgId, label] of Object.entries(EXPECTED_ORGS)) {
    const found = foundOrgs.some(o => String(o.organization_id) === orgId);
    console.log(`${found ? '✅ FOUND' : '❌ NOT FOUND'}  —  ${orgId}  (${label})`);
    if (!found) allFound = false;
  }

  console.log('\n--- Result ---');
  if (allFound) {
    console.log('All 4 organizations are visible to your existing refresh token.');
    console.log('This confirms you do NOT need any new OAuth client/refresh token —');
    console.log('just add the 3 new organization IDs as environment variables.');
  } else {
    console.log('One or more of the new organizations did NOT show up above.');
    console.log('That specific organization is likely on a separate Zoho login/account,');
    console.log('and will need its own separate OAuth client + refresh token set up');
    console.log('via the Zoho Developer Console (api-console.zoho.com), the same way');
    console.log('the original one for Rays Power Experts was set up.');
  }
}

test().catch(err => {
  console.error('Error running test:', err.response?.data || err.message);
});
