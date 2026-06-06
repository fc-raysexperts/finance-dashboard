// pages/api/pmos.js — Final version with 15-minute list cache
// Fixes 52s load time: cold start takes 52s once, then cached for 15 min

import { runPMOCompliance, runPMOAlignment, getComplianceStatus } from '../../lib/checklistEngine';
const axios = require('axios');

const JATIN_USER_ID  = '2346113000000742107';
const APPROVER_EMAIL = 'jatin.srivastava@raysexperts.com';
const PMO_MODULE     = 'cm_payment_memos';

let cachedToken = null;
let tokenExpiry  = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    'refresh_token',
    }
  });
  cachedToken = res.data.access_token;
  tokenExpiry  = Date.now() + 55 * 60 * 1000;
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
      if (e.response?.status === 429 && i < 3) {
        await new Promise(r => setTimeout(r, i * 2000));
        continue;
      }
      throw e;
    }
  }
}

// Server-side list cache — stores all pending record IDs for 15 minutes
// Avoids re-fetching 12 pages (2315 records) on every request
let listCache    = { pending: [], fetchedAt: 0 };
const LIST_TTL   = 15 * 60 * 1000; // 15 minutes

// Detail cache — only re-fetch records that changed
const detailCache = { records: {}, snapshot: {} };

// Extract module_fields into a clean api_name → value map
// Uses value_formatted for lookup fields (vendor name, customer name etc.)
function extractFields(moduleFields) {
  const map = {};
  if (!Array.isArray(moduleFields)) return map;
  moduleFields.forEach(f => {
    const key = f.api_name || f.placeholder;
    if (!key) return;
    const isLookup = f.data_type === 'lookup' || f.rendering_type === 'lookup';
    map[key] = isLookup
      ? (f.value_formatted || f.value || '')
      : (f.value !== undefined && f.value !== null ? f.value : '');
    map[key + '_formatted'] = f.value_formatted || '';
  });
  return map;
}

