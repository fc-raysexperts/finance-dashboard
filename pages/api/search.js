// pages/api/search.js
// Search POs, Bills, or PMOs by any keyword

import { searchPOs, searchBills } from '../../lib/zoho';
const axios = require('axios');
const { getAccessToken } = require('../../lib/zohoToken');

const PMO_MODULE = 'cm_payment_memos';
async function searchPMOs(query) {
  let token = await getAccessToken();
  const res = await axios.get(`https://www.zohoapis.in/books/v3/${PMO_MODULE}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID, search_text: query, per_page: 50 },
  });
  return res.data.module_records || [];
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { q, type } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  try {
    let results = [];

    if (type === 'bill') {
      const bills = await searchBills(q.trim());
      results = bills.map(b => ({
        id:         b.bill_id,
        number:     b.bill_number,
        type:       'bill',
        vendor:     b.vendor_name,
        project:    b.project_name || b.customer_name || '',
        total:      b.total,
        status:     b.status,
        date:       b.date,
      }));
    } else if (type === 'pmo') {
      // Real caveat: unlike POs/Bills (standard Zoho modules with a
      // proven search_text param), this is a custom module — search_text
      // support here follows the same REST convention but hasn't been
      // independently verified against live data. If this comes back
      // empty even for a PMO number you know exists, that's the first
      // thing to check.
      const pmos = await searchPMOs(q.trim());
      results = pmos.map(p => ({
        id:      p.module_record_id,
        number:  String(p.record_name || ''),
        type:    'pmo',
        vendor:  '', // list endpoint doesn't include custom fields — shown after selecting
        project: '',
        total:   null,
        status:  '',
        date:    p.last_modified_time ? p.last_modified_time.slice(0, 10) : '',
      }));
    } else {
      // Default: search POs
      const pos = await searchPOs(q.trim());
      results = pos.map(p => ({
        id:         p.purchaseorder_id,
        number:     p.purchaseorder_number,
        type:       'po',
        vendor:     p.vendor_name,
        project:    p.project_name || p.customer_name || '',
        total:      p.total,
        status:     p.status,
        date:       p.date,
      }));
    }

    return res.status(200).json({ success: true, count: results.length, data: results });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}