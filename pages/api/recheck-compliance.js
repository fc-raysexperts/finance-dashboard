// pages/api/recheck-compliance.js
//
// Manual, TARGETED re-check for a single PO/Bill/PMO — deliberately
// scoped to one item at a time (not a whole-tab batch), triggered by
// the "Re-check Compliances" button next to the CC table in a popup.
// Deletes that item's cached AI result first, then makes a real,
// fresh Gemini call using whatever the CURRENT prompt is — useful when
// the prompt itself has just been improved (e.g. after a false-negative
// like the substance-vs-literal-wording fix), or when new attachments
// have been added since the last automatic check, and the person
// doesn't want to wait for a fingerprint change or the next cron cycle.

import { getPODetail, getBillDetail } from '../../lib/zoho';
import { getAIComplianceForPO, getAIComplianceForBill, getAIComplianceForPMO } from '../../lib/aiComplianceEngine';
import { extractFields } from './pmos';
const { storeGet, storeSet, KEYS } = require('../../lib/store');
const axios = require('axios');
const { getAccessToken } = require('../../lib/zohoToken');

const PMO_MODULE = 'cm_payment_memos';
async function zohoGET(path, params = {}) {
  let token = await getAccessToken();
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID, ...params },
      });
      return res.data;
    } catch (e) {
      if (e.response?.status === 401 && i < 3) { token = await getAccessToken(true); continue; }
      throw e;
    }
  }
}

async function deleteAICacheEntry(cacheKey) {
  const cache = (await storeGet(KEYS.AI_COMPLIANCE_CACHE)) || {};
  delete cache[cacheKey];
  await storeSet(KEYS.AI_COMPLIANCE_CACHE, cache);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { type, id } = req.body || {};
  if (!type || !id) return res.status(400).json({ error: 'type and id are required' });

  try {
    if (type === 'po') {
      await deleteAICacheEntry(`po:${id}`);
      const po = await getPODetail(id);
      if (!po) return res.status(404).json({ error: 'PO not found' });
      const result = await getAIComplianceForPO(po);
      return res.status(200).json({ success: true, results: result.results });
    }

    if (type === 'bill') {
      await deleteAICacheEntry(`bill:${id}`);
      const bill = await getBillDetail(id);
      if (!bill) return res.status(404).json({ error: 'Bill not found' });
      // Best-effort linked-PO context, same as the main bills.js flow —
      // not essential for the re-check to work, just extra prompt context.
      let linkedPO = null;
      try {
        const ref = (bill.purchaseorders || [])[0];
        if (ref?.purchaseorder_id) linkedPO = await getPODetail(ref.purchaseorder_id);
      } catch { /* best-effort only */ }
      const result = await getAIComplianceForBill(bill, linkedPO);
      return res.status(200).json({ success: true, results: result.results });
    }

    if (type === 'pmo') {
      await deleteAICacheEntry(`pmo:${id}`);
      const det = await zohoGET(`/${PMO_MODULE}/${id}`);
      const record = det.data?.module_record || det.module_record || det;
      const f = extractFields(record.module_fields);
      const payCategory = String(f.cf_payment_category || '');
      const paySubCat   = String(f.cf_payment_sub_category || '');
      const payType     = String(f.cf_payment_type || '');
      const attachmentId   = String(f.cf_attachment           || '');
      const attachmentName = String(f.cf_attachment_formatted || '');
      const pmo = {
        pmo_number:     String(f.cf_pmo_number || record.record_name || ''),
        id:             record.module_record_id,
        vendor_name:    String(f.cf_vendor_name || '—'),
        amount:         parseFloat(f.cf_payable_amount) || 0,
        remarks:        String(f.cf_remarks || ''),
        paymentDetails: String(f.cf_payment_details || ''),
        payment_type:   [payCategory, paySubCat, payType].filter(Boolean).join(' / '),
        documents:      attachmentId ? [{ document_id: attachmentId, file_name: attachmentName || 'attachment' }] : [],
        approvers_list: [],
      };
      const result = await getAIComplianceForPMO(pmo);
      return res.status(200).json({ success: true, results: result.results });
    }

    return res.status(400).json({ error: `Unknown type "${type}" — must be "po", "bill", or "pmo"` });
  } catch (e) {
    if (e.isQuotaExceeded) {
      return res.status(429).json({ error: 'Gemini free-tier quota limit reached — try again in a minute.' });
    }
    return res.status(500).json({ error: e.message });
  }
}
