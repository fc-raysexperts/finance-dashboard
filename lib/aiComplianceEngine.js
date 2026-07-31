// lib/aiComplianceEngine.js
//
// Orchestrates the AI-judged checks for a single PBP (PO/Bill/PMO):
//   1. Compute a fingerprint (has anything relevant changed since we last
//      checked this PBP?). If unchanged, return the cached result — ZERO
//      new API calls. This is what makes hourly auto-refresh cheap.
//   2. For Approval Status specifically, try the fast fuzzy pre-check
//      first (lib/approvalFastCheck.js) — only calls AI if not confident.
//   3. If anything genuinely needs AI judgment, make ONE Gemini call for
//      the whole PBP, with every attachment attached directly (native
//      PDF/image reading — no local OCR/text-extraction needed for this
//      path), asking for structured JSON verdicts on every AI-dependent
//      check at once.
//   4. Cache the result, keyed by the fingerprint, so the next check
//      (even an hour later) is instant unless something actually changed.
//
// HONEST CAVEAT: the actual Gemini call (step 3) has not been tested
// against a live API key in the environment this was built in. Prompt
// wording and JSON-shape parsing are built carefully, but the very first
// real PO processed after deploy is the real test — check its AI-judged
// checks against the real attachment content by hand once.

const crypto = require('crypto');
const { getRealBillType, classifyBillSubtype } = require('./billSubtype');

// RP Sir's approval is a special case: unlike Nidhi Gupta/Rahul Gupta/
// Seema (whose approvals typically show up as clear email/WhatsApp text
// replies), RP Sir's approval is confirmed via an actual physical
// signature on scanned documents — and a mere TEXTUAL claim like
// "approved by RP Sir" in a Remarks/Notes field is explicitly NOT
// sufficient proof on its own (confirmed real case: a PMO whose Remarks
// claimed this, with no genuine signature evidence, should NOT auto-pass).
// This reference image (real cropped samples of his actual signature —
// a short, rough, incomplete mark resembling the Greek letter gamma
// (γ) — like a child's first two-curved-line drawing of a bird —
// ALWAYS in green ink specifically) is sent to
// Gemini alongside the real attachments so it can visually compare any
// signature found in scanned documents against a real reference, rather
// than guessing from text alone.
// RP Sir's approval is a special case: unlike Nidhi Gupta/Rahul Gupta/
// Seema (whose approvals typically show up as clear email/WhatsApp text
// replies), RP Sir's approval is confirmed via an actual physical
// signature on scanned documents — and a mere TEXTUAL claim like
// "approved by RP Sir" in a Remarks/Notes field is explicitly NOT
// sufficient proof on its own. This reference image (real cropped
// samples of his actual signature) is sent to Gemini alongside the real
// attachments so it can visually compare against a real reference.
//
// IMPORTANT: this is embedded as a base64 STRING CONSTANT in its own JS
// module (lib/reference-assets/rpSirSignatureBase64.js), not read from
// disk at runtime. Confirmed real bug from production logs: reading via
// fs.readFileSync(path.join(__dirname, ...)) failed with ENOENT — Next.js
// bundles serverless functions in a way where __dirname does not
// reliably resolve to the real source file location (it resolved to
// 'C:\ROOT\lib' in production, not the actual project path), and static
// assets aren't guaranteed to be included in the function's bundle just
// by living next to the source file. Embedding the data directly in a
// .js module guarantees it travels with the code everywhere — local
// dev, Vercel serverless, anywhere — with zero filesystem access needed.
function getRPSirReferenceImage() {
  try {
    const { RP_SIR_SIGNATURE_BASE64 } = require('./reference-assets/rpSirSignatureBase64');
    if (!RP_SIR_SIGNATURE_BASE64) return null;
    return { fileName: 'RP_SIR_SIGNATURE_REFERENCE.png', base64Data: RP_SIR_SIGNATURE_BASE64 };
  } catch (e) {
    console.error('Could not load RP Sir signature reference image:', e.message);
    return null;
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Confirmed via real AI Studio rate-limit data: gemini-3.1-flash-lite
// allows 15 requests/minute on the free tier. Spacing calls 4.5 seconds
// apart keeps us at ~13/minute, safely under that with margin.
const MIN_MS_BETWEEN_GEMINI_CALLS = 4500;

// Real bug found and fixed here: POs and PMOs share ONE Gemini API key
// (GEMINI_API_KEY_PO_PMO) — but each tab's batch processor previously
// paced itself using its OWN in-memory `lastCallTime` variable. Since
// pos.js and pmos.js run as separate serverless invocations (or at
// minimum separate async call stacks), neither one can see the other's
// calls at all — meaning if both tabs happened to run their AI batches
// around the same time, the ACTUAL combined rate against the one shared
// key could reach roughly double the per-tab pacing (confirmed real
// symptom: up to ~26 calls/min against a real 15/min quota, causing
// some PBPs to silently never get checked on a given refresh). This
// uses a KV-persisted shared timestamp so BOTH tabs coordinate against
// the real combined rate, not just their own local view of it.
//
// 5500ms between ANY combined PO+PMO call keeps the true combined rate
// at max ~10.9/min — safely under the real 15/min limit, with generous
// margin. This margin is deliberately wider than the bare minimum
// needed, because of an honest, confirmed limitation: this uses simple
// KV get-then-set, not an atomic compare-and-swap, so there's a real
// (if narrow) race window where two near-simultaneous calls from POs
// and PMOs could both read "clear" before either writes back, letting
// both slip through together. Direct testing confirmed this can happen
// for the very FIRST pair of concurrent calls in a batch, but every
// call after that correctly serializes at the intended gap — so this
// substantially fixes the systemic, continuous ~2x overrun that existed
// before (each tab pacing only against itself), even though it isn't a
// mathematically perfect distributed lock.
const SHARED_PO_PMO_MIN_GAP_MS = 5500;

async function waitForSharedPOPMOSlot() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = (await storeGet(KEYS.GEMINI_PO_PMO_LAST_CALL)) || { lastCallTime: 0 };
    const elapsed = Date.now() - state.lastCallTime;
    if (elapsed >= SHARED_PO_PMO_MIN_GAP_MS) {
      // Claim this slot immediately (optimistic — not a hard distributed
      // lock, but writing the new timestamp right away, before the
      // actual Gemini call happens, means a concurrent process reading
      // this a moment later sees the updated time as soon as possible,
      // minimizing — though not perfectly eliminating — the chance of
      // both processes slipping through in the same narrow window).
      await storeSet(KEYS.GEMINI_PO_PMO_LAST_CALL, { lastCallTime: Date.now() });
      return;
    }
    await sleep((SHARED_PO_PMO_MIN_GAP_MS - elapsed) + 50); // small buffer to further reduce race risk
  }
  // Safety valve: if we somehow couldn't get a clean slot after 8
  // attempts (extremely unlikely), proceed anyway rather than stall
  // forever — better to risk one over-quota call than hang the batch.
}

// Same pattern, same reasoning, for Bills' own separate Gemini key —
// real gap found during multi-org planning (Phase 3): once 4
// organizations' Bills tabs all share GEMINI_API_KEY_BILLS, the
// existing LOCAL-only pacing inside processAIQueueForBills (a plain
// in-memory variable, reset per invocation) has the exact same
// cross-invocation race the PO/PMO key was already fixed for.
// Deliberately GLOBAL, never org-scoped — tracks the real combined rate
// against the one shared Bills key across ALL organizations.
const SHARED_BILLS_MIN_GAP_MS = 4800;
async function waitForSharedBillsSlot() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const state = (await storeGet(KEYS.GEMINI_BILLS_LAST_CALL)) || { lastCallTime: 0 };
    const elapsed = Date.now() - state.lastCallTime;
    if (elapsed >= SHARED_BILLS_MIN_GAP_MS) {
      await storeSet(KEYS.GEMINI_BILLS_LAST_CALL, { lastCallTime: Date.now() });
      return;
    }
    await sleep((SHARED_BILLS_MIN_GAP_MS - elapsed) + 50);
  }
}

