// pages/api/pmos.js — Final correct version
// Field mapping verified from live Zoho debug output

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

// Extract module_fields into a clean key→value map
// Uses api_name as key, value_formatted for lookups, value for everything else
function extractFields(moduleFields) {
  const map = {};
  if (!Array.isArray(moduleFields)) return map;
  moduleFields.forEach(f => {
    const key = f.api_name || f.placeholder;
    if (!key) return;
    // Lookup fields store an ID in value — the human-readable name is in value_formatted
    const isLookup = f.data_type === 'lookup' || f.rendering_type === 'lookup';
    map[key] = isLookup
      ? (f.value_formatted || f.value || '')
      : (f.value !== undefined && f.value !== null ? f.value : '');
    // Always store value_formatted separately in case needed
    map[key + '_formatted'] = f.value_formatted || '';
  });
  return map;
}

// Check approvers_list — approver_id field does not exist on this custom module
function isJatinCurrentApprover(rec) {
  if (!Array.isArray(rec.approvers_list)) return false;
  return rec.approvers_list.some(a =>
    (a.approver_user_id === JATIN_USER_ID || a.email === APPROVER_EMAIL) &&
    a.is_next_approver === true &&
    a.has_approved === false &&
    a.approval_status === 'pending_approval'
  );
}

// Delta cache — only re-fetch records that changed
const pmoCache = { records: {}, snapshot: {} };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Step 1: Fetch ALL pages to collect every pending_approval record
    // 2315 total records across 12 pages — must paginate all of them
    let allPending = [];
    let page = 1;

    while (true) {
      const data = await zohoGET(`/${PMO_MODULE}`, { per_page: 200, page });
      const recs  = data.module_records || [];

      // Filter pending at list level — reduces detail calls from 200 → ~5 per page
      const pending = recs.filter(r => r.status === 'pending_approval');
      allPending = allPending.concat(pending);

      if (!data.page_context?.has_more_page) break;
      page++;
      await new Promise(r => setTimeout(r, 200)); // avoid rate limiting
    }

    console.log(`PMOs: ${allPending.length} pending_approval across ${page} pages`);

    // Step 2: Fetch detail for all pending records using delta cache
    // Typically 66 records = 66 detail calls on cold start, then cached
    const detailed = [];
    for (let i = 0; i < allPending.length; i += 10) {
      const batch   = allPending.slice(i, i + 10);
      const details = await Promise.all(batch.map(async r => {
        const id       = r.module_record_id;
        const modified = r.last_modified_time || '';

        if (pmoCache.records[id] && pmoCache.snapshot[id] === modified) {
          return pmoCache.records[id];
        }

        try {
          const det    = await zohoGET(`/${PMO_MODULE}/${id}`);
          const record = det.data?.module_record || det.module_record || det;
          pmoCache.records[id]  = record;
          pmoCache.snapshot[id] = modified;
          return record;
        } catch {
          return r; // fallback to list-level data
        }
      }));
      detailed.push(...details.filter(Boolean));
      if (i + 10 < allPending.length) await new Promise(r => setTimeout(r, 300));
    }

    // Step 3: Filter to Jatin's current approvals
    const jatinPMOs = detailed.filter(isJatinCurrentApprover);
    console.log(`PMOs: ${jatinPMOs.length} currently pending Jatin's approval`);

    // Step 4: Map fields using confirmed api_name keys
    const enriched = jatinPMOs.map(raw => {
      const f = extractFields(raw.module_fields);

      // All field names confirmed from live debug output:
      const pmoNumber     = f.cf_pmo_number     || raw.record_name || '';
      const date          = f.cf_pmo_date        || f.cf_payment_date || '';
      const purpose       = f.cf_remarks         || f.cf_payment_details || '';
      const paymentTerms  = f.cf_payment_terms   || '';
      const payCategory   = f.cf_payment_category || '';
      const paySubCat     = f.cf_payment_sub_category || '';
      const payType       = f.cf_payment_type    || '';
      const amount        = parseFloat(f.cf_payable_amount) || 0;
      // cf_vendor_name is a lookup — value_formatted has the actual name
      const vendor        = f.cf_vendor_name     || '—';
      const customerName  = f.cf_customer_name   || '';
      const expenseAcct   = f.cf_expense_account || '';
      const closingBal    = parseFloat(f.cf_closing_balance) || 0;
      const attachmentId  = f.cf_attachment      || '';

      // Build normalised object for compliance checks
      const pmoNorm = {
        pmo_number:        pmoNumber,
        id:                raw.module_record_id,
        date,
        vendor_name:       vendor,
        amount,
        description:       purpose,
        payment_type:      `${payCategory} / ${paySubCat} / ${payType}`.replace(/^\/\s*|\/\s*$/g,'').trim(),
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
        paymentTerms,
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

    // Sort by date descending
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
        pages:   page,
        pending: allPending.length,
        jatin:   jatinPMOs.length,
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