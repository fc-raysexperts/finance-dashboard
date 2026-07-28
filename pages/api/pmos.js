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
import { processAIQueueForPMOs, buildFingerprint } from '../../lib/aiComplianceEngine';
import { getRecentPMOSignatures } from '../../lib/advanceReconcile';
const axios = require('axios');
const { getAccessToken } = require('../../lib/zohoToken');
const { storeGet, storeSet, KEYS, orgScopedKey } = require('../../lib/store');
const { getOrgId, getPMOModuleName } = require('../../lib/subsidiaries');

const JATIN_USER_ID  = '2346113000000742107';
const APPROVER_EMAIL = 'jatin.srivastava@raysexperts.com';

async function zohoGET(path, params = {}, orgKey = 'rays') {
  let token = await getAccessToken();
  const organizationId = getOrgId(orgKey);
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params:  { organization_id: organizationId, ...params }
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

// Real bug fixed here (same class as lib/zoho.js's original issue):
// these used to be plain module-level variables, shared across EVERY
// request regardless of which organization was selected. Now keyed per
// organization — each subsidiary gets its own completely independent
// slot, created on first use. Rays' behavior is unaffected: its slot is
// functionally identical to what the old flat variables provided.
const STATE = {};
function getPMOStateSlot(orgKey) {
  if (!STATE[orgKey]) {
    STATE[orgKey] = {
      detailCache: {},     // id -> full record, ONLY for items confirmed to be Jatin's
      checkedSnapshot: {}, // id -> { modified, isJatin, v } for EVERY item ever checked, tiny
      hydrated: false,     // have we tried loading from KV yet, this process lifetime?
    };
  }
  return STATE[orgKey];
}

// Bumped whenever the SHAPE of what gets extracted/cached changes (like
// this round's module_record_hash breakup fix) — not just whenever the
// underlying Zoho record itself changes. Real bug this fixes: the cache
// only ever compared against the PMO's own last_modified_time in Zoho,
// which has no way to reflect a code change on this end — so every deploy
// that changed extraction logic kept silently serving PRE-FIX cached data
// forever, invisibly, until it was noticed the numbers still looked wrong.
const CACHE_SCHEMA_VERSION = 3; // bumped: also now invalidates any cache built before the persisted-cache schemaVersion check existed at all (see hydrateFromPersistedStore)

async function hydrateFromPersistedStore(orgKey = 'rays') {
  const state = getPMOStateSlot(orgKey);
  if (state.hydrated) return;
  state.hydrated = true;
  try {
    const persisted = await storeGet(orgScopedKey(KEYS.ZOHO_DELTA_PMOS, orgKey));
    // Real bug fixed: a cache built BEFORE a real bug fix (e.g. today's
    // PMO module-name correction) can persist its wrong/incomplete
    // results indefinitely — the outer "serve straight from cache, zero
    // Zoho calls" fast-path below only checks whether checkedSnapshot
    // has ANY entries at all, not whether those entries are trustworthy.
    // Confirmed real symptom: Tech's PMOs showed "cache hit — 0 records"
    // on a normal load even after the module-name fix was already
    // live, because a snapshot from before the fix (correctly reflecting
    // 0 records under the OLD, broken module name) was still sitting in
    // KV and looked "non-empty enough" to trust.
    //
    // Rejecting the ENTIRE persisted cache outright whenever its
    // recorded schema version doesn't match the current one (rather than
    // only checking version record-by-record during a deep scan, which
    // never even runs if this fast-path already decided to trust the
    // cache) forces exactly one clean, real re-scan the next time this
    // runs — self-correcting automatically, with no manual per-org
    // Refresh click needed. checkedSnapshot is deliberately left EMPTY
    // in this case (not partially populated), so the fast-path below
    // naturally falls through to a real scan on its own — no changes
    // needed there at all.
    if (persisted && persisted.schemaVersion === CACHE_SCHEMA_VERSION && persisted.checkedSnapshot && Object.keys(persisted.checkedSnapshot).length > 0) {
      Object.assign(state.detailCache, persisted.detailCache || {});
      Object.assign(state.checkedSnapshot, persisted.checkedSnapshot || {});
    }
  } catch { /* KV unavailable — proceed with whatever's in memory */ }
}

async function persistStore(orgKey = 'rays') {
  const state = getPMOStateSlot(orgKey);
  await storeSet(orgScopedKey(KEYS.ZOHO_DELTA_PMOS, orgKey), {
    schemaVersion: CACHE_SCHEMA_VERSION,
    detailCache: state.detailCache,
    checkedSnapshot: state.checkedSnapshot,
  }).catch(() => {});
}

export function extractFields(moduleFields) {
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
    // Real subsidiary selection — same convention as pos.js/bills.js
    // (Phase 2), defaults to 'rays' for full backward compatibility.
    const orgKey = req.query.org || 'rays';
    // Real bug fixed: the PMO custom module's actual API name genuinely
    // differs per organization — confirmed via a live diagnostic call.
    // Rays uses "cm_payment_memos" (plural); Energy/OM use
    // "cm_payment_memo" (singular). This was previously a single
    // hardcoded module-level constant, which is why Energy/OM got a 404
    // — the code was calling an endpoint that genuinely doesn't exist
    // for them under that name.
    const PMO_MODULE = getPMOModuleName(orgKey);
    const forceRefresh = req.query.refresh === '1';
    await hydrateFromPersistedStore(orgKey);
    const state = getPMOStateSlot(orgKey);

    let detailed;

    if (!forceRefresh && Object.keys(state.checkedSnapshot).length > 0) {
      // Normal page load: serve straight from the persisted cache, zero Zoho calls
      detailed = Object.values(state.detailCache);
      console.log(`[${orgKey}] PMOs: cache hit — ${detailed.length} records, no Zoho calls`);
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
        const data = await zohoGET(`/${PMO_MODULE}`, { per_page: 200, page, sort_column: 'last_modified_time', sort_order: 'D' }, orgKey);
        const recs = data.module_records || [];
        scannedCount += recs.length;

        for (const r of recs) {
          const id       = r.module_record_id;
          const modified = r.last_modified_time || '';
          const checked  = state.checkedSnapshot[id];
          if (checked && checked.modified === modified && checked.v === CACHE_SCHEMA_VERSION) {
            stoppedEarly = true;
            break; // this, and everything older after it, is already known, unchanged, AND extracted with current logic
          }
          toFetch.push(r);
        }

        if (stoppedEarly || !data.page_context?.has_more_page) break;
        page++;
        await new Promise(r => setTimeout(r, 200));
      }
      console.log(`[${orgKey}] PMOs: scanned ${scannedCount} records (stopped ${stoppedEarly ? 'early, hit already-known unchanged record' : 'at end of list'}), ${toFetch.length} new/changed to check`);

      // Real bug fixed here — this is the actual root cause of a
      // confirmed real production-only symptom: refreshing the PMOs tab
      // on Vercel never picked up new PMOs no matter how many times it
      // was retried, while local dev (unlimited execution time) always
      // eventually succeeded. Vercel serverless functions have a hard
      // execution time limit; local dev does not. Previously,
      // persistStore() was only ever called ONCE, after the entire
      // toFetch loop finished — meaning if Vercel killed the function
      // partway through detail-fetching + AI-processing several new
      // PMOs, ALL of that work was lost, and the next refresh attempt
      // started completely from zero, hitting the exact same wall again
      // — an infinite retry loop with no way to ever finish. This budget
      // (mirroring the same proven pattern already used in
      // lib/advanceReconcile.js) persists progress incrementally, so an
      // interrupted run keeps whatever it managed to complete, making
      // eventual success possible across multiple refresh attempts
      // instead of restarting from scratch every single time.
      const scanStartTime = Date.now();
      const PMO_SCAN_TIME_BUDGET_MS = 90000; // leaves real headroom for the AI-processing step that still runs after this
      let timeBudgetHit = false;

      if (toFetch.length > 0) {
        for (let i = 0; i < toFetch.length; i += 10) {
          if (Date.now() - scanStartTime > PMO_SCAN_TIME_BUDGET_MS) {
            timeBudgetHit = true;
            console.warn(`[${orgKey}] PMOs: time budget (${PMO_SCAN_TIME_BUDGET_MS}ms) reached after ${i}/${toFetch.length} — persisting partial progress now, remaining PMOs will be picked up on the next refresh`);
            break;
          }
          const batch = toFetch.slice(i, i + 10);
          await Promise.all(batch.map(async r => {
            const id       = r.module_record_id;
            const modified = r.last_modified_time || '';
            // Only PMOs (status === 'pending_approval') matter at all —
            // anything else just gets a tiny "checked, not relevant"
            // marker so it's instantly skippable if seen again.
            if (r.status !== 'pending_approval') {
              state.checkedSnapshot[id] = { modified, isJatin: false, v: CACHE_SCHEMA_VERSION };
              delete state.detailCache[id];
              return;
            }
            try {
              // CONFIRMED via an actual captured API response body (not
              // guessed): the real entered PO/Expense Breakup rows live in
              // module_record_hash — a THIRD top-level object, sibling to
              // module_record, that nothing in this codebase was reading
              // before. Real structure per row: cf_po_number,
              // cf_po_number_formatted, cf_basic_amount, cf_tax_amount,
              // cf_adjustment, cf_total (each with a matching _formatted
              // display-string counterpart). The earlier include=html
              // theory was wrong — confirmed no html key ever appears in
              // this response — so that param is dropped.
              const det       = await zohoGET(`/${PMO_MODULE}/${id}`, {}, orgKey);
              const record    = det.data?.module_record || det.module_record || det;
              const recordHash = det.module_record_hash || det.data?.module_record_hash || {};
              record.__breakupSource = recordHash; // stashed for extraction below, not sent to frontend
              const isJatin = isJatinCurrentApprover(record);
              state.checkedSnapshot[id] = { modified, isJatin, v: CACHE_SCHEMA_VERSION };
              if (isJatin) state.detailCache[id] = record;
              else delete state.detailCache[id]; // never keep full detail for anyone else's
            } catch { /* leave unmarked — will be retried next refresh */ }
          }));
          // Persist incrementally after EVERY batch, not just at the
          // very end — this is the real fix. Even a single batch's worth
          // of progress surviving an interruption is far better than
          // losing everything.
          await persistStore(orgKey);
          if (i + 10 < toFetch.length && !timeBudgetHit) await new Promise(r => setTimeout(r, 300));
        }
      }

      if (!timeBudgetHit) await persistStore(orgKey); // final save — harmless no-op if the loop above already covered everything

      // detailCache only ever contains Jatin's own by construction now
      detailed = Object.values(state.detailCache);
    }

    const jatinPMOs = detailed;
    console.log(`[${orgKey}] PMOs: ${jatinPMOs.length} currently pending Jatin's approval`);

    // Real, confirmed (though undocumented) endpoint for a PMO's native
    // "Supporting Attachments" — found by inspecting Zoho Books' own web
    // UI network requests directly, since this isn't in their public API
    // docs at all (confirmed via docs.zoho.com — custom modules only
    // document Create/List/Update/Delete for module+records, nothing for
    // attachments). Fetched ONCE per PMO here and shared across both the
    // AI pre-pass and the full display enrichment below, so this doesn't
    // double the number of real API calls.
    async function fetchPMOSupportingAttachments(pmoRecordId) {
      try {
        const data = await zohoGET(`/${PMO_MODULE}/${pmoRecordId}/attachment`, {}, orgKey);
        // Structure not documented anywhere — logging the raw shape on
        // first real use so we can confirm/correct field names below.
        const list = data.documents || data.attachments || data.data || (Array.isArray(data) ? data : []);
        return list.map(d => ({
          document_id: d.document_id || d.attachment_id || d.file_id || d.id,
          file_name:   d.file_name || d.attachment_name || d.name || 'Supporting Attachment',
        })).filter(d => d.document_id);
      } catch (e) {
        console.error(`Could not fetch Supporting Attachments for PMO ${pmoRecordId}:`, e.message);
        return [];
      }
    }
    const supportingDocsMap = {};
    await Promise.all(jatinPMOs.map(async raw => {
      supportingDocsMap[raw.module_record_id] = await fetchPMOSupportingAttachments(raw.module_record_id);
    }));
    console.log(`[PMO Supporting Attachments] raw response shape (first PMO with any): ${JSON.stringify(Object.entries(supportingDocsMap).find(([,v]) => v.length > 0) || 'none found')}`);
    console.log(`[PMO Supporting Attachments] counts: ${jatinPMOs.map(raw => `${raw.record_name || raw.module_record_id}:${(supportingDocsMap[raw.module_record_id]||[]).length}`).join(', ')}`);

    // AI-judged compliance (only material_status needs this) — same
    // blocking design as POs/Bills: never show an un-checked advance PMO.
    // Real bug fixed here: the AI batch was previously given the RAW,
    // unprocessed Zoho records (jatinPMOs) directly — meaning
    // pmo.pmo_number, pmo.documents, pmo.payment_type all read as
    // undefined (real field names/shapes only exist after the
    // extraction below), causing every PMO to collide on the same
    // "pmo:undefined" cache key, log as "PMO unknown", and never
    // actually reach a Gemini call at all. This lightweight synchronous
    // pre-pass extracts the same real fields the full enrichment below
    // uses (kept minimal and separate from that fuller logic to avoid
    // risking any of its already-working behavior), so the AI batch
    // operates on correctly-shaped objects with a stable identity.
    // A PMO actually has TWO separate attachment sources in Zoho,
    // confirmed via a real example (PM/RAYS/26-27/1411): the custom
    // field cf_attachment (always present — the "PI/Bill Attachment")
    // AND Zoho's native document-attachment feature, fetched above via
    // the confirmed real endpoint (optional "Supporting Attachments",
    // e.g. bank details, material spec sheets). Both need to reach the
    // AI in one call.
    function extractPMOKeyFieldsForAI(raw) {
      const f = extractFields(raw.module_fields);
      const payCategory = String(f.cf_payment_category    || '');
      const paySubCat   = String(f.cf_payment_sub_category || '');
      const payType     = String(f.cf_payment_type         || '');
      const attachmentId   = String(f.cf_attachment           || '');
      const attachmentName = String(f.cf_attachment_formatted || '');
      const piBillDoc = attachmentId ? [{ document_id: attachmentId, file_name: attachmentName || 'PI/Bill Attachment' }] : [];
      const supportingDocs = supportingDocsMap[raw.module_record_id] || [];
      return {
        pmo_number:     String(f.cf_pmo_number || raw.record_name || ''),
        id:             raw.module_record_id,
        vendor_name:    String(f.cf_vendor_name || '—'),
        amount:         parseFloat(f.cf_payable_amount) || 0,
        remarks:        String(f.cf_remarks || ''),
        paymentDetails: String(f.cf_payment_details || ''),
        payment_type:   [payCategory, paySubCat, payType].filter(Boolean).join(' / '),
        documents:      [...piBillDoc, ...supportingDocs], // AI sees all of them together, in one call
        approvers_list: raw.approvers_list || [],
      };
    }
    const pmoNormListForAI = jatinPMOs.map(extractPMOKeyFieldsForAI);
    console.log(`[AI PMO pre-pass] doc counts (PI/Bill + Supporting = total): ${pmoNormListForAI.map(p => `${p.pmo_number}:${(p.documents||[]).length}`).join(', ')}`);

    console.time('[TIMING] processAIQueueForPMOs');
    // NOTE: processAIQueueForPMOs doesn't yet consume orgKey (Phase 3,
    // lib/aiComplianceEngine.js) — passed forward so this file won't
    // need touching again once that phase lands.
    const aiQueueResult = await processAIQueueForPMOs(pmoNormListForAI, { timeBudgetMs: 260000 }, orgKey);
    console.timeEnd('[TIMING] processAIQueueForPMOs');
    if (aiQueueResult.stoppedReason) {
      console.warn(`AI queue stopped early for PMOs: ${aiQueueResult.stoppedReason} (${aiQueueResult.processed}/${aiQueueResult.totalNeeded} completed)`);
    }
    const aiCache = (await storeGet(orgScopedKey(KEYS.AI_COMPLIANCE_CACHE, orgKey))) || {};

    // Real historical data for the Duplicate Payment Check — fetched
    // once per request, not once per PMO.
    console.time('[TIMING] getRecentPMOSignatures');
    // NOTE: getRecentPMOSignatures doesn't yet consume orgKey (Phase 4,
    // lib/advanceReconcile.js) — passed forward for the same reason.
    const pmoSignatures = await getRecentPMOSignatures(orgKey).catch(() => []);
    console.timeEnd('[TIMING] getRecentPMOSignatures');

    console.time('[TIMING] enrich all PMOs (map)');
    const enriched = await Promise.all(jatinPMOs.map(async raw => {
      const f = extractFields(raw.module_fields);

      const pmoNumber    = String(f.cf_pmo_number || raw.record_name || '');
      const date         = String(f.cf_pmo_date   || f.cf_payment_date || '');
      // Real bug fixed here: Remarks and Payment Details were being merged
      // into one field via `||`, even though the sample PDF shows these
      // are two genuinely separate fields. Extracted separately now.
      const remarks       = String(f.cf_remarks || '');
      const paymentDetails = String(f.cf_payment_details || '');
      const purpose      = remarks || paymentDetails; // kept for the existing compliance-engine input, which only needs *a* description
      const payTerms     = String(f.cf_payment_terms        || '');
      const payCategory  = String(f.cf_payment_category     || '');
      const paySubCat    = String(f.cf_payment_sub_category  || '');
      const payType      = String(f.cf_payment_type         || '');
      const paymentDate  = String(f.cf_payment_date || f.cf_paid_date || '');
      const amount       = parseFloat(f.cf_payable_amount)  || 0;
      const vendor       = String(f.cf_vendor_name          || '—');
      const customerName = String(f.cf_customer_name        || '');
      const expenseAcct  = String(f.cf_expense_account      || '');
      const closingBal   = parseFloat(f.cf_closing_balance) || 0;
      const attachmentId = String(f.cf_attachment           || '');
      const attachmentName = String(f.cf_attachment_formatted || '');
      // Real second attachment source, confirmed via PM/RAYS/26-27/1411:
      // a PMO can ALSO have Supporting Attachments — separate from the
      // always-present PI/Bill Attachment above — via Zoho's native
      // document-attachment feature, fetched above via the confirmed real endpoint.
      const supportingDocs = supportingDocsMap[raw.module_record_id] || [];

      // Amt vs Bill/PO/Invoice/Expense and the PO Breakup table — exact
      // custom-field names for these can't be confirmed from outside this
      // org's actual Zoho setup, so this tries several plausible names
      // defensively (falls back to empty rather than guessing wrong) and
      // logs the raw field list once per cold start so the real names can
      // be confirmed and locked in precisely next time.
      const amtAgainstBill    = f.cf_amt_against_bill    ?? f.cf_amount_against_bill    ?? null;
      const amtAgainstPO      = f.cf_amt_against_po      ?? f.cf_amount_against_po      ?? null;
      const amtAgainstInvoice = f.cf_amt_against_invoice ?? f.cf_amount_against_invoice ?? null;
      const amtAgainstExpense = f.cf_amt_against_expense ?? f.cf_amount_against_expense ?? null;
      // PO Breakup is very unlikely to be a simple cf_ field given it's a
      // multi-row table (PO Number/Basic/Tax/Total/Adjustment per row) —
      // most likely a related-list/subform on the raw record itself.
      // Confirmed via diagnostic: cf_cm_po_breakup_1 is the real field, and
      // its "table_fields" array is the SCHEMA for this subform's columns
      // — confirmed real column api_names: cf_po_number, cf_basic_amount,
      // cf_tax_amount (inferred from pattern + screenshot), cf_total,
      // cf_adjustment. That diagnostic showed the blank template
      // ("value":"" on each column) though, not this PMO's actual entered
      // rows — so actual row data is read from wherever it turns out to
      // live: most likely breakupField.value itself (if Zoho puts entered
      // rows there instead of in table_fields), or a top-level property on
      // the raw record keyed by the field's own api_name/placeholder
      // (common for Zoho subform values, kept separate from the field's
      // schema definition).
      // CONFIRMED (from an actual captured API response body, not a guess):
      // real PO/Expense Breakup row data lives in raw.__breakupSource
      // (= module_record_hash), each row shaped exactly as:
      // { cf_po_number, cf_po_number_formatted, cf_basic_amount,
      //   cf_tax_amount, cf_adjustment, cf_total, ...+_formatted pairs }
      const breakupSource = raw.__breakupSource || {};

      // Real fix for "sometimes 3 columns, sometimes 6" (confirmed by
      // comparing two different real PMOs): Zoho always returns the FULL
      // set of possible fields per row, but marks an unused one as null or
      // an empty string (e.g. cf_tds was null/"" on a PMO with no TDS,
      // while cf_adjustment had a real -892 on the same row) — it's not
      // that different PMOs use a different schema, it's that each row
      // only reports the columns it actually has a value for. Only include
      // a key on the normalized row when it's genuinely present, so the
      // frontend can render exactly the columns this specific PMO has,
      // never more.
      function isPresent(v) {
        return v !== null && v !== undefined && v !== '' && String(v).toLowerCase() !== 'null';
      }

      const rawPoRows = Array.isArray(breakupSource.cf_cm_po_breakup_1) ? breakupSource.cf_cm_po_breakup_1 : [];
      const poBreakup = rawPoRows.map(r => {
        const row = {};
        if (isPresent(r.cf_po_number_formatted) || isPresent(r.cf_po_number)) row.po_number = r.cf_po_number_formatted || r.cf_po_number;
        if (isPresent(r.cf_basic_amount)) row.basic_amount = Number(r.cf_basic_amount);
        if (isPresent(r.cf_tax_amount))   row.tax_amount   = Number(r.cf_tax_amount);
        if (isPresent(r.cf_tds))          row.tds          = Number(r.cf_tds);
        if (isPresent(r.cf_adjustment))   row.adjustment   = Number(r.cf_adjustment);
        if (isPresent(r.cf_total))        row.total        = Number(r.cf_total);
        return row;
      });

      // Same confirmed structure and same presence-detection logic for
      // Expense Breakup — real field name pattern follows the same
      // cf_cm_{type}_breakup_1 convention, columns can vary the same way.
      const rawExpenseRows = Array.isArray(breakupSource.cf_cm_expense_breakup_1) ? breakupSource.cf_cm_expense_breakup_1 : [];
      const expenseBreakup = rawExpenseRows.map(r => {
        const row = {};
        if (isPresent(r.cf_expense_detail)) row.expense_detail = r.cf_expense_detail;
        if (isPresent(r.cf_basic_amount))   row.basic_amount   = Number(r.cf_basic_amount);
        if (isPresent(r.cf_tax_amount))     row.tax_amount     = Number(r.cf_tax_amount);
        if (isPresent(r.cf_tds))            row.tds            = Number(r.cf_tds);
        if (isPresent(r.cf_adjustment))     row.adjustment     = Number(r.cf_adjustment);
        if (isPresent(r.cf_total))          row.total          = Number(r.cf_total);
        return row;
      });

      const payTypeLabel = [payCategory, paySubCat, payType].filter(Boolean).join(' / ');

      const pmoNorm = {
        pmo_number:        pmoNumber,
        id:                raw.module_record_id,
        date,
        vendor_name:       vendor,
        amount,
        description:       purpose,
        remarks,
        paymentDetails,
        payment_type:      payTypeLabel,
        documents:         [
          ...(attachmentId ? [{ document_id: attachmentId, file_name: attachmentName || 'PI/Bill Attachment' }] : []),
          ...supportingDocs,
        ],
        submitted_by_name: raw.submitted_by_name || '',
        closing_balance:   closingBal,
        approvers_list:    raw.approvers_list || [],
        poBreakup,
        expenseBreakup,
      };

      const aiCacheKeyPMO   = `pmo:${pmoNorm.pmo_number || pmoNorm.id}`;
      const aiCacheEntryPMO = aiCache[aiCacheKeyPMO];
      const aiFingerprintPMO = buildFingerprint(pmoNorm);
      const aiResultsForThisPMO = (aiCacheEntryPMO && aiCacheEntryPMO.fingerprint === aiFingerprintPMO) ? aiCacheEntryPMO.results : {};
      const compliance = await runPMOCompliance(pmoNorm, pmoSignatures, aiResultsForThisPMO);
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
        remarks,
        paymentDetails,
        paymentDate,
        amtAgainstBill, amtAgainstPO, amtAgainstInvoice, amtAgainstExpense,
        poBreakup,
        expenseBreakup,
        payTypeLabel,
        customerName,
        expenseAccount:  expenseAcct,
        closingBalance:  closingBal,
        attachmentId,
        attachmentName,
        submittedBy:     raw.submitted_by_name || '',
        submittedDate:   raw.submitted_date    || '',
        status:          raw.status,
        // Two real, distinct categories (confirmed via PM/RAYS/26-27/1411):
        piBillDocs:    attachmentId ? [{ document_id: attachmentId, file_name: attachmentName || 'PI/Bill Attachment' }] : [],
        supportingDocs: supportingDocs,
        docs:            [
          ...(attachmentId ? [{ document_id: attachmentId, file_name: attachmentName || 'PI/Bill Attachment' }] : []),
          ...supportingDocs,
        ], // combined — kept for the pmo_docs "Supporting Documents" check and anything else expecting one flat list
        lineItems:       [],
        complianceStatus: compStatus,
        alignmentStatus:  alignment.status,
        compliance,
        alignment,
        recommendation:  buildRec(compStatus, compliance),
      };
    }));
    console.timeEnd('[TIMING] enrich all PMOs (map)');

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
      aiQueue: { completedFully: aiQueueResult.completedFully, processed: aiQueueResult.processed, totalNeeded: aiQueueResult.totalNeeded, stoppedReason: aiQueueResult.stoppedReason },
    });

  } catch (err) {
    const status = err.response?.status;
    console.error(`[${req.query.org || 'rays'}] PMOs API error (Zoho status ${status || 'n/a'}):`, err.message);
    // A 404 or 403 here most likely means the "Payment Memos" custom
    // module (cm_payment_memos) simply doesn't exist yet for this
    // specific organization — custom modules are configured PER-ORG in
    // Zoho Books, not shared automatically across sibling orgs under the
    // same account, even though they share one login/refresh token. This
    // is a real, likely-permanent situation for a newly-added
    // organization until that module is actually set up in Zoho Books
    // itself — not a transient error worth an ambiguous generic message.
    if (status === 404 || status === 403) {
      return res.status(200).json({
        success: true,
        data: [],
        moduleUnavailable: true,
        error: `The "Payment Memos" module doesn't appear to be set up yet for this organization in Zoho Books (received a ${status} from Zoho). This is expected for a newly-added organization until that custom module is configured there.`,
        aiQueue: { completedFully: true, processed: 0, totalNeeded: 0, stoppedReason: null },
      });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
}

function buildRec(status, checks) {
  // Real fix: was `!c.passed`, which would silently exclude the new
  // 'no-evidence' state (a truthy string) from Recommendation reasons.
  const isConcern = c => c.passed !== true && c.passed !== 'uncertain';
  const failed = checks.filter(isConcern);
  // Real bug fixed: several checks can genuinely share the exact same
  // comment (e.g. both AI checks on a PMO with zero attachments both say
  // "No attachment is present...") — dedupe before listing as reasons.
  const dedupe = (arr) => [...new Set(arr)];
  if (status === 'fail') return { decision:'REJECT',          color:'red',   reasons: dedupe(failed.map(c => c.comment)) };
  if (status === 'warn') return { decision:'FLAG FOR REVIEW', color:'amber', reasons: dedupe(failed.map(c => c.comment)) };
  return { decision:'APPROVE', color:'green', reasons: ['All PMO compliance checks passed'] };
}