const axios = require('axios');
const { getAccessToken } = require('./zohoToken');
const { storeGet, storeSet, KEYS, orgScopedKey } = require('./store');
const { getOrgId } = require('./subsidiaries');
const { callGeminiWithDocuments } = require('./geminiClient');
// NOTE: the local fuzzy-match fast-path (lib/approvalFastCheck.js) is
// deliberately NOT used anymore. It was found unreliable in practice —
// it can't recognize open-ended phrasing like "Go with jd mudhyal" as
// approval, and showing a locally-guessed answer risked being
// confidently wrong. Approval Status now always goes to the AI, no
// local shortcut, matching every other AI-judged check.

// Checks that genuinely need AI judgment for a PO (per the detailed,
// check-by-check audit done earlier in this project). PR Matching (27)
// folded in here too, per the "1 call covers everything" decision — no
// reason to keep a separate local-regex-only path for it once every
// attachment is already being sent to the AI anyway.
const AI_CHECK_IDS_PO = [
  'advance_clarification', 'ld_clause', 'ld_consistency', 'warranty',
  'serial_mapping', 'logistics', 'tds', 'notes_tc', 'pr_match', 'approval_status',
  'delivery_confirmation',
];

function buildFingerprint(pbp) {
  const parts = [
    pbp.notes || '',
    pbp.terms || '',
    JSON.stringify((pbp.documents || []).map(d => d.document_id || d.documentId).sort()),
    JSON.stringify((pbp.approvers_list || []).map(a => `${a.approver_email || a.approver_id}:${a.has_approved}`)),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

async function fetchAttachmentBase64(documentId, orgKey = 'rays') {
  const token = await getAccessToken();
  const response = await axios.get(`https://www.zohoapis.in/books/v3/documents/${documentId}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: getOrgId(orgKey) },
    responseType: 'arraybuffer',
  });
  return Buffer.from(response.data).toString('base64');
}

function buildPOPrompt(po) {
  const lineItemsSummary = (po.line_items || [])
    .map(l => `- ${l.name || 'Item'}: qty ${l.quantity ?? '?'}, rate ₹${l.rate ?? '?'}, total ₹${l.item_total ?? '?'}`)
    .join('\n') || '(no line items on record)';

  const approversList = po.approvers_list || [];
  const approverSummary = approversList.length > 0
    ? approversList.map(a => `- ${a.approver_email || a.approver_id}: ${a.has_approved ? 'has approved in Zoho' : 'has NOT approved in Zoho yet'}`).join('\n')
    : '(Zoho has no in-app approver workflow data for this PO — approval, if any, likely happened over email/WhatsApp instead)';

  return `You are a meticulous compliance reviewer for a solar EPC company (Rays Power Experts Ltd.)'s Purchase Order approval workflow. Your judgments directly affect real financial approval decisions, so accuracy and honesty matter more than being agreeable — if evidence is genuinely absent or ambiguous, say so plainly rather than guessing favorably.

=== PO CONTEXT (from Zoho Books, already-structured data — treat this as ground truth for these fields) ===
PO Number: ${po.purchaseorder_number || 'unknown'}
Vendor: ${po.vendor_name || 'unknown'}
Total: ₹${(po.total || 0).toLocaleString('en-IN')}
Notes (Zoho's own Notes field): ${po.notes ? `"${po.notes}"` : '(empty)'}
Terms & Conditions (Zoho's own Terms field): ${po.terms ? `"${po.terms}"` : '(empty)'}
Line items:
${lineItemsSummary}
Zoho's own approver workflow status:
${approverSummary}

=== ATTACHMENTS ===
Attached below are this PO's supporting documents. Some may be scanned/photographed documents (read them as images — the text may not be selectable/native, look at the visual content directly). Some may be printed emails — read the nested "On [date], X wrote:" quoting structure carefully to know WHO said WHAT; the most recent/outermost message is usually the latest reply, and earlier nested quotes are what it's replying to. Some may be WhatsApp screenshots — the sender is shown by bubble position and color (typically right-aligned/green = the phone's owner, left-aligned/white = the other party); use this to correctly attribute each line to its actual speaker, not just guess from context. WhatsApp messages are often written in Hinglish (Hindi words spelled out in Roman/English script, mixed with English) — read and understand this naturally, the way a fluent Hindi-English bilingual speaker would, not just literal English.

=== HOW TO JUDGE — READ THIS CAREFULLY ===
- Do NOT rely on keyword-spotting. Read for actual meaning and context, the way a careful human reviewer would.
- A generic boilerplate clause repeated near-identically on every contract this company issues does NOT count as genuine, case-specific evidence — e.g. "Applicable TDS will be deducted" appearing in standard Terms & Conditions is NOT sufficient evidence that TDS was actually, specifically addressed for THIS transaction; look for something substantive and specific to this PO.
- APPROVAL AUTHORITY IS STRICT — read this carefully: valid approval can ONLY come from Nidhi Gupta (Co-Director), Seema (HoD), or Rahul Gupta (Director), or another person EXPLICITLY identified in the document as holding equivalent decision-making authority (e.g. clearly named as Director/HoD/Owner). A signature, initial, stamp, or mark from ANY other person — a site engineer, supervisor, procurement staff, or any other employee — does NOT constitute approval, no matter how official, formal, or authoritative it looks on the page (e.g. a signature block on a scanned bill is NOT evidence of approval unless you can identify it as genuinely belonging to one of these named authorities). If you cannot clearly identify the approving person's name/identity as one of these specific authorities, treat approval_status as NOT confirmed rather than assuming a generic signature counts.
- Approval and instructions are often phrased informally and don't follow a fixed script. Real examples already seen in this company's actual communications, for calibration:
  - "Go with jd mudhyal" (an instruction naming a vendor) — this DOES count as approval when said by the approving authority in response to a request, even though it doesn't contain the word "approve" at all.
  - "Apprived" — a misspelling of "Approved" — still counts as approval.
  - A reply saying "Yaar i approved it last week only" — counts as approval, even though phrased casually/personally.
  - Do NOT count the original REQUESTER's own message (the person asking for approval) as if it were the approval itself — only the responding authority's reply counts.
  - A question, expression of doubt, or explicit rejection/hold instruction does NOT count as approval, even if the word "approve" appears nearby (e.g. "not approved yet", "hold this, don't approve").
- "DLP" (Defect Liability Period) is EQUIVALENT to a warranty commitment — do not treat it as a separate/different concept from warranty when judging the warranty check.
- If Zoho's own approver workflow (given above) already shows a clear "has approved" status, you can treat that as strong evidence on its own even without a matching attachment — but if it shows "has NOT approved" or no data at all, look at the attachments for evidence of an approval that may have happened outside Zoho's in-app workflow (e.g. over email or WhatsApp).
- If a check genuinely cannot be judged because no relevant attachment or context was provided at all, set "passed": false and say so plainly — do not guess or assume something favorable just because it's not contradicted.

=== CHECKS TO JUDGE ===
1. "ld_clause" — Does a genuine, specific Liquidated Damages / penalty-for-delay clause exist for THIS PO (not just generic boilerplate mentioning the word "penalty" or "LD")?
2. "ld_consistency" — If an LD clause exists, does it specify a concrete percentage and/or duration (not vague)?
3. "warranty" — Is there a genuine warranty/guarantee/DLP commitment for equipment/items in this PO?
4. "serial_mapping" — Is there evidence that serial numbers of equipment are being tracked/mapped for warranty purposes?
5. "logistics" — Is there a named logistics coordinator/SPOC or clear transportation/delivery coordination plan?
6. "tds" — Is TDS applicability genuinely and specifically addressed for this transaction (not just generic "TDS as applicable" boilerplate)?
7. "notes_tc" — Compare the Zoho Notes/Terms shown above against the attachments and the PO's own header data (vendor, amount, dates). Flag anything that looks inconsistent, suspicious, or contradictory (e.g. Notes referencing a different PO number). Do not flag routine boilerplate as a concern.
8. "pr_match" — Is there a genuine Purchase Requisition (PR) reference/number that this PO can be matched against (e.g. "PR-1234", "PR/24-25/001")?
9. "advance_clarification" — If an advance payment is mentioned (in Notes, Terms, or attachments), is there a clear, specific justification for it (not just a vague mention)?
10. "delivery_confirmation" — Is an advance payment involved AND does it specifically amount to a 100% advance (fully paid before dispatch/delivery)? If so, is there a genuine vendor email/document confirming material is ready to dispatch or has been dispatched? If this PO does NOT involve a 100% advance at all, set "passed": true with a comment saying it's not applicable.
11. "approval_status" — Has this order genuinely been approved SPECIFICALLY by Nidhi Gupta (Co-Director), Seema (HoD), or Rahul Gupta (Director), or another person explicitly named/identified as holding equivalent Director/HoD-level authority? A signature or mark from any other employee (site engineer, supervisor, staff) does NOT count, even if it looks official. Quote the specific approving phrase and name the person who said it in your comment — if you cannot identify the approver as one of these specific authorities, set "passed": false.

=== OUTPUT FORMAT ===
Return ONLY a JSON object (no markdown formatting, no code fences, no commentary outside the JSON) in exactly this shape:
{
  "ld_clause": { "passed": true/false, "comment": "one or two sentences explaining what you found and where, quoting the relevant phrase if possible" },
  "ld_consistency": { "passed": true/false, "comment": "..." },
  "warranty": { "passed": true/false, "comment": "..." },
  "serial_mapping": { "passed": true/false, "comment": "..." },
  "logistics": { "passed": true/false, "comment": "..." },
  "tds": { "passed": true/false, "comment": "..." },
  "notes_tc": { "passed": true/false, "comment": "..." },
  "pr_match": { "passed": true/false, "comment": "..." },
  "advance_clarification": { "passed": true/false, "comment": "..." },
  "delivery_confirmation": { "passed": true/false, "comment": "..." },
  "approval_status": { "passed": true/false, "comment": "..." }
}`;
}

// Main entry point — call for each PO. Returns { results: {checkId: {passed,comment}}, fromCache: bool, aiCallMade: bool }
// Throws with .isQuotaExceeded=true if the Gemini key's free-tier limit was hit — caller (the batch processor below) must handle this by stopping further calls, NOT by retrying.
async function getAIComplianceForPO(po, orgKey = 'rays') {
  const poLabel = po.purchaseorder_number || po.purchaseorder_id || 'unknown';
  const fingerprint = buildFingerprint(po);
  const cache = (await storeGet(orgScopedKey(KEYS.AI_COMPLIANCE_CACHE, orgKey))) || {};
  const cacheKey = `po:${po.purchaseorder_id || po.purchaseorder_number}`;
  const cached = cache[cacheKey];

  if (cached && cached.fingerprint === fingerprint) {
    console.log(`[AI][${orgKey}] ${poLabel}: cache HIT (fingerprint unchanged) — ${Object.keys(cached.results || {}).length} checks cached`);
    return { results: cached.results, fromCache: true, aiCallMade: false };
  }

  console.log(`[AI][${orgKey}] ${poLabel}: cache MISS or changed — running fresh check`);

  const docs = po.documents || [];
  console.log(`[AI][${orgKey}] ${poLabel}: ${docs.length} attachment(s) on this PO`);

  const needsAI = docs.length > 0;
  let aiResults = {};
  let aiCallMade = false;

  if (needsAI) {
    const attachments = [];
    for (const d of docs) {
      try {
        const base64Data = await fetchAttachmentBase64(d.document_id || d.documentId, orgKey);
        attachments.push({ fileName: d.file_name || d.fileName || 'attachment', base64Data });
        console.log(`[AI][${orgKey}] ${poLabel}: fetched attachment "${d.file_name || d.fileName}" OK (${base64Data.length} base64 chars)`);
      } catch (e) {
        console.error(`[AI][${orgKey}] ${poLabel}: FAILED to fetch attachment "${d.file_name || d.fileName}" (doc id ${d.document_id || d.documentId}):`, e.message);
      }
    }

    if (attachments.length > 0) {
      // Real fix: wait for a shared slot on the PO/PMO key BEFORE making
      // this call — coordinates against PMO's calls too, since they use
      // the same underlying Gemini key (see waitForSharedPOPMOSlot above).
      // This is deliberately global across ALL organizations, not just
      // this one, since the underlying Gemini key is shared by all of them.
      await waitForSharedPOPMOSlot();
      console.log(`[AI][${orgKey}] ${poLabel}: calling Gemini with ${attachments.length} attachment(s)...`);
      aiResults = await callGeminiWithDocuments({
        tabType: 'po',
        prompt: buildPOPrompt(po),
        attachments,
      });
      aiCallMade = true;
      console.log(`[AI][${orgKey}] ${poLabel}: Gemini responded with keys: [${Object.keys(aiResults).join(', ')}]`);
    } else {
      console.warn(`[AI][${orgKey}] ${poLabel}: has ${docs.length} attachment(s) listed but ALL failed to download — skipping AI call, will retry next run (NOT caching this failure)`);
    }
  } else {
    console.log(`[AI][${orgKey}] ${poLabel}: no attachments at all — nothing for AI to review`);
  }

  const results = {};
  for (const id of AI_CHECK_IDS_PO) {
    if (aiResults[id]) results[id] = aiResults[id];
  }

  // CRITICAL FIX: only cache a result when it's actually meaningful —
  // either genuinely nothing to check (no attachments at all, ever), or
  // the AI call genuinely ran and returned something. If attachments
  // existed but all failed to download, or the AI call was skipped for
  // any other reason, DO NOT cache — this was the real bug: caching an
  // empty/failed outcome as if it were final locked every affected PO
  // into "Pending AI review" permanently, with the fingerprint never
  // changing to trigger a retry, and no visible error since nothing was
  // actually throwing.
  const shouldCache = !needsAI || aiCallMade;
  if (shouldCache) {
    cache[cacheKey] = { fingerprint, results, checkedAt: new Date().toISOString() };
    await storeSet(orgScopedKey(KEYS.AI_COMPLIANCE_CACHE, orgKey), cache);
  } else {
    console.warn(`[AI][${orgKey}] ${poLabel}: NOT caching (attachment fetch failed) — will retry on next check`);
  }

  return { results, fromCache: false, aiCallMade };
}

// Sequential batch processor — used by BOTH the page-load path (pos.js)
// and the hourly cron. Processes POs ONE AT A TIME, in the order given
// (oldest/first-in-list first), updating KEYS.AI_QUEUE_STATUS after each
// one so the dashboard's live status indicator reflects real progress.
//
// Stops early (leaving the rest as "pending") in exactly two cases,
// per explicit instruction — everything else should complete fully:
//   1. Gemini quota/rate-limit hit (isQuotaExceeded) — no point
//      hammering a key that's already out of free calls.
//   2. Running low on time (timeBudgetMs) — protects against exceeding
//      the serverless function's own execution timeout; better to
//      return a partial, honest result than get killed mid-request.
async function processAIQueueForPOs(pos, { timeBudgetMs = 270000 } = {}, orgKey = 'rays') {
  const startTime = Date.now();
  const cache = (await storeGet(orgScopedKey(KEYS.AI_COMPLIANCE_CACHE, orgKey))) || {};

  const toProcess = pos.filter(po => {
    const cacheKey = `po:${po.purchaseorder_id || po.purchaseorder_number}`;
    const cached = cache[cacheKey];
    return !cached || cached.fingerprint !== buildFingerprint(po);
  });

  console.log(`[AI Queue][${orgKey}] ${pos.length} total POs in view, ${toProcess.length} need (re-)checking this run`);

  // Real bug fixed here: when nothing needs (re-)checking, this used to
  // still overwrite the status to total:0 — which hid the "Checked
  // Compliances" button entirely (its visibility is gated on total>0),
  // even though everything was genuinely fully checked moments earlier.
  // Skipping the status write entirely here preserves whatever the last
  // real completed run's status was, so the button correctly stays put.
  if (toProcess.length === 0) {
    return { totalNeeded: 0, processed: 0, stoppedReason: null, completedFully: true };
  }

  await storeSet(orgScopedKey(KEYS.AI_QUEUE_STATUS, orgKey), {
    tabType: 'po', total: toProcess.length, processed: 0,
    currentItem: toProcess[0] ? (toProcess[0].purchaseorder_number || toProcess[0].purchaseorder_id) : null,
    startedAt: new Date().toISOString(), finishedAt: null, stoppedReason: null,
  });

  let processed = 0;
  let stoppedReason = null;
  let lastCallTime = 0;

  for (const po of toProcess) {
    if (Date.now() - startTime > timeBudgetMs) {
      stoppedReason = 'time_budget_exceeded';
      break;
    }

    await storeSet(orgScopedKey(KEYS.AI_QUEUE_STATUS, orgKey), {
      tabType: 'po', total: toProcess.length, processed,
      currentItem: po.purchaseorder_number || po.purchaseorder_id,
      startedAt: new Date().toISOString(), finishedAt: null, stoppedReason: null,
    });

    // Pace real Gemini calls — confirmed real limit is 5/minute, so
    // never let two calls happen closer together than
    // MIN_MS_BETWEEN_GEMINI_CALLS. Only actually waits if the previous
    // iteration made a real API call (lastCallTime gets set below only
    // when aiCallMade is true), so a run full of no-attachment POs
    // doesn't get needlessly slowed down. NOTE: this local pacing is a
    // secondary guard only — the REAL cross-organization/cross-tab
    // protection is waitForSharedPOPMOSlot(), called inside
    // getAIComplianceForPO itself, right before the actual Gemini call.
    if (lastCallTime > 0) {
      const elapsed = Date.now() - lastCallTime;
      if (elapsed < MIN_MS_BETWEEN_GEMINI_CALLS) {
        const waitMs = MIN_MS_BETWEEN_GEMINI_CALLS - elapsed;
        console.log(`[AI Queue][${orgKey}] Pacing: waiting ${Math.round(waitMs/1000)}s before next Gemini call (rate-limit safety)`);
        await sleep(waitMs);
      }
    }

    let quotaRetried = false;
    while (true) {
      try {
        const result = await getAIComplianceForPO(po, orgKey);
        if (result.aiCallMade) lastCallTime = Date.now();
        break;
      } catch (e) {
        if (e.isQuotaExceeded) {
          if (!quotaRetried && (Date.now() - startTime + e.retryAfterMs + 2000) < timeBudgetMs) {
            // Self-heal: Gemini told us exactly how long to wait — do
            // that (plus a small safety margin) and retry this SAME PO
            // once before giving up. This is what actually fixes
            // "worked once then quota-exceeded forever across every
            // restart" — the quota window is tracked on Google's
            // servers, not reset by restarting our own dev server, so
            // waiting it out is the only real fix, not guessing at a
            // fixed pause between test attempts.
            const waitMs = e.retryAfterMs + 2000;
            console.warn(`[AI Queue][${orgKey}] Quota hit on ${po.purchaseorder_number || po.purchaseorder_id} — waiting ${Math.round(waitMs/1000)}s (Gemini's own retry hint) then retrying once`);
            await sleep(waitMs);
            quotaRetried = true;
            continue; // retry the same PO
          }
          console.error(`AI queue[${orgKey}]: Gemini quota exceeded again after retry (or out of time budget) — stopping batch:`, e.message);
          stoppedReason = 'quota_exceeded';
          break;
        }
        console.error(`AI queue[${orgKey}]: failed on PO ${po.purchaseorder_number || po.purchaseorder_id}:`, e.message);
        lastCallTime = Date.now(); // still pace even after a failed call attempt, since it still counted against quota
        break;
      }
    }
    if (stoppedReason) break;

    processed++;
  }

  await storeSet(orgScopedKey(KEYS.AI_QUEUE_STATUS, orgKey), {
    tabType: 'po', total: toProcess.length, processed,
    currentItem: null,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    stoppedReason,
  });

  return { totalNeeded: toProcess.length, processed, stoppedReason, completedFully: stoppedReason === null };
}

// ─────────────────────────────────────────────────────────────
// BILL AI PIPELINE — mirrors the PO pipeline above exactly. Uses
// tabType:'bill' so lib/geminiClient.js routes to GEMINI_API_KEY_BILLS
// (Jatin sir's account), per the account-split plan.
// ─────────────────────────────────────────────────────────────

const AI_CHECK_IDS_BILL = [
  'ld_clause', 'completion_proof', 'grn', 'client_acceptance', 'warranty',
  'bill_no_po', 'retention', 'rcm', 'freight_bills', 'ex_works', 'gstr2b',
  'expense_rp_sir_signoff',
];

function buildBillPrompt(bill, linkedPO) {
  const lineItemsSummary = (bill.line_items || [])
    .map(l => `- ${l.name || 'Item'}: qty ${l.quantity ?? '?'}, rate ₹${l.rate ?? '?'}, total ₹${l.item_total ?? '?'}`)
    .join('\n') || '(no line items on record)';

  // Real, shared subtype detection (lib/billSubtype.js) — same source
  // used by checklistEngine.js, so the two can never drift apart again.
  const realBillType = getRealBillType(bill);
  const billSubtype = classifyBillSubtype(realBillType);
  const needsClassification = !billSubtype;
  // Bill Type is a genuinely optional field in Zoho — employees don't
  // always fill it in. When it's blank, this SAME single Gemini call
  // (not a separate one) also asks Gemini to classify the bill's real
  // subtype from its full context and attachments — the code then uses
  // that classification afterward to decide which subtype-gated checks
  // actually apply, exactly the same way it would if the real field had
  // been filled in. Until we know the subtype, all subtype-gated checks
  // are evaluated (the code filters down to only the applicable ones
  // once the classification comes back).
  const effectiveSubtypeForPrompt = billSubtype || 'to be classified — see instructions below';
  const totalAmt = bill.total || 0;
  const isExpenseUnder3L = billSubtype === 'Expense' && totalAmt < 300000; // only knowable when Bill Type is actually set

  const expenseCategoryContext = billSubtype === 'Expense' ? `

=== EXPENSE BILL CONTEXT ===
This is an Expense-type bill. Real categories these commonly fall under (for your own context, not a rule to apply mechanically): Administrative (office/stationery), Professional & Consultancy (CA/Legal/Audit), Manpower/Labour, Repair & Maintenance, Rent & Lease, Travel & Conveyance, Communication, Utilities, IT & Software, Insurance, Freight & Transportation, Marketing & Advertisement, Bank & Financial Charges, Government/Statutory Fees, Project Expenses, Security & Housekeeping, Training & Recruitment, Interest & Finance Cost, Capital/Fixed Asset Related (may require capitalization rather than expensing), and Miscellaneous.
${isExpenseUnder3L ? `\nThis specific bill is under ₹3,00,000 — for Expense bills below this threshold, company policy requires RP Sir's genuine signature on the attachment specifically, with the signed-off amount matching this bill's invoice amount. See the "expense_rp_sir_signoff" check below.` : ''}` : '';

  const classificationContext = needsClassification ? `

=== BILL TYPE CLASSIFICATION NEEDED ===
This bill's "Bill Type" field was left blank in Zoho Books (a real, common situation — it's optional and not always filled in by whoever submits the bill). Based on everything you can see — the line items, vendor, Notes/Terms, and especially the attachment content — classify which of these 5 real categories this bill actually belongs to: "Service", "Supply", "Supply-FA" (Fixed Assets), "O&M", or "Expense". Return this as "classified_subtype" in your JSON response (exactly one of those 5 strings). Some of the checks below only genuinely apply to certain subtypes — since the subtype isn't known yet, evaluate ALL of them regardless; the system will automatically keep only the ones relevant to whatever subtype you classify this as, and discard the rest — so just judge each one honestly based on what's actually in front of you, without trying to guess which ones "should" apply.` : '';

  const tdsReferenceTable = `

=== TDS REFERENCE TABLE (real company reference — use this to verify the ACTUAL correct section/threshold/rate, not just whether the word "TDS" appears somewhere) ===
| Nature of Payment | Section | Threshold | Rate | Deductee Type |
|---|---|---|---|---|
| Salary | 192 | As per slab | As per Income Tax Slab | Employee |
| Contractor Payment | 194C | ₹30,000 single / ₹1,00,000 yearly | 1% Individual/HUF, 2% Others | Contractor |
| Professional Fees | 194J | ₹50,000 | 10% | Professional |
| Rent – Plant & Machinery | 194I | ₹2,40,000 | 2% | Landlord |
| Rent – Land & Building | 194I | ₹6,00,000 | 10% | Landlord |
| Commission/Brokerage | 194H | ₹15,000 | 2% | Agent/Broker |
| Interest (other than securities) | 194A | ₹40,000 | 10% | Lender |
| Professional Royalty/FTS | 194J | ₹30,000 | 10% | Professional |
| Transporter | 194C | No limit with valid PAN | Nil | Transporter |
| Purchase of Goods | 194Q | ₹50,00,000 | 0.1% | Seller |
| E-commerce Participant | 194O | ₹5,00,000 | 1% | E-commerce Seller |
| Payment to Non-Resident | 195 | No threshold | As per DTAA | Non-Resident |
When judging "tds"-related aspects, use this table to confirm whether the ACTUAL nature of this payment matches a real applicable section/threshold/rate — not just whether TDS is mentioned in passing.`;

  return `You are a meticulous compliance reviewer for a solar EPC company (Rays Power Experts Ltd.)'s Bill approval workflow. Your judgments directly affect real financial approval decisions, so accuracy and honesty matter more than being agreeable — if evidence is genuinely absent or ambiguous, say so plainly rather than guessing favorably.

=== BILL CONTEXT (from Zoho Books, already-structured data — treat this as ground truth for these fields) ===
Bill Number: ${bill.bill_number || 'unknown'} | Date: ${bill.date || 'unknown'} | Due: ${bill.due_date || 'unknown'}
Vendor: ${bill.vendor_name || 'unknown'}
Total: ₹${totalAmt.toLocaleString('en-IN')}
Linked PO: ${linkedPO ? (linkedPO.purchaseorder_number || 'linked') : 'No PO linked — this bill needs management approval + RP Sir sign-off instead'}
Bill Type (real subtype): ${realBillType || 'not set — see classification instructions below'}${billSubtype ? ` → classified as ${billSubtype}` : ''}
Notes (Zoho's own Notes field): ${bill.notes ? `"${bill.notes}"` : '(empty)'}
Terms & Conditions (Zoho's own Terms field): ${bill.terms ? `"${bill.terms}"` : '(empty)'}
Line items:
${lineItemsSummary}${expenseCategoryContext}${classificationContext}${tdsReferenceTable}

=== ATTACHMENTS ===
Attached below are this bill's supporting documents. Some may be scanned/photographed documents (read them as images — the text may not be selectable/native, look at the visual content directly). Some may be printed emails — read the nested "On [date], X wrote:" quoting structure carefully to know WHO said WHAT. Some may be WhatsApp screenshots — the sender is shown by bubble position and color; WhatsApp messages are often written in Hinglish (Hindi words spelled out in Roman/English script, mixed with English) — read and understand this naturally, the way a fluent Hindi-English bilingual speaker would.

=== HOW TO JUDGE — READ THIS CAREFULLY ===
- Do NOT rely on keyword-spotting. Read for actual meaning and context, the way a careful human reviewer would.
- A generic boilerplate clause repeated near-identically on every contract this company issues does NOT count as genuine, case-specific evidence — e.g. a standard "10% retention will be held" clause appearing in routine Terms & Conditions is NOT sufficient evidence that retention was actually, specifically addressed for THIS bill; look for something substantive and specific.
- APPROVAL AUTHORITY IS STRICT (relevant to "bill_no_po" specifically) — valid management approval can ONLY come from Nidhi Gupta (Co-Director), Rahul Gupta (Director), Rajendra Prasad Gupta / "RP Sir" (Head of Finance & Accounting, Rahul Gupta's father — his sign-off is SPECIFICALLY required for bills without a PO, in addition to general management approval), or Seema (HoD), or another person EXPLICITLY identified as holding equivalent authority. A signature, initial, or mark from any other employee does NOT constitute approval, no matter how official it looks.
- RP SIR'S APPROVAL/SIGN-OFF IS A SPECIAL CASE (relevant to "bill_no_po" AND "expense_rp_sir_signoff") — a TEXTUAL claim like "approved by RP Sir" anywhere in the bill/notes is NOT sufficient proof by itself. His approval is confirmed specifically via his physical signature on scanned/photographed documents. A reference image is attached separately (labeled RP_SIR_SIGNATURE_REFERENCE.png) showing real samples of his actual signature. His signature ALWAYS appears in GREEN ink specifically (never any other color), and its shape is a short, rough, incomplete mark most closely resembling the Greek letter gamma (γ) — similar to the two simple curved lines a child draws for their first attempt at a bird. Only mark his sign-off as confirmed if you can visually identify a genuinely matching green-ink, gamma-like signature somewhere in the attachments. A written claim alone, with no matching signature found, must be treated as NOT confirmed.
- "DLP" (Defect Liability Period) is EQUIVALENT to a warranty commitment.
- If a check genuinely cannot be judged because no relevant attachment or context was provided at all, set "passed": false and say so plainly — do not guess or assume something favorable just because it's not contradicted.

=== CHECKS TO JUDGE ===
1. "ld_clause" — Does a genuine, specific Liquidated Damages / penalty-for-delay clause exist for THIS bill/its linked PO (not just generic boilerplate)?
2. "completion_proof" — Is there a genuine milestone/completion certificate, measurement sheet, or GRN evidence (not just "an attachment exists" or a suggestive filename)?
3. "grn" — Does a Goods Receipt Note genuinely appear to confirm material receipt (not just a filename containing "GRN")? Most relevant for Supply/Supply-FA bills; if this is a Service/O&M bill, set "passed": true and note it's not applicable.
4. "client_acceptance" — Is there genuine acceptance/sign-off evidence appropriate to this bill's nature? For a Service or O&M bill, this typically means internal technical sign-off on work completed; for a Supply/Supply-FA bill, this typically means goods inspection/QC acceptance rather than a "client" literally accepting something — judge by whichever kind of evidence actually fits what was billed.
5. "warranty" — Is there a genuine warranty/guarantee/DLP commitment for the billed items (if any require it)?
6. "bill_no_po" — If this bill has no linked PO, is there genuine management approval AND specifically a visually-matching signature from Rajendra Prasad Gupta / "RP Sir" (per the strict visual-match rule above — a textual claim alone is not enough)? If a PO IS linked, set "passed": true and note it's not applicable.
7. "retention" — For service-type bills, is there a genuine, specific 10% retention clause for this bill (not generic boilerplate)?
8. "rcm" — Reverse Charge Mechanism under GST. For RCM-applicable item categories (taxi/transport/rent/advocate fees), is there genuine evidence that RCM was correctly applied/deducted? This is fundamentally item-driven — judge based on what's actually billed, using the bill's subtype (${billSubtype}) only as a soft signal of likelihood, not an absolute rule (e.g. a Service bill could still genuinely have a taxi-reimbursement line item needing RCM).
9. "freight_bills" — If freight/transport items are billed, is genuine supporting documentation (LR/POD/E-Way Bill/weight slip) actually present in content (not just filename)? Freight can legitimately appear on any bill subtype, including Expense.
10. "ex_works" — Are genuine, specific freight-responsibility terms (Ex-Works vs. FOR/freight-included) found in the attachments or context? This is most commonly relevant for Supply/Supply-FA/O&M bills (where physical goods are actually being freighted) and less commonly for Service/Expense bills — use the bill's subtype (${billSubtype || 'unclassified — see above'}) as a soft signal of likelihood only, not an absolute rule; judge based on what's actually in the bill/attachments.
11. "gstr2b" — Search the attachments SPECIFICALLY for a GSTR-2B reconciliation report/screenshot (from Zoho Books' GST Filing module, showing matched/partially matched/unmatched transaction status). Set "documentFound": true only if such a document genuinely appears among the attachments, and in that case set "passed" based on whether THIS bill's invoice appears matched/reconciled. If no such document exists among the attachments, set "documentFound": false and "passed": false with a comment explaining none was found — do NOT guess based on other documents.${isExpenseUnder3L ? `
12. "expense_rp_sir_signoff" — This is an Expense bill under ₹3,00,000. Per company policy, verify RP Sir's genuine signature (per the strict visual-match rule above) is present on the attachment, AND that the amount he signed off on matches this bill's invoice amount (₹${totalAmt.toLocaleString('en-IN')}). Set "passed": true only if both the signature is genuinely present AND the amount matches; note any mismatch clearly in your comment.` : ''}

=== OUTPUT FORMAT ===
Return ONLY a JSON object (no markdown formatting, no code fences, no commentary outside the JSON) in exactly this shape:
{
  "ld_clause": { "passed": true/false, "comment": "..." },
  "completion_proof": { "passed": true/false, "comment": "..." },
  "grn": { "passed": true/false, "comment": "..." },
  "client_acceptance": { "passed": true/false, "comment": "..." },
  "warranty": { "passed": true/false, "comment": "..." },
  "bill_no_po": { "passed": true/false, "comment": "..." },
  "retention": { "passed": true/false, "comment": "..." },
  "rcm": { "passed": true/false, "comment": "..." },
  "freight_bills": { "passed": true/false, "comment": "..." },
  "ex_works": { "passed": true/false, "comment": "..." },
  "gstr2b": { "passed": true/false, "documentFound": true/false, "comment": "..." }${isExpenseUnder3L ? `,
  "expense_rp_sir_signoff": { "passed": true/false, "comment": "..." }` : ''}${needsClassification ? `,
  "classified_subtype": "Service" | "Supply" | "Supply-FA" | "O&M" | "Expense"` : ''}
}`;
}

async function getAIComplianceForBill(bill, linkedPO, orgKey = 'rays') {
  const billLabel = bill.bill_number || bill.bill_id || 'unknown';
  const fingerprint = buildFingerprint(bill);
  const cache = (await storeGet(orgScopedKey(KEYS.AI_COMPLIANCE_CACHE, orgKey))) || {};
  const cacheKey = `bill:${bill.bill_id || bill.bill_number}`;
  const cached = cache[cacheKey];

  if (cached && cached.fingerprint === fingerprint) {
    console.log(`[AI][${orgKey}] ${billLabel}: cache HIT (fingerprint unchanged) — ${Object.keys(cached.results || {}).length} checks cached`);
    return { results: cached.results, fromCache: true, aiCallMade: false };
  }

  console.log(`[AI][${orgKey}] ${billLabel}: cache MISS or changed — running fresh check`);

  const docs = bill.documents || [];
  console.log(`[AI][${orgKey}] ${billLabel}: ${docs.length} attachment(s) on this bill`);

  const needsAI = docs.length > 0;
  let aiResults = {};
  let aiCallMade = false;

  if (needsAI) {
    const attachments = [];
    for (const d of docs) {
      try {
        const base64Data = await fetchAttachmentBase64(d.document_id || d.documentId, orgKey);
        attachments.push({ fileName: d.file_name || d.fileName || 'attachment', base64Data });
        console.log(`[AI][${orgKey}] ${billLabel}: fetched attachment "${d.file_name || d.fileName}" OK (${base64Data.length} base64 chars)`);
      } catch (e) {
        console.error(`[AI][${orgKey}] ${billLabel}: FAILED to fetch attachment "${d.file_name || d.fileName}" (doc id ${d.document_id || d.documentId}):`, e.message);
      }
    }

    if (attachments.length > 0) {
      // Only attach the RP Sir signature reference when it's actually
      // relevant — bill_no_po (the one check that needs it) only
      // applies when there's no linked PO. No point sending it on every
      // single bill when most have a linked PO and don't need it at all.
      if (!linkedPO) {
        const rpSirRef = getRPSirReferenceImage();
        if (rpSirRef) attachments.push(rpSirRef);
      }
      // Real gap closed here as part of Phase 3: wait for a shared slot
      // on the Bills key BEFORE making this call — global across ALL
      // organizations, since they all share GEMINI_API_KEY_BILLS.
      await waitForSharedBillsSlot();
      console.log(`[AI][${orgKey}] ${billLabel}: calling Gemini (Bills key) with ${attachments.length} attachment(s)...`);
      aiResults = await callGeminiWithDocuments({
        tabType: 'bill',
        prompt: buildBillPrompt(bill, linkedPO),
        attachments,
      });
      aiCallMade = true;
      console.log(`[AI][${orgKey}] ${billLabel}: Gemini responded with keys: [${Object.keys(aiResults).join(', ')}]`);
    } else {
      console.warn(`[AI][${orgKey}] ${billLabel}: has ${docs.length} attachment(s) listed but ALL failed to download — skipping AI call, will retry next run (NOT caching this failure)`);
    }
  } else {
    console.log(`[AI][${orgKey}] ${billLabel}: no attachments at all — nothing for AI to review`);
  }

  const results = {};
  for (const id of AI_CHECK_IDS_BILL) {
    if (aiResults[id]) results[id] = aiResults[id];
  }
  // classified_subtype isn't a check result (no passed/comment shape) —
  // it's Gemini's own classification of the bill's real subtype, only
  // present when Bill Type was blank in Zoho and buildBillPrompt asked
  // for it. Carried through separately so runBillCompliance can use it
  // in place of the old crude keyword-guess fallback.
  if (aiResults.classified_subtype) {
    results.classified_subtype = aiResults.classified_subtype;
  }

  const shouldCache = !needsAI || aiCallMade;
  if (shouldCache) {
    cache[cacheKey] = { fingerprint, results, checkedAt: new Date().toISOString() };
    await storeSet(orgScopedKey(KEYS.AI_COMPLIANCE_CACHE, orgKey), cache);
  } else {
    console.warn(`[AI][${orgKey}] ${billLabel}: NOT caching (attachment fetch failed) — will retry on next check`);
  }

  return { results, fromCache: false, aiCallMade };
}

// Sequential batch processor for Bills — identical structure/pacing/
// self-healing quota-retry logic as the PO version above.
async function processAIQueueForBills(bills, linkedPOMap = {}, { timeBudgetMs = 270000 } = {}, orgKey = 'rays') {
  const startTime = Date.now();
  const cache = (await storeGet(orgScopedKey(KEYS.AI_COMPLIANCE_CACHE, orgKey))) || {};

  const toProcess = bills.filter(bill => {
    const cacheKey = `bill:${bill.bill_id || bill.bill_number}`;
    const cached = cache[cacheKey];
    return !cached || cached.fingerprint !== buildFingerprint(bill);
  });

  // Same fix as the PO version above — never overwrite to total:0 just
  // because nothing new needs checking; that would hide the button even
  // though everything was genuinely fully checked already.
  if (toProcess.length === 0) {
    return { totalNeeded: 0, processed: 0, stoppedReason: null, completedFully: true };
  }

  await storeSet(orgScopedKey(KEYS.AI_QUEUE_STATUS_BILL, orgKey), {
    tabType: 'bill', total: toProcess.length, processed: 0,
    currentItem: toProcess[0] ? (toProcess[0].bill_number || toProcess[0].bill_id) : null,
    startedAt: new Date().toISOString(), finishedAt: null, stoppedReason: null,
  });

  let processed = 0;
  let stoppedReason = null;
  let lastCallTime = 0;

  for (const bill of toProcess) {
    if (Date.now() - startTime > timeBudgetMs) {
      stoppedReason = 'time_budget_exceeded';
      break;
    }

    await storeSet(orgScopedKey(KEYS.AI_QUEUE_STATUS_BILL, orgKey), {
      tabType: 'bill', total: toProcess.length, processed,
      currentItem: bill.bill_number || bill.bill_id,
      startedAt: new Date().toISOString(), finishedAt: null, stoppedReason: null,
    });

    // Local pacing here is now a secondary guard only — the REAL
    // cross-organization protection is waitForSharedBillsSlot(), called
    // inside getAIComplianceForBill itself, right before the actual
    // Gemini call (added as part of Phase 3's multi-org work).
    if (lastCallTime > 0) {
      const elapsed = Date.now() - lastCallTime;
      if (elapsed < MIN_MS_BETWEEN_GEMINI_CALLS) {
        const waitMs = MIN_MS_BETWEEN_GEMINI_CALLS - elapsed;
        console.log(`[AI Queue - Bills][${orgKey}] Pacing: waiting ${Math.round(waitMs/1000)}s before next Gemini call (rate-limit safety)`);
        await sleep(waitMs);
      }
    }

    const linkedPO = linkedPOMap[bill.bill_id] || null;
    let quotaRetried = false;
    while (true) {
      try {
        const result = await getAIComplianceForBill(bill, linkedPO, orgKey);
        if (result.aiCallMade) lastCallTime = Date.now();
        break;
      } catch (e) {
        if (e.isQuotaExceeded) {
          if (!quotaRetried && (Date.now() - startTime + e.retryAfterMs + 2000) < timeBudgetMs) {
            const waitMs = e.retryAfterMs + 2000;
            console.warn(`[AI Queue - Bills][${orgKey}] Quota hit on ${bill.bill_number || bill.bill_id} — waiting ${Math.round(waitMs/1000)}s then retrying once`);
            await sleep(waitMs);
            quotaRetried = true;
            continue;
          }
          console.error(`AI queue (Bills)[${orgKey}]: Gemini quota exceeded again after retry (or out of time budget) — stopping batch:`, e.message);
          stoppedReason = 'quota_exceeded';
          break;
        }
        console.error(`AI queue (Bills)[${orgKey}]: failed on Bill ${bill.bill_number || bill.bill_id}:`, e.message);
        lastCallTime = Date.now();
        break;
      }
    }
    if (stoppedReason) break;

    processed++;
  }

  await storeSet(orgScopedKey(KEYS.AI_QUEUE_STATUS_BILL, orgKey), {
    tabType: 'bill', total: toProcess.length, processed,
    currentItem: null,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    stoppedReason,
  });

  return { totalNeeded: toProcess.length, processed, stoppedReason, completedFully: stoppedReason === null };
}

// ─────────────────────────────────────────────────────────────
// PMO AI PIPELINE — only ONE check (material_status) needs AI here,
// per the detailed audit. Uses tabType:'pmo', which lib/geminiClient.js
// already routes to GEMINI_API_KEY_PO_PMO (FC Team's account), same key
// used for POs.
// ─────────────────────────────────────────────────────────────

const AI_CHECK_IDS_PMO = ['material_status', 'authorization'];

function buildPMOPrompt(pmo) {
  const notes = (pmo.remarks || pmo.description || pmo.paymentDetails || '').toLowerCase();
  const payType = String(pmo.payment_type || pmo.payment_category || notes).toLowerCase();
  const isAdvance = payType.includes('advance');
  // Real confirmation from the applicability sheet: Material Status only
  // applies when Payment Sub-Category is "Purchase" — not "Service" —
  // and this holds regardless of Payment Category, which has 4 real,
  // confirmed values: Project, O&M, NPD, Admin. Deliberately
  // Category-agnostic — only the Sub-Category text is checked.
  const isPurchaseCategory = payType.includes('purchase');
  const materialStatusApplies = isAdvance && isPurchaseCategory;
  return `You are a meticulous compliance reviewer for a solar EPC company (Rays Power Experts Ltd.)'s Payment Memo (PMO) approval workflow. Your judgment directly affects a real financial approval decision, so accuracy and honesty matter more than being agreeable — if evidence is genuinely absent or ambiguous, say so plainly rather than guessing favorably.

=== PMO CONTEXT ===
PMO Number: ${pmo.pmo_number || pmo.id || 'unknown'}
Payee: ${pmo.vendor_name || pmo.payee_name || 'unknown'}
Amount: ₹${(pmo.amount || pmo.total || 0).toLocaleString('en-IN')}
Payment Type: ${isAdvance ? 'ADVANCE payment (paid before material dispatch/delivery)' : 'Regular payment'}
Remarks (Zoho's own Remarks field): ${pmo.remarks ? `"${pmo.remarks}"` : '(empty)'}

=== ATTACHMENTS ===
Attached below are this PMO's supporting documents. Some may be scanned/photographed documents (read as images). Some may be printed emails — read the nested "On [date], X wrote:" / reply-quoting structure carefully to know who said what, and who is REPLYING to whom (the original requester's own message is NOT approval — only a reply from the approving authority counts). Some may be WhatsApp screenshots (sender shown by bubble position/color) — these are often in Hinglish (Hindi in Roman script mixed with English); read and understand naturally.

=== HOW TO JUDGE — READ THIS CAREFULLY ===
- APPROVAL AUTHORITY IS STRICT: valid approval can ONLY come from Nidhi Gupta (Co-Director), Rahul Gupta (Director), Rajendra Prasad Gupta / "RP Sir" (Head of Finance & Accounting, Rahul Gupta's father), or Seema (HoD), or another person explicitly identified as holding equivalent Director/HoD-level authority. A reply, signature, or mark from any other employee does NOT constitute approval, no matter how official it looks.
- RP SIR'S APPROVAL IS A SPECIAL CASE — read this carefully: a TEXTUAL claim such as "approved by RP Sir" appearing in the Remarks field, Notes, or anywhere else in the document is NOT sufficient proof by itself that he actually approved it. His approvals are confirmed specifically via his physical signature on scanned/photographed documents. A reference image is attached separately (labeled RP_SIR_SIGNATURE_REFERENCE.png) showing real cropped samples of his actual signature. His signature ALWAYS appears in GREEN ink specifically (never any other color), and its shape is a short, rough, incomplete mark most closely resembling the Greek letter gamma (γ) — similar to the two simple curved lines a child draws for their first attempt at a bird. Only mark his approval as confirmed if you can visually identify a genuinely matching green-ink, gamma-like signature mark somewhere in the attached documents. If the only evidence is someone's written claim that "RP Sir approved this" with no visually matching signature anywhere in the attachments, treat this as NOT confirmed — note in your comment that a textual claim exists but no matching signature was found, so it could not be independently verified.
- The Remarks field above is a real, structured Zoho field written by the submitter. For Nidhi Gupta, Rahul Gupta, or Seema, a specific and credible claim of their approval in Remarks (e.g. naming them and describing what was approved) can count as supporting evidence when combined with other context. This does NOT apply to RP Sir specifically — his approval requires the visual signature match described above, regardless of what Remarks claims.
- Approval is often phrased briefly and informally — a one-word reply like "Approved" directly replying to a request email DOES count, as does an instruction implying approval (e.g. "Go with X" or "proceed"), as long as it's from one of the named authorities above, responding to the actual request (not the requester's own message).
- Do NOT guess favorably — if you cannot clearly identify a genuine approval from one of the named authorities, set "passed": false.

- APPROVAL SUBSTANCE MATTERS MORE THAN LITERAL WORDING — an approval email is often written from the REQUESTER'S perspective (e.g. approving "10 additional Google Workspace user licenses") and will rarely mention the actual billing/invoicing vendor by name, since that's an accounts-department detail the requester wouldn't know. When judging "authorization", compare the SUBSTANCE of what was approved — the amount, quantity, description/purpose, and dates — against this PMO's own amount/remarks, NOT whether the vendor name in this PMO literally appears in the approval email. If the substance clearly matches (same quantity, same product/service, same cost basis, same time period), treat it as approved even if the PMO's vendor name (which may be a reseller/billing entity) never appears in the approval thread at all. Only flag a mismatch if the substance itself is genuinely different (different amount, different purpose, different item entirely) — not merely because the vendor name isn't mentioned.

=== CHECKS TO JUDGE ===
1. "material_status" — ${materialStatusApplies
    ? 'Is there a genuine vendor email/document confirming that the ordered material is ready for dispatch, or has already been dispatched? IMPORTANT: if this PMO is clearly for a SERVICE, SUBSCRIPTION, LICENSE, or other non-physical item (e.g. software licenses, SaaS subscriptions, professional services, utility bills) — there is no physical material to dispatch at all, even though this PMO is tagged as a Purchase-category advance. In that case set "passed": true and note this check does not apply to non-physical items, rather than flagging it as missing evidence. Only require genuine dispatch confirmation when the PMO is actually for physical goods/equipment.'
    : !isAdvance
      ? 'This is not an advance payment, so this check does not apply — set "passed": true and note it\'s not applicable.'
      : 'This PMO\'s Payment Sub-Category is not "Purchase" (i.e. it\'s a Service-category payment), so material dispatch confirmation does not apply — set "passed": true and note it\'s not applicable for Service-category payments.'}
2. "authorization" — Has this PMO genuinely been approved by one of the named authorities above (Nidhi Gupta, Rahul Gupta, RP Sir, or Seema)? Judge by SUBSTANCE per the guidance above (matching amount/description/purpose/dates), not by literal vendor-name matching, and consider the Remarks field as valid evidence when it specifically names one of these authorities approving. Quote the specific approving phrase/claim and name the person who said it in your comment.

=== OUTPUT FORMAT ===
Return ONLY a JSON object (no markdown, no code fences) in exactly this shape:
{
  "material_status": { "passed": true/false, "comment": "..." },
  "authorization": { "passed": true/false, "comment": "..." }
}`;
}

async function getAIComplianceForPMO(pmo, orgKey = 'rays') {
  const pmoLabel = pmo.pmo_number || pmo.id || 'unknown';
  const fingerprint = buildFingerprint(pmo);
  const cache = (await storeGet(orgScopedKey(KEYS.AI_COMPLIANCE_CACHE, orgKey))) || {};
  const cacheKey = `pmo:${pmo.pmo_number || pmo.id}`;
  const cached = cache[cacheKey];

  if (cached && cached.fingerprint === fingerprint) {
    console.log(`[AI][${orgKey}] PMO ${pmoLabel}: cache HIT — ${Object.keys(cached.results || {}).length} checks cached`);
    return { results: cached.results, fromCache: true, aiCallMade: false };
  }

  console.log(`[AI][${orgKey}] PMO ${pmoLabel}: cache MISS or changed — running fresh check`);

  const docs = pmo.documents || pmo.attachments || [];
  const needsAI = docs.length > 0;
  let aiResults = {};
  let aiCallMade = false;

  if (needsAI) {
    const attachments = [];
    for (const d of docs) {
      try {
        const base64Data = await fetchAttachmentBase64(d.document_id || d.documentId, orgKey);
        attachments.push({ fileName: d.file_name || d.fileName || 'attachment', base64Data });
      } catch (e) {
        console.error(`[AI][${orgKey}] PMO ${pmoLabel}: FAILED to fetch attachment:`, e.message);
      }
    }
    if (attachments.length > 0) {
      // Include the RP Sir signature reference image so Gemini can
      // visually compare against it — this is reference material, not
      // one of this PMO's own real documents, so it's added after the
      // real attachments are confirmed to exist.
      const rpSirRef = getRPSirReferenceImage();
      if (rpSirRef) attachments.push(rpSirRef);
      // Real fix: wait for a shared slot on the PO/PMO key BEFORE making
      // this call — coordinates against PO's calls too, since they use
      // the same underlying Gemini key (see waitForSharedPOPMOSlot above).
      // Deliberately global across ALL organizations, not just this one.
      await waitForSharedPOPMOSlot();
      console.log(`[AI][${orgKey}] PMO ${pmoLabel}: calling Gemini (PO/PMO key) with ${attachments.length} attachment(s)...`);
      aiResults = await callGeminiWithDocuments({ tabType: 'pmo', prompt: buildPMOPrompt(pmo), attachments });
      aiCallMade = true;
    } else {
      console.warn(`[AI][${orgKey}] PMO ${pmoLabel}: attachments listed but all failed to download — skipping, will retry next run`);
    }
  }

  const results = {};
  for (const id of AI_CHECK_IDS_PMO) {
    if (aiResults[id]) results[id] = aiResults[id];
  }

  const shouldCache = !needsAI || aiCallMade;
  if (shouldCache) {
    cache[cacheKey] = { fingerprint, results, checkedAt: new Date().toISOString() };
    await storeSet(orgScopedKey(KEYS.AI_COMPLIANCE_CACHE, orgKey), cache);
  }

  return { results, fromCache: false, aiCallMade };
}

async function processAIQueueForPMOs(pmos, { timeBudgetMs = 270000 } = {}, orgKey = 'rays') {
  const startTime = Date.now();
  const cache = (await storeGet(orgScopedKey(KEYS.AI_COMPLIANCE_CACHE, orgKey))) || {};

  // Every PMO needs its 'authorization' check run, not just advance
  // ones — 'material_status' only applies to advance payments, but
  // that's already handled inside buildPMOPrompt/checklistEngine.js, so
  // this gate no longer restricts to advance-only. This also fixes a
  // real mismatch bug: checklistEngine.js's advance-detection falls back
  // to searching the Notes text when payment_type/category are empty,
  // but this gate previously didn't — meaning a PMO detected as
  // "advance" via that Notes fallback would show "Pending AI review"
  // forever, since the batch processor's stricter check silently never
  // queued it at all.
  const toProcess = pmos.filter(pmo => {
    const cacheKey = `pmo:${pmo.pmo_number || pmo.id}`;
    const cached = cache[cacheKey];
    return !cached || cached.fingerprint !== buildFingerprint(pmo);
  });

  if (toProcess.length === 0) {
    return { totalNeeded: 0, processed: 0, stoppedReason: null, completedFully: true };
  }

  await storeSet(orgScopedKey(KEYS.AI_QUEUE_STATUS_PMO, orgKey), {
    tabType: 'pmo', total: toProcess.length, processed: 0,
    currentItem: toProcess[0] ? (toProcess[0].pmo_number || toProcess[0].id) : null,
    startedAt: new Date().toISOString(), finishedAt: null, stoppedReason: null,
  });

  let processed = 0;
  let stoppedReason = null;
  let lastCallTime = 0;

  for (const pmo of toProcess) {
    if (Date.now() - startTime > timeBudgetMs) { stoppedReason = 'time_budget_exceeded'; break; }

    await storeSet(orgScopedKey(KEYS.AI_QUEUE_STATUS_PMO, orgKey), {
      tabType: 'pmo', total: toProcess.length, processed,
      currentItem: pmo.pmo_number || pmo.id,
      startedAt: new Date().toISOString(), finishedAt: null, stoppedReason: null,
    });

    if (lastCallTime > 0) {
      const elapsed = Date.now() - lastCallTime;
      if (elapsed < MIN_MS_BETWEEN_GEMINI_CALLS) await sleep(MIN_MS_BETWEEN_GEMINI_CALLS - elapsed);
    }

    let quotaRetried = false;
    while (true) {
      try {
        const result = await getAIComplianceForPMO(pmo, orgKey);
        if (result.aiCallMade) lastCallTime = Date.now();
        break;
      } catch (e) {
        if (e.isQuotaExceeded) {
          if (!quotaRetried && (Date.now() - startTime + e.retryAfterMs + 2000) < timeBudgetMs) {
            await sleep(e.retryAfterMs + 2000);
            quotaRetried = true;
            continue;
          }
          stoppedReason = 'quota_exceeded';
          break;
        }
        console.error(`AI queue (PMOs)[${orgKey}]: failed on ${pmo.pmo_number || pmo.id}:`, e.message);
        lastCallTime = Date.now();
        break;
      }
    }
    if (stoppedReason) break;
    processed++;
  }

  await storeSet(orgScopedKey(KEYS.AI_QUEUE_STATUS_PMO, orgKey), {
    tabType: 'pmo', total: toProcess.length, processed, currentItem: null,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), stoppedReason,
  });

  return { totalNeeded: toProcess.length, processed, stoppedReason, completedFully: stoppedReason === null };
}

module.exports = {
  getAIComplianceForPO, processAIQueueForPOs, buildFingerprint, AI_CHECK_IDS_PO,
  getAIComplianceForBill, processAIQueueForBills, AI_CHECK_IDS_BILL,
  getAIComplianceForPMO, processAIQueueForPMOs, AI_CHECK_IDS_PMO,
  waitForSharedPOPMOSlot, // reused by lib/pfb/energyRVUNLMatchEngine.js — it shares the same underlying Gemini key
};
