// pages/api/debug-modules.js — comprehensive PMO discovery

const axios = require('axios');

async function getToken() {
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    }
  });
  return res.data.access_token;
}

async function tryPath(token, path, params = {}) {
  try {
    const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params:  { organization_id: process.env.ZOHO_ORG_ID, per_page: 3, ...params }
    });
    return { status: 200, keys: Object.keys(res.data), sample: JSON.stringify(res.data).substring(0, 600) };
  } catch (e) {
    return { status: e.response?.status, error: e.message };
  }
}

export default async function handler(req, res) {
  try {
    const token = await getToken();

    const tests = await Promise.all([
      // Try all possible custom module path variants
      tryPath(token, '/custommodules/cm_payment_memos'),
      tryPath(token, '/cm_payment_memos'),
      tryPath(token, '/custommodules/payment_memos'),
      tryPath(token, '/custommodules/PaymentMemos'),
      // Try with status filter
      tryPath(token, '/custommodules/cm_payment_memos', { status: 'pending_approval' }),
      // Vendor payments — see what fields are on records
      tryPath(token, '/vendorpayments'),
      // Check if vendorpayments has approval info
      tryPath(token, '/vendorpayments', { status: 'pending_approval' }),
    ]);

    const paths = [
      '/custommodules/cm_payment_memos',
      '/cm_payment_memos',
      '/custommodules/payment_memos',
      '/custommodules/PaymentMemos',
      '/custommodules/cm_payment_memos?status=pending_approval',
      '/vendorpayments (first 3 records)',
      '/vendorpayments?status=pending_approval',
    ];

    const results = {};
    paths.forEach((p, i) => results[p] = tests[i]);

    // Also get first vendor payment detail to see its fields
    let vpDetail = null;
    try {
      const vpList = await axios.get('https://www.zohoapis.in/books/v3/vendorpayments', {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params:  { organization_id: process.env.ZOHO_ORG_ID, per_page: 1 }
      });
      const vps = vpList.data.vendorpayments || [];
      if (vps[0]) {
        const det = await axios.get(`https://www.zohoapis.in/books/v3/vendorpayments/${vps[0].payment_id}`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          params:  { organization_id: process.env.ZOHO_ORG_ID }
        });
        const vp = det.data.vendorpayment || {};
        vpDetail = {
          allKeys: Object.keys(vp),
          approvalKeys: Object.keys(vp).filter(k => k.includes('approv') || k.includes('status') || k.includes('workflow')),
          approvalValues: Object.fromEntries(
            Object.keys(vp).filter(k => k.includes('approv') || k.includes('status') || k.includes('workflow'))
              .map(k => [k, vp[k]])
          ),
          listLevelKeys: Object.keys(vps[0]),
          listApprovalKeys: Object.keys(vps[0]).filter(k => k.includes('approv') || k.includes('status')),
        };
      }
    } catch (e) {
      vpDetail = { error: e.message };
    }

    return res.status(200).json({ paths: results, vendorPaymentDetail: vpDetail });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}