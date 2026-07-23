// pages/api/search-detail.js
//
// Fetches just enough detail to show the simplified "search result" view
// — general details + items/expense breakup + attachments — and
// DELIBERATELY skips everything expensive: no compliance checks, no AI,
// no PFB/Reference-Rate/Match tables, no recommendation. This is what
// keeps it fast regardless of how much historical data exists, per the
// explicit requirement that finding a past PBP this way should be quick,
// not slow like the main tabs' full processing.

import { getPODetail, getBillDetail } from '../../lib/zoho';
import { extractFields } from './pmos';
const axios = require('axios');
const { getAccessToken } = require('../../lib/zohoToken');

const PMO_MODULE = 'cm_payment_memos';
async function zohoGET(path, params = {}) {
  const token = await getAccessToken();
  const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID, ...params },
  });
  return res.data;
}

export default async function handler(req, res) {
  const { type, id } = req.query;
  if (!type || !id) return res.status(400).json({ error: 'type and id are required' });

  try {
    if (type === 'po') {
      const po = await getPODetail(id);
      if (!po) return res.status(404).json({ error: 'PO not found' });
      const vendorAddress = (function(){
        const addr = po.vendor_address || po.billing_address;
        if (!addr) return '';
        return [addr.address, [addr.city, addr.state, addr.zip].filter(Boolean).join(' '), addr.country].filter(Boolean).join(', ');
      })();
      const deliverTo = po.delivery_address ? [
        po.delivery_address.attention, po.delivery_address.address,
        [po.delivery_address.city, po.delivery_address.state, po.delivery_address.zip].filter(Boolean).join(' '),
        po.delivery_address.country,
      ].filter(Boolean).join(', ') : '';
      return res.status(200).json({ success: true, data: {
        type: 'po',
        // Same real field set as pos.js's main enrichment — everything
        // here is plain structured Zoho data, no PFB/compliance needed.
        sectionA: [
          ['Reference#', po.reference_number || '—'], ['Order Date', po.date], ['Delivery Date', po.delivery_date || '—'],
          ['Payment Terms', po.payment_terms_label || po.payment_terms || '—'],
          ['Kind Attention', (po.custom_fields || []).find(f => /kind attention/i.test(f.label || f.placeholder || ''))?.value || po.attention || '—'],
          ['Subject', (po.custom_fields || []).find(f => /subject/i.test(f.label || f.placeholder || ''))?.value || '—'],
          ['Quotation', (po.custom_fields || []).find(f => /quotation/i.test(f.label || f.placeholder || ''))?.value || '—'],
        ],
        addressRows: [{ template:'1fr 1fr', items: [['Vendor Address', vendorAddress || '—'], ['Delivery Address', deliverTo || '—']] }],
        sectionC: [
          ['Vendor', po.vendor_name], ['Vendor GSTIN', po.gst_no || po.vendor_gst_in || '—'], ['Total Amount', po.total],
          ['Submitted By', po.submitted_by_name || '—'], ['Submitted Date', po.submitted_date || '—'],
          ['Location', po.location_name || po.branch_name || '—'],
        ],
        notes: po.notes || '', terms: po.terms || '',
        lineItems: po.line_items || [], subTotal: po.sub_total, total: po.total,
        docs: po.documents || [],
      }});
    }

    if (type === 'bill') {
      const bill = await getBillDetail(id);
      if (!bill) return res.status(404).json({ error: 'Bill not found' });
      let linkedPOTotal = '—';
      try {
        const ref = (bill.purchaseorders || [])[0];
        if (ref?.purchaseorder_id) {
          const lp = await getPODetail(ref.purchaseorder_id);
          if (lp) linkedPOTotal = lp.total;
        }
      } catch { /* best-effort only */ }
      return res.status(200).json({ success: true, data: {
        type: 'bill',
        sectionA: [
          ['Order Number', bill.reference_number || (bill.purchaseorders||[])[0]?.purchaseorder_number || 'None'],
          ['Bill Date', bill.date], ['Due Date', bill.due_date || '—'],
          ['Payment Terms', bill.payment_terms_label || bill.payment_terms || '—'],
          ['Balance Due', bill.balance], ['Total', bill.total],
        ],
        addressRows: [{ template:'2fr 1fr', items: [
          ['Vendor Address', bill.vendor_address ? [bill.vendor_address.address, [bill.vendor_address.city, bill.vendor_address.state, bill.vendor_address.zip].filter(Boolean).join(' '), bill.vendor_address.country].filter(Boolean).join(', ') : '—'],
          ['Transaction Posting Date', bill.transaction_posting_date || '—'],
        ]}],
        sectionC: [
          ['Vendor', bill.vendor_name], ['Vendor GSTIN', bill.gst_no || bill.vendor_gst_in || '—'], ['PO Amount', linkedPOTotal],
          ['Submitted By', bill.submitted_by_name || '—'], ['Submitted Date', bill.submitted_date || '—'], ['Bill Amount', bill.total],
        ],
        customFields: [
          ['Original Reference Bill Number', bill.reference_number || '—'],
          ['Project Name', (bill.line_items||[])[0]?.project_name || '—'],
          ['Bill Type', bill.bill_type || '—'],
        ],
        notes: bill.notes || '',
        lineItems: bill.line_items || [], subTotal: bill.sub_total, total: bill.total,
        docs: bill.documents || [],
      }});
    }

    if (type === 'pmo') {
      const det = await zohoGET(`/${PMO_MODULE}/${id}`);
      const record = det.data?.module_record || det.module_record || det;
      const recordHash = det.module_record_hash || det.data?.module_record_hash || {};
      const f = extractFields(record.module_fields);
      const attachmentId   = String(f.cf_attachment           || '');
      const attachmentName = String(f.cf_attachment_formatted || '');
      const expenseRows = Array.isArray(recordHash.cf_cm_expense_breakup_1) ? recordHash.cf_cm_expense_breakup_1 : [];
      const poRows      = Array.isArray(recordHash.cf_cm_po_breakup_1) ? recordHash.cf_cm_po_breakup_1 : [];
      return res.status(200).json({ success: true, data: {
        type: 'pmo',
        sectionA: [
          ['PMO Number', f.cf_pmo_number || record.record_name || '—'],
          ['PMO Date', f.cf_pmo_date || f.cf_payment_date || '—'],
          ['Payable Amount', parseFloat(f.cf_payable_amount) || 0],
          ['Payment Category', f.cf_payment_category || '—'],
          ['Payment Sub-Category', f.cf_payment_sub_category || '—'],
          ['Payment Type', f.cf_payment_type || '—'],
        ],
        sectionC: [
          ['Vendor Name', f.cf_vendor_name || '—'],
          ['Closing Balance', f.cf_closing_balance || '—'],
          ['Payment Terms', f.cf_payment_type || '—'],
        ],
        notes: f.cf_remarks || '',
        poBreakup: poRows.map(r => ({
          po_number: r.cf_po_number_formatted || r.cf_po_number || '—',
          basic: r.cf_basic_amount, tax: r.cf_tax_amount, total: r.cf_total,
        })),
        lineItems: expenseRows.map(r => ({
          name: r.cf_expense_detail || 'Expense', quantity: 1, rate: r.cf_basic_amount, item_total: r.cf_total,
        })),
        subTotal: null, total: parseFloat(f.cf_payable_amount) || 0,
        docs: attachmentId ? [{ document_id: attachmentId, file_name: attachmentName || 'attachment' }] : [],
      }});
    }

    return res.status(400).json({ error: `Unknown type "${type}"` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
