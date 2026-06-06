// pages/api/search.js
// Search POs or Bills by any keyword

import { searchPOs, searchBills } from '../../lib/zoho';

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