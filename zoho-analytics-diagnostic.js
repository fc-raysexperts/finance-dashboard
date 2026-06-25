// zoho-analytics-diagnostic.js
// Verifies the new Zoho Analytics credential works, discovers your
// Organization ID automatically (so you don't have to hunt for it), and
// prints the actual column names + first few rows of the "Project Wise
// Detail" view — so the real integration gets written against the real
// data shape instead of a guess.
//
// Run from your project root (so it can read .env.local):
//   node zoho-analytics-diagnostic.js

require('dotenv').config({ path: '.env.local' });
if (!process.env.ZOHO_ANALYTICS_REFRESH_TOKEN) require('dotenv').config(); // fallback to .env

const axios = require('axios');

const WORKSPACE_ID = '425861000000008002';
const VIEW_ID = '425861000001851800';

async function main() {
  if (!process.env.ZOHO_ANALYTICS_REFRESH_TOKEN) {
    console.log('ZOHO_ANALYTICS_REFRESH_TOKEN not found in .env.local — check it was added correctly.');
    return;
  }

  console.log('--- Step 1: refreshing Zoho Analytics access token ---');
  let token;
  try {
    const tokenRes = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
      params: {
        refresh_token: process.env.ZOHO_ANALYTICS_REFRESH_TOKEN,
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        grant_type: 'refresh_token',
      },
    });
    token = tokenRes.data.access_token;
    if (!token) {
      console.log('No access_token in response:', JSON.stringify(tokenRes.data, null, 2));
      return;
    }
    console.log('Token refresh: SUCCESS');
    console.log('Scope granted:', tokenRes.data.scope);
  } catch (e) {
    console.log('Token refresh: FAILED');
    console.log('Status:', e.response?.status);
    console.log('Response body:', JSON.stringify(e.response?.data, null, 2));
    return;
  }

  console.log('\n--- Step 2: discovering your Zoho Analytics Organization ID(s) ---');
  let orgsToTry = [];
  try {
    const orgsRes = await axios.get('https://analyticsapi.zoho.in/restapi/v2/orgs', {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    const orgs = orgsRes.data?.data?.orgs || [];
    console.log('Organizations found:', orgs.length);
    orgs.forEach(o => console.log(`  - ${o.orgName || o.orgDisplayName} (orgId: ${o.orgId})`));
    if (orgs.length === 0) {
      console.log('No organizations returned. Full response:', JSON.stringify(orgsRes.data, null, 2));
      return;
    }
    orgsToTry = orgs.map(o => ({ orgId: o.orgId, orgName: o.orgName || o.orgDisplayName }));
  } catch (e) {
    console.log('Get Organizations: FAILED');
    console.log('Status:', e.response?.status);
    console.log('Response body:', JSON.stringify(e.response?.data, null, 2));
    return;
  }

  console.log('\n--- Step 3: listing all views in this workspace ---');
  console.log('(the URL you gave me likely points at the Dashboard container itself —');
  console.log(' the actual "Project Wise Detail" data table is probably a separate view inside it)');

  let succeeded = false;
  for (const org of orgsToTry) {
    console.log(`\nTrying org "${org.orgName}" (${org.orgId})...`);

    let views = [];
    try {
      const viewsRes = await axios.get(
        `https://analyticsapi.zoho.in/restapi/v2/workspaces/${WORKSPACE_ID}/views`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'ZANALYTICS-ORGID': org.orgId } }
      );
      views = viewsRes.data?.data?.views || [];
      console.log(`  Found ${views.length} views in this workspace:`);
      views.forEach(v => console.log(`    - "${v.viewName}" (id: ${v.viewId}, type: ${v.viewType})`));
    } catch (e) {
      console.log('  Could not list views with this org. Status:', e.response?.status, '| Body:', JSON.stringify(e.response?.data));
      continue;
    }

    // Find the view whose name actually matches "Project Wise Detail",
    // preferring one that isn't a Dashboard (those only export as PDF/HTML)
    const candidates = views.filter(v => (v.viewName || '').toLowerCase().includes('project wise'));
    const target = candidates.find(v => v.viewType !== 'Dashboard') || candidates[0];

    if (!target) {
      console.log('  No view with "project wise" in the name found in this org\'s workspace listing.');
      continue;
    }
    console.log(`  Using view "${target.viewName}" (id: ${target.viewId}, type: ${target.viewType})`);

    console.log('\n--- Step 4: exporting that view\'s data (async) ---');
    try {
      const createRes = await axios.get(
        `https://analyticsapi.zoho.in/restapi/v2/bulk/workspaces/${WORKSPACE_ID}/views/${target.viewId}/data`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${token}`, 'ZANALYTICS-ORGID': org.orgId },
          params: { CONFIG: JSON.stringify({ responseFormat: 'json' }) },
        }
      );
      const jobId = createRes.data?.data?.jobId;
      if (!jobId) {
        console.log('  No jobId in create-export response:', JSON.stringify(createRes.data));
        continue;
      }
      console.log('  Export job created, jobId:', jobId);

      let jobStatus = null, downloadUrl = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        const statusRes = await axios.get(
          `https://analyticsapi.zoho.in/restapi/v2/bulk/workspaces/${WORKSPACE_ID}/exportjobs/${jobId}`,
          { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'ZANALYTICS-ORGID': org.orgId } }
        );
        jobStatus = statusRes.data?.data?.jobStatus;
        console.log(`  Poll ${attempt + 1}: ${jobStatus}`);
        if (jobStatus === 'JOB COMPLETED') { downloadUrl = statusRes.data?.data?.downloadUrl; break; }
        if (jobStatus && jobStatus.includes('FAIL')) break;
      }
      if (jobStatus !== 'JOB COMPLETED') {
        console.log('  Job did not complete in time, last status:', jobStatus);
        continue;
      }

      const downloadRes = await axios.get(
        downloadUrl || `https://analyticsapi.zoho.in/restapi/v2/bulk/workspaces/${WORKSPACE_ID}/exportjobs/${jobId}/data`,
        { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'ZANALYTICS-ORGID': org.orgId } }
      );
      const rows = downloadRes.data?.data || downloadRes.data;
      console.log('\n  Fetch: SUCCESS with org', org.orgName, '(' + org.orgId + ')');
      console.log('  >>> Use this orgId going forward:', org.orgId);
      console.log('  >>> Use this viewId going forward:', target.viewId);
      if (Array.isArray(rows)) {
        console.log('  Total rows returned:', rows.length);
        console.log('  Column names (from first row):', rows[0] ? Object.keys(rows[0]) : '(no rows)');
        console.log('\n  First 3 rows, full detail:');
        console.log(JSON.stringify(rows.slice(0, 3), null, 2));
      } else {
        console.log('  Response shape was not a plain array — full response (truncated):');
        console.log(JSON.stringify(downloadRes.data, null, 2).slice(0, 3000));
      }
      succeeded = true;
      break;
    } catch (e) {
      console.log('  Export FAILED. Status:', e.response?.status, '| Body:', JSON.stringify(e.response?.data));
    }
  }
  if (!succeeded) console.log('\nCould not complete the export — see errors above.');
}

main();
