// pages/api/diagnose-energy-line-items.js
//
// One-off diagnostic: the real backfill run processed all 4 POs and all
// 17 Bills for Energy without any errors or stoppedEarly signal, yet
// found ZERO distinct items — meaning something about how the detail
// response is shaped is different from what recordOccurrence expects,
// not that there's genuinely no data. Rather than guess at the fix,
// this fetches ONE real PO and ONE real Bill's actual full detail and
// returns the raw structure directly, so the mismatch can be seen
// directly instead of guessed at — same diagnostic-first approach
// already used successfully elsewhere in this project (e.g. confirming
// the real PMO module name before building against it).
//
//   https://your-site.vercel.app/api/diagnose-energy-line-items?key=check123

const axios = require('axios');
const { getAccessToken } = require('../../lib/zohoToken');
const { getOrgId } = require('../../lib/subsidiaries');

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
    const result = { org: ORG_KEY, orgId: getOrgId(ORG_KEY) };

    // Fetch the PO list to get one real ID, then its full detail
    const poList = await zohoGET('/purchaseorders', { date_start: '2000-01-01', per_page: 5 });
    result.poListSample = (poList.purchaseorders || []).slice(0, 2); // just enough to see the list shape
    if (poList.purchaseorders && poList.purchaseorders.length > 0) {
      const poId = poList.purchaseorders[0].purchaseorder_id;
      const poDetail = await zohoGET(`/purchaseorders/${poId}`);
      result.poDetailTopLevelKeys = Object.keys(poDetail);
      result.poDetailRaw = poDetail;
    } else {
      result.poDetailRaw = 'No POs returned by the list call at all — this itself would be significant.';
    }

    // Same for one real Bill
    const billList = await zohoGET('/bills', { date_start: '2000-01-01', per_page: 5 });
    result.billListSample = (billList.bills || []).slice(0, 2);
    if (billList.bills && billList.bills.length > 0) {
      const billId = billList.bills[0].bill_id;
      const billDetail = await zohoGET(`/bills/${billId}`);
      result.billDetailTopLevelKeys = Object.keys(billDetail);
      result.billDetailRaw = billDetail;
    } else {
      result.billDetailRaw = 'No Bills returned by the list call at all — this itself would be significant.';
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({
      error: e.message,
      responseData: e.response?.data,
      responseStatus: e.response?.status,
    });
  }
}
