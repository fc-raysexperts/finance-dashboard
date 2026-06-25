// pages/api/project-financials.js
// Completely rewritten. Old approach: for every project popup, paginate
// through 5 Zoho Books document types (PO/Bill/Invoice/SO/CN) with a
// detail-fetch for every document missing project info at the list level
// — could cost 100+ Books API calls for a SINGLE project, and confirmed to
// burn through the entire shared daily Books quota from checking just a
// few projects once.
//
// New approach: Zoho Analytics already has this exact data pre-aggregated
// (the "Project Wise detail" Pivot view under the Budget-Dashboard
// workspace — the same one you already use) via its OWN, completely
// separate API and quota. One call fetches EVERY project's totals at
// once; the result is cached for hours, so every project view after the
// first costs zero additional calls of any kind, against either Books or
// Analytics.
//
// Workspace/view/org IDs below were discovered and confirmed live via
// zoho-analytics-diagnostic.js — not guessed:
//   - Workspace: Budget-Dashboard (425861000000008002)
//   - View: "Project Wise detail", a Pivot view (425861000002975091) —
//     NOT the "Budget-Dashboard" Dashboard container some URLs point to;
//     dashboards only export as PDF/HTML, this Pivot view is the actual
//     data table.
//   - Org: rayszoho (60039390994) — the other discovered org
//     (jatin.srivastava) doesn't own this workspace.

const axios = require('axios');
const { getAnalyticsAccessToken } = require('../../lib/zohoAnalyticsToken');
const { storeGet, storeSet } = require('../../lib/store');
const { PROJECTS, matchProject } = require('../../data/projects');

const WORKSPACE_ID = '425861000000008002';
const VIEW_ID = '425861000002975091';
const ORG_ID = '60039390994';

const CACHE_KEY = 'zoho_analytics_project_financials';
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours — one fetch covers every project, so a long TTL costs nothing extra later

// Zoho Analytics returns amounts as Indian-formatted strings, e.g.
// "4,31,38,51,338.00" — not plain numbers.
function parseIndianNumber(s) {
  if (typeof s === 'number') return s;
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

async function fetchAllProjectTotalsFromAnalytics() {
  const token = await getAnalyticsAccessToken();
  const headers = { Authorization: `Zoho-oauthtoken ${token}`, 'ZANALYTICS-ORGID': ORG_ID };

  // 1. Create the export job (this view requires async export — confirmed
  //    live; the simple sync endpoint returns SYNC_EXPORT_NOT_ALLOWED for it)
  const createRes = await axios.get(
    `https://analyticsapi.zoho.in/restapi/v2/bulk/workspaces/${WORKSPACE_ID}/views/${VIEW_ID}/data`,
    { headers, params: { CONFIG: JSON.stringify({ responseFormat: 'json' }) } }
  );
  const jobId = createRes.data?.data?.jobId;
  if (!jobId) throw new Error('No export jobId returned from Zoho Analytics');

  // 2. Poll for completion — the real run completed on the very first
  //    poll, but allow up to ~30s before giving up
  let downloadUrl = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise(r => setTimeout(r, 2000));
    const statusRes = await axios.get(
      `https://analyticsapi.zoho.in/restapi/v2/bulk/workspaces/${WORKSPACE_ID}/exportjobs/${jobId}`,
      { headers }
    );
    const jobStatus = statusRes.data?.data?.jobStatus;
    if (jobStatus === 'JOB COMPLETED') { downloadUrl = statusRes.data?.data?.downloadUrl; break; }
    if (jobStatus && jobStatus.includes('FAIL')) throw new Error('Zoho Analytics export job failed: ' + jobStatus);
  }
  if (!downloadUrl) throw new Error('Zoho Analytics export job did not complete in time');

  // 3. Download the actual rows
  const downloadRes = await axios.get(downloadUrl, { headers });
  const rows = downloadRes.data?.data || downloadRes.data;
  return Array.isArray(rows) ? rows : [];
}

async function getAllProjectTotals(forceRefresh) {
  if (!forceRefresh) {
    try {
      const cached = await storeGet(CACHE_KEY);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
        return cached.rows;
      }
    } catch { /* fall through to a fresh fetch */ }
  }
  const rows = await fetchAllProjectTotalsFromAnalytics();
  await storeSet(CACHE_KEY, { rows, fetchedAt: Date.now() }).catch(() => {});
  return rows;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const zohoNames = JSON.parse(req.query.zohoNames || '[]');
    const forceRefresh = req.query.refresh === '1';

    const allRows = await getAllProjectTotals(forceRefresh);

    // Reuse the exact same matchProject() logic already relied on
    // elsewhere in the app — pass this project's own zohoNames as a
    // single-item "project list" so each Analytics row gets checked
    // against just this project's aliases.
    const targetAsProjectList = [{ id: '__target__', zohoNames }];
    const matchingRows = allRows.filter(row => !!matchProject(row['Project Name'], targetAsProjectList));

    // Projects with more than one Zoho code (e.g. JSW has 3, Soni has 2)
    // appear as separate rows in this view — sum all matches, don't just
    // take the first one. Confirmed against your real export data.
    const data = {
      poTotal: 0, billTotal: 0, invoiceTotal: 0, soTotal: 0, cnTotal: 0, budgetAmount: 0,
    };
    matchingRows.forEach(row => {
      data.poTotal      += parseIndianNumber(row['Total PO Amount']);
      data.billTotal    += parseIndianNumber(row['Total Bill Amount']);
      data.invoiceTotal += parseIndianNumber(row['Total Invoice Amount']);
      data.soTotal       += parseIndianNumber(row['Total SO Amount']);
      data.cnTotal        += parseIndianNumber(row['Total CN Amount']);
      data.budgetAmount    += parseIndianNumber(row['Budget Amount']);
    });

    return res.status(200).json({ success: true, data, matchedRows: matchingRows.length, source: 'zoho-analytics' });
  } catch (err) {
    console.error('Project financials (Analytics) error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
