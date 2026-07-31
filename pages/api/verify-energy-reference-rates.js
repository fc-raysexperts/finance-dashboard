// pages/api/verify-energy-reference-rates.js
//
// A one-off VERIFICATION tool, not a production feature. The real
// blocker right now: 0 PBPs are pending Jatin's approval for Energy, so
// the normal dashboard tabs show nothing to click into, and
// search-detail.js deliberately skips Reference Rate computation
// entirely (documented there as an explicit speed decision for its own
// purpose) — so there's currently no way to actually SEE the real
// Reference Rate table render with real data through the normal UI.
//
// This endpoint fetches every one of Energy's real historical POs and
// Bills, computes the exact same referenceRateChecks the real pos.js/
// bills.js already compute (same buildReferenceRateRow function, same
// org-scoped catalog/history), and returns all of it directly — so the
// real numbers can be seen and confirmed right now, without waiting for
// a new pending approval and without changing search-detail.js's
// deliberate design at all.
//
//   https://your-site.vercel.app/api/verify-energy-reference-rates?key=check123

const axios = require('axios');
const { getAccessToken } = require('../../lib/zohoToken');
const { getOrgId } = require('../../lib/subsidiaries');
const { storeGet, KEYS, orgScopedKey } = require('../../lib/store');
const { buildReferenceRateRow } = require('../../lib/referenceRates');
const { nameSimilarity } = require('../../lib/pfbEngine');

const ORG_KEY = 'energy';

async function zohoGET(path, params = {}) {
  const token = await getAccessToken();
  const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: getOrgId(ORG_KEY), ...params },
  });
  return res.data;
}

export default async function handler(req, res) {
  if (req.query.key !== 'check123') {
    return res.status(403).json({ error: 'Add ?key=check123 to the URL' });
  }

  try {
    const rrCatalog = await storeGet(orgScopedKey(KEYS.REFERENCE_RATE_CATALOG, ORG_KEY)).catch(() => null) || {};
    const rrHistory = await storeGet(orgScopedKey(KEYS.REFERENCE_RATE_HISTORY, ORG_KEY)).catch(() => null) || {};
    const asOf = new Date().toISOString();

    const results = { pos: [], bills: [] };

    const poList = await zohoGET('/purchaseorders', { date_start: '2000-01-01', per_page: 200 });
    for (const rec of poList.purchaseorders || []) {
      const detail = await zohoGET(`/purchaseorders/${rec.purchaseorder_id}`);
      const po = detail.purchaseorder;
      const namedLineItems = (po.line_items || []).map(li => (li.name && li.name.trim()) ? li : { ...li, name: (li.description || '').trim() });
      const checks = namedLineItems
        .map(li => buildReferenceRateRow(li, 'po', rrCatalog, rrHistory, nameSimilarity, asOf))
        .filter(Boolean);
      results.pos.push({ poNumber: po.purchaseorder_number, date: po.date, referenceRateChecks: checks });
      await new Promise(r => setTimeout(r, 150));
    }

    const billList = await zohoGET('/bills', { date_start: '2000-01-01', per_page: 200 });
    for (const rec of billList.bills || []) {
      const detail = await zohoGET(`/bills/${rec.bill_id}`);
      const bill = detail.bill;
      const namedLineItems = (bill.line_items || []).map(li => (li.name && li.name.trim()) ? li : { ...li, name: (li.description || '').trim() });
      const checks = namedLineItems
        .map(li => buildReferenceRateRow(li, 'bill', rrCatalog, rrHistory, nameSimilarity, asOf))
        .filter(Boolean);
      results.bills.push({ billNumber: bill.bill_number, date: bill.date, referenceRateChecks: checks });
      await new Promise(r => setTimeout(r, 150));
    }

    const totalChecksWithHistory = [...results.pos, ...results.bills]
      .flatMap(d => d.referenceRateChecks)
      .filter(c => c.hasHistory).length;

    return res.status(200).json({
      org: ORG_KEY,
      totalPOs: results.pos.length,
      totalBills: results.bills.length,
      totalLineItemChecksWithRealHistory: totalChecksWithHistory,
      note: 'This is what the real Reference Rate table would show for each document — same function, same stored data, just called directly here instead of through a PO/Bill popup.',
      results,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, responseData: e.response?.data });
  }
}
