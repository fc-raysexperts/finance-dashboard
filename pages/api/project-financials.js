// pages/api/project-financials.js
// Fetches aggregated financial totals for a project from Zoho Books
// Called when opening a project detail popup

const axios = require('axios');

let cachedToken = null; let tokenExpiry = 0;
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: { refresh_token:process.env.ZOHO_REFRESH_TOKEN, client_id:process.env.ZOHO_CLIENT_ID, client_secret:process.env.ZOHO_CLIENT_SECRET, grant_type:'refresh_token' }
  });
  cachedToken = res.data.access_token; tokenExpiry = Date.now() + 55*60*1000;
  return cachedToken;
}

async function zohoGET(path, params = {}) {
  const token = await getToken();
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params:  { organization_id: process.env.ZOHO_ORG_ID, ...params }
      });
      return res.data;
    } catch (e) {
      if (e.response?.status === 429 && i < 3) { await new Promise(r => setTimeout(r, i * 2000)); continue; }
      throw e;
    }
  }
}

// Sum totals from a paginated list endpoint filtered by project name keywords
async function sumProjectTotals(endpoint, listKey, amountField, projectKeywords) {
  let total = 0;
  // Search for each keyword variant
  for (const keyword of projectKeywords.slice(0, 3)) { // limit to 3 searches per type
    try {
      const data = await zohoGET(endpoint, { search_text: keyword, per_page: 200 });
      const items = data[listKey] || [];
      items.forEach(item => {
        total += parseFloat(item[amountField] || item.total || 0);
      });
    } catch { /* skip failed searches */ }
    await new Promise(r => setTimeout(r, 100)); // small pause between calls
  }
  return total;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let zohoNames = [];
  try {
    zohoNames = JSON.parse(decodeURIComponent(req.query.zohoNames || '[]'));
  } catch {
    return res.status(400).json({ error: 'Invalid zohoNames parameter' });
  }

  if (!zohoNames.length) {
    return res.status(200).json({ success: true, data: { poTotal: 0, billTotal: 0, invoiceTotal: 0, soTotal: 0, cnTotal: 0 } });
  }

  // Use LE codes for searching — most precise
  const searchTerms = zohoNames.filter(n => /^LE\d{4}/.test(n)).slice(0, 2);
  if (!searchTerms.length) searchTerms.push(...zohoNames.slice(0, 2));

  try {
    const [poTotal, billTotal, invoiceTotal, soTotal, cnTotal] = await Promise.all([
      sumProjectTotals('/purchaseorders', 'purchaseorders', 'total', searchTerms),
      sumProjectTotals('/bills',          'bills',          'total', searchTerms),
      sumProjectTotals('/invoices',       'invoices',       'total', searchTerms),
      sumProjectTotals('/salesorders',    'salesorders',    'total', searchTerms),
      sumProjectTotals('/creditnotes',    'creditnotes',    'total', searchTerms),
    ]);

    return res.status(200).json({
      success: true,
      data: { poTotal, billTotal, invoiceTotal, soTotal, cnTotal },
    });
  } catch (err) {
    console.error('Project financials error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}