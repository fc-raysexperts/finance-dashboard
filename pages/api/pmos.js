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

const detailCache     = {}; // id -> full record, ONLY for items confirmed to be Jatin's
const checkedSnapshot = {}; // id -> { modified, isJatin } for EVERY item ever checked, tiny
let hydrated = false; // have we tried loading from KV yet, this process lifetime?

async function hydrateFromPersistedStore() {
  if (hydrated) return;
  hydrated = true;
  try {
    const persisted = await storeGet(KEYS.ZOHO_DELTA_PMOS);
    // checkedSnapshot is the new shape — an old persisted cache (pre-
    // redesign) won't have it, so it's treated as nothing usable yet and
    // this does one clean bootstrap under the new, much smaller structure.
    if (persisted && persisted.checkedSnapshot && Object.keys(persisted.checkedSnapshot).length > 0) {
      Object.assign(detailCache, persisted.detailCache || {});
      Object.assign(checkedSnapshot, persisted.checkedSnapshot || {});
    }
  } catch { /* KV unavailable — proceed with whatever's in memory */ }
}

async function persistStore() {
  await storeSet(KEYS.ZOHO_DELTA_PMOS, { detailCache, checkedSnapshot }).catch(() => {});
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

    if (!forceRefresh && Object.keys(checkedSnapshot).length > 0) {
      // Normal page load: serve straight from the persisted cache, zero Zoho calls
      detailed = Object.values(detailCache);
      console.log(`PMOs: cache hit — ${detailed.length} records, no Zoho calls`);
    } else {
      // KEY FIX: confirmed via real production logs that this account's
      // custom-module API returns its FULL history (created_time sorted,
      // descending) with no way to filter server-side by approval status
      // — meaning every refresh was scanning every PMO record that has
      // EVER existed (2,589+ and growing) just to find the ~84 currently
      // pending ones.
      //
      // Sorting by last_modified_time DESCENDING instead fixes this: any
      // record that's new, edited, OR just approved/rejected gets its
      // modified time bumped to right now, so it always sorts before
      // anything genuinely untouched since the last check. That means we
      // can stop paginating the SECOND we hit a record we already know
      // about at the exact same modified time — everything after that
      // point (older modified time) must also still be unchanged, by
      // definition. Normal day-to-day activity should now cost roughly
      // 1 page instead of 13.
      //
      // One known, accepted trade-off: a PMO record that's hard-deleted
      // (not approved/rejected, actually deleted) wouldn't bump anything's
      // modified time, so its tiny leftover marker could linger
      // harmlessly in the cache rather than being pruned immediately —
      // a few bytes, not a real cost, and self-corrects if it ever gets
      // touched again.
      const toFetch = [];
      let page = 1;
      let stoppedEarly = false;
      let scannedCount = 0;
      while (true) {
        const data = await zohoGET(`/${PMO_MODULE}`, { per_page: 200, page, sort_column: 'last_modified_time', sort_order: 'D' });
        const recs = data.module_records || [];
        scannedCount += recs.length;

        for (const r of recs) {
          const id       = r.module_record_id;
          const modified = r.last_modified_time || '';
          const checked  = checkedSnapshot[id];
          if (checked && checked.modified === modified) {
            stoppedEarly = true;
            break; // this, and everything older after it, is already known and unchanged
          }
          toFetch.push(r);
        }

        if (stoppedEarly || !data.page_context?.has_more_page) break;
        page++;
        await new Promise(r => setTimeout(r, 200));
      }
      console.log(`PMOs: scanned ${scannedCount} records (stopped ${stoppedEarly ? 'early, hit already-known unchanged record' : 'at end of list'}), ${toFetch.length} new/changed to check`);

      if (toFetch.length > 0) {
        for (let i = 0; i < toFetch.length; i += 10) {
          const batch = toFetch.slice(i, i + 10);
          await Promise.all(batch.map(async r => {
            const id       = r.module_record_id;
            const modified = r.last_modified_time || '';
            // Only PMOs (status === 'pending_approval') matter at all —
            // anything else just gets a tiny "checked, not relevant"
            // marker so it's instantly skippable if seen again.
            if (r.status !== 'pending_approval') {
              checkedSnapshot[id] = { modified, isJatin: false };
              delete detailCache[id];
              return;
            }
            try {
              const det     = await zohoGET(`/${PMO_MODULE}/${id}`);
              const record  = det.data?.module_record || det.module_record || det;
              const isJatin = isJatinCurrentApprover(record);
              checkedSnapshot[id] = { modified, isJatin };
              if (isJatin) detailCache[id] = record;
              else delete detailCache[id]; // never keep full detail for anyone else's
            } catch { /* leave unmarked — will be retried next refresh */ }
          }));
          if (i + 10 < toFetch.length) await new Promise(r => setTimeout(r, 300));
        }
      }

      await persistStore();

      // detailCache only ever contains Jatin's own by construction now
      detailed = Object.values(detailCache);
    }

    const jatinPMOs = detailed;
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
      debug: { pending: detailed.length, jatin: jatinPMOs.length },
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
