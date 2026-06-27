// pages/api/pmos.js
// Approver-check logic unchanged from the last working version.
//
// Token fetching now goes through the shared lib/zohoToken.js (also used
// by lib/zoho.js and project-financials.js) instead of its own private
// cache — that 3-separate-caches setup was the actual cause of the
// repeating 401 after idle periods. PMOs still use their own zohoGET
// wrapper for the cm_payment_memos module, since that's a different Zoho
// module than POs/Bills.
//
// PERSISTENCE + MANUAL-REFRESH-ONLY ADDED: same reasoning as lib/zoho.js —
// listCache/detailCache were pure in-memory, wiped on every Vercel cold
// start/redeploy, defeating the whole point of caching. Now persisted to
// KV, and a normal page load serves straight from that persisted cache
// with zero Zoho calls; a real fetch only happens when the user explicitly
// clicks Refresh (forceRefresh) or there's no cache yet at all.

import { runPMOCompliance, runPMOAlignment, getComplianceStatus } from '../../lib/checklistEngine';
const axios = require('axios');
const { getAccessToken } = require('../../lib/zohoToken');
const { storeGet, storeSet, KEYS } = require('../../lib/store');

const JATIN_USER_ID  = '2346113000000742107';
const APPROVER_EMAIL = 'jatin.srivastava@raysexperts.com';
const PMO_MODULE     = 'cm_payment_memos';

async function zohoGET(path, params = {}) {
  let token = await getAccessToken();
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params:  { organization_id: process.env.ZOHO_ORG_ID, ...params }
      });
      return res.data;
    } catch (e) {
      if (e.response?.status === 401 && i === 1) {
        token = await getAccessToken({ skipMemoryCache: true });
        continue;
      }
      if (e.response?.status === 401 && i === 2) {
        token = await getAccessToken({ forceRefresh: true });
        continue;
      }
      if (e.response?.status === 429 && i < 3) {
        await new Promise(r => setTimeout(r, i * 3000));
        continue;
      }
      throw e;
    }
  }
}

let listCache     = { pending: [], fetchedAt: 0 };
const detailCache = { records: {}, snapshot: {} };
let hydrated      = false; // have we tried loading from KV yet, this process lifetime?

async function hydrateFromPersistedStore() {
  if (hydrated) return;
  hydrated = true;
  try {
    const persisted = await storeGet(KEYS.ZOHO_DELTA_PMOS);
    if (persisted && Object.keys(persisted.detailCache?.records || {}).length > 0) {
      listCache   = persisted.listCache   || listCache;
      detailCache.records  = persisted.detailCache.records  || {};
      detailCache.snapshot = persisted.detailCache.snapshot || {};
    }
  } catch { /* KV unavailable — proceed with whatever's in memory */ }
}

async function persistStore() {
  await storeSet(KEYS.ZOHO_DELTA_PMOS, { listCache, detailCache }).catch(() => {});
}

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
    const forceRefresh = req.query.refresh === '1';
    await hydrateFromPersistedStore();

    let detailed;
    let allPending = [];

    if (!forceRefresh && Object.keys(detailCache.records).length > 0) {
      // Normal page load: serve straight from the persisted cache, zero Zoho calls
      detailed = Object.values(detailCache.records);
      allPending = detailed; // for the debug field below — no separate list-fetch happened on this path
      console.log(`PMOs: cache hit — ${detailed.length} records, no Zoho calls`);
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
      console.log(`PMOs: fetched ${allPending.length} pending across pages`);

      // Same conservative pre-filter as lib/zoho.js: if the list-level
      // record already includes a usable approvers_list, skip detail
      // calls for anything it clearly shows isn't Jatin's. If
      // approvers_list isn't present at the list level for this module,
      // every item is kept and detail-checked exactly as before — this
      // can only reduce wasted calls, never hide a real pending item.
      const relevantPending = allPending.filter(r =>
        !Array.isArray(r.approvers_list) || isJatinCurrentApprover(r)
      );
      const skipped = allPending.length - relevantPending.length;
      if (skipped > 0) {
        console.log(`PMOs: ${skipped} confirmed not Jatin's at list level (skipped), ${relevantPending.length} to actually check`);
      }

      detailed = [];
      for (let i = 0; i < relevantPending.length; i += 10) {
        const batch   = relevantPending.slice(i, i + 10);
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
        if (i + 10 < relevantPending.length) await new Promise(r => setTimeout(r, 300));
      }

      // Drop cached records no longer in the live, Jatin-relevant pending
      // list (approved/rejected, OR now confirmed to belong to someone
      // else) — this is also what shrinks an existing bloated cache back
      // down once this runs.
      const currentIds = new Set(relevantPending.map(r => r.module_record_id));
      for (const id of Object.keys(detailCache.records)) {
        if (!currentIds.has(id)) { delete detailCache.records[id]; delete detailCache.snapshot[id]; }
      }

      await persistStore();
    }

    const jatinPMOs = detailed.filter(isJatinCurrentApprover);
    console.log(`PMOs: ${jatinPMOs.length} currently pending Jatin's approval`);

    const enriched = jatinPMOs.map(raw => {
      const f = extractFields(raw.module_fields);

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

      const payTypeLabel = [payCategory, paySubCat, payType].filter(Boolean).join(' / ');

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

    enriched.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(b.date) - new Date(a.date);
    });

    return res.status(200).json({
      success: true,
      count:   enriched.length,
      data:    enriched,
      debug: { pending: allPending.length, jatin: jatinPMOs.length },
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