// Check approvers_list — approver_id field does not exist on this custom module
function isJatinCurrentApprover(rec) {
  if (!Array.isArray(rec.approvers_list)) return false;
  return rec.approvers_list.some(a =>
    (a.approver_user_id === JATIN_USER_ID || a.email === APPROVER_EMAIL) &&
    a.is_next_approver  === true &&
    a.has_approved      === false &&
    a.approval_status   === 'pending_approval'
  );
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ── STEP 1: Get all pending records ──────────────────────
    // Use 15-min list cache to avoid 12-page fetch on every request
    let allPending = [];

    if (Date.now() - listCache.fetchedAt < LIST_TTL && listCache.pending.length > 0) {
      allPending = listCache.pending;
      console.log(`PMOs: list cache hit — ${allPending.length} pending`);
    } else {
      let page = 1;
      while (true) {
        const data    = await zohoGET(`/${PMO_MODULE}`, { per_page: 200, page });
        const recs    = data.module_records || [];
        const pending = recs.filter(r => r.status === 'pending_approval');
        allPending    = allPending.concat(pending);
        if (!data.page_context?.has_more_page) break;
        page++;
        await new Promise(r => setTimeout(r, 200));
      }
      listCache = { pending: allPending, fetchedAt: Date.now() };
      console.log(`PMOs: fetched ${allPending.length} pending across ${page} pages — cached 15 min`);
    }

    // ── STEP 2: Fetch detail for pending records (delta cache) ─
    const detailed = [];
    for (let i = 0; i < allPending.length; i += 10) {
      const batch   = allPending.slice(i, i + 10);
      const results = await Promise.all(batch.map(async r => {
        const id       = r.module_record_id;
        const modified = r.last_modified_time || '';
        if (detailCache.records[id] && detailCache.snapshot[id] === modified) {
          return detailCache.records[id];
        }
        try {
          const det    = await zohoGET(`/${PMO_MODULE}/${id}`);
          const record = det.data?.module_record || det.module_record || det;
          detailCache.records[id]  = record;
          detailCache.snapshot[id] = modified;
          return record;
        } catch {
          return r;
        }
      }));
      detailed.push(...results.filter(Boolean));
      if (i + 10 < allPending.length) await new Promise(r => setTimeout(r, 300));
    }

    // ── STEP 3: Filter to Jatin's current approvals ────────────
    const jatinPMOs = detailed.filter(isJatinCurrentApprover);
    console.log(`PMOs: ${jatinPMOs.length} currently pending Jatin's approval`);

    // ── STEP 4: Map fields using confirmed api_name keys ────────
    const enriched = jatinPMOs.map(raw => {
      const f = extractFields(raw.module_fields);

      // All field names confirmed from live debug:
      // cf_pmo_number, cf_remarks, cf_pmo_date, cf_payment_terms,
      // cf_payment_category, cf_attachment, cf_payment_sub_category,
      // cf_payment_type, cf_payable_amount, cf_vendor_name (lookup→value_formatted),
      // cf_customer_name, cf_expense_account, cf_closing_balance,
      // cf_payment_date, cf_payment_details

      const pmoNumber    = String(f.cf_pmo_number || raw.record_name || '');
      const date         = String(f.cf_pmo_date   || f.cf_payment_date || '');
      const purpose      = String(f.cf_remarks     || f.cf_payment_details || '');
      const payTerms     = String(f.cf_payment_terms        || '');
      const payCategory  = String(f.cf_payment_category     || '');
      const paySubCat    = String(f.cf_payment_sub_category  || '');
      const payType      = String(f.cf_payment_type         || '');
      const amount       = parseFloat(f.cf_payable_amount)  || 0;
      const vendor       = String(f.cf_vendor_name          || '—');
      const customerName = String(f.cf_customer_name        || '');
      const expenseAcct  = String(f.cf_expense_account      || '');
      const closingBal   = parseFloat(f.cf_closing_balance) || 0;
      const attachmentId = String(f.cf_attachment           || '');

      const payTypeLabel = [payCategory, paySubCat, payType]
        .filter(Boolean).join(' / ');

      const pmoNorm = {
        pmo_number:        pmoNumber,
        id:                raw.module_record_id,
        date,
        vendor_name:       vendor,
        amount,
        description:       purpose,
        payment_type:      payTypeLabel,
        documents:         raw.documents || [],
        submitted_by_name: raw.submitted_by_name || '',
        closing_balance:   closingBal,
        approvers_list:    raw.approvers_list || [],
      };

      const compliance = runPMOCompliance(pmoNorm);
      const alignment  = runPMOAlignment(pmoNorm, null);
      const compStatus = getComplianceStatus(compliance);

      return {
        id:              raw.module_record_id,
        pmoNumber,
        date,
        vendor,
        amount,
        purpose,
        paymentCategory: payCategory,
        paymentSubCat:   paySubCat,
        paymentType:     payType,
        paymentTerms:    payTerms,
        payTypeLabel,
        customerName,
        expenseAccount:  expenseAcct,
        closingBalance:  closingBal,
        attachmentId,
        submittedBy:     raw.submitted_by_name || '',
        submittedDate:   raw.submitted_date    || '',
        status:          raw.status,
        docs:            raw.documents || [],
        lineItems:       [],
        complianceStatus: compStatus,
        alignmentStatus:  alignment.status,
        compliance,
        alignment,
        recommendation:  buildRec(compStatus, compliance),
      };
    });

    // Sort by date descending — latest first
    enriched.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(b.date) - new Date(a.date);
    });

    return res.status(200).json({
      success: true,
      count:   enriched.length,
      data:    enriched,
      debug: {
        pending: allPending.length,
        jatin:   jatinPMOs.length,
        cached:  Date.now() - listCache.fetchedAt < LIST_TTL,
      }
    });

  } catch (err) {
    console.error('PMOs API error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

function buildRec(status, checks) {
  const failed = checks.filter(c => !c.passed);
  if (status === 'fail') return { decision:'REJECT',          color:'red',   reasons: failed.map(c => c.comment) };
  if (status === 'warn') return { decision:'FLAG FOR REVIEW', color:'amber', reasons: failed.map(c => c.comment) };
  return { decision:'APPROVE', color:'green', reasons: ['All PMO compliance checks passed'] };
}