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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Confirmed via real AI Studio rate-limit data: gemini-3.1-flash-lite
// allows 15 requests/minute on the free tier. Spacing calls 4.5 seconds
// apart keeps us at ~13/minute, safely under that with margin.
const MIN_MS_BETWEEN_GEMINI_CALLS = 4500;
const axios = require('axios');
const { getAccessToken } = require('./zohoToken');
const { storeGet, storeSet, KEYS } = require('./store');
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

async function fetchAttachmentBase64(documentId) {
  const token = await getAccessToken();
  const response = await axios.get(`https://www.zohoapis.in/books/v3/documents/${documentId}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID },
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
async function getAIComplianceForPO(po) {
  const poLabel = po.purchaseorder_number || po.purchaseorder_id || 'unknown';
  const fingerprint = buildFingerprint(po);
  const cache = (await storeGet(KEYS.AI_COMPLIANCE_CACHE)) || {};
  const cacheKey = `po:${po.purchaseorder_id || po.purchaseorder_number}`;
  const cached = cache[cacheKey];

  if (cached && cached.fingerprint === fingerprint) {
    console.log(`[AI] ${poLabel}: cache HIT (fingerprint unchanged) — ${Object.keys(cached.results || {}).length} checks cached`);
    return { results: cached.results, fromCache: true, aiCallMade: false };
  }

  console.log(`[AI] ${poLabel}: cache MISS or changed — running fresh check`);

  const docs = po.documents || [];
  console.log(`[AI] ${poLabel}: ${docs.length} attachment(s) on this PO`);

  const needsAI = docs.length > 0;
  let aiResults = {};
  let aiCallMade = false;

  if (needsAI) {
    const attachments = [];
    for (const d of docs) {
      try {
        const base64Data = await fetchAttachmentBase64(d.document_id || d.documentId);
        attachments.push({ fileName: d.file_name || d.fileName || 'attachment', base64Data });
        console.log(`[AI] ${poLabel}: fetched attachment "${d.file_name || d.fileName}" OK (${base64Data.length} base64 chars)`);
      } catch (e) {
        console.error(`[AI] ${poLabel}: FAILED to fetch attachment "${d.file_name || d.fileName}" (doc id ${d.document_id || d.documentId}):`, e.message);
      }
    }

    if (attachments.length > 0) {
      console.log(`[AI] ${poLabel}: calling Gemini with ${attachments.length} attachment(s)...`);
      aiResults = await callGeminiWithDocuments({
        tabType: 'po',
        prompt: buildPOPrompt(po),
        attachments,
      });
      aiCallMade = true;
      console.log(`[AI] ${poLabel}: Gemini responded with keys: [${Object.keys(aiResults).join(', ')}]`);
    } else {
      console.warn(`[AI] ${poLabel}: has ${docs.length} attachment(s) listed but ALL failed to download — skipping AI call, will retry next run (NOT caching this failure)`);
    }
  } else {
    console.log(`[AI] ${poLabel}: no attachments at all — nothing for AI to review`);
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
    await storeSet(KEYS.AI_COMPLIANCE_CACHE, cache);
  } else {
    console.warn(`[AI] ${poLabel}: NOT caching (attachment fetch failed) — will retry on next check`);
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
async function processAIQueueForPOs(pos, { timeBudgetMs = 270000 } = {}) {
  const startTime = Date.now();
  const cache = (await storeGet(KEYS.AI_COMPLIANCE_CACHE)) || {};

  const toProcess = pos.filter(po => {
    const cacheKey = `po:${po.purchaseorder_id || po.purchaseorder_number}`;
    const cached = cache[cacheKey];
    return !cached || cached.fingerprint !== buildFingerprint(po);
  });

  console.log(`[AI Queue] ${pos.length} total POs in view, ${toProcess.length} need (re-)checking this run`);

  // Real bug fixed here: when nothing needs (re-)checking, this used to
  // still overwrite the status to total:0 — which hid the "Checked
  // Compliances" button entirely (its visibility is gated on total>0),
  // even though everything was genuinely fully checked moments earlier.
  // Skipping the status write entirely here preserves whatever the last
  // real completed run's status was, so the button correctly stays put.
  if (toProcess.length === 0) {
    return { totalNeeded: 0, processed: 0, stoppedReason: null, completedFully: true };
  }

  await storeSet(KEYS.AI_QUEUE_STATUS, {
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

    await storeSet(KEYS.AI_QUEUE_STATUS, {
      tabType: 'po', total: toProcess.length, processed,
      currentItem: po.purchaseorder_number || po.purchaseorder_id,
      startedAt: new Date().toISOString(), finishedAt: null, stoppedReason: null,
    });

    // Pace real Gemini calls — confirmed real limit is 5/minute, so
    // never let two calls happen closer together than
    // MIN_MS_BETWEEN_GEMINI_CALLS. Only actually waits if the previous
    // iteration made a real API call (lastCallTime gets set below only
    // when aiCallMade is true), so a run full of no-attachment POs
    // doesn't get needlessly slowed down.
    if (lastCallTime > 0) {
      const elapsed = Date.now() - lastCallTime;
      if (elapsed < MIN_MS_BETWEEN_GEMINI_CALLS) {
        const waitMs = MIN_MS_BETWEEN_GEMINI_CALLS - elapsed;
        console.log(`[AI Queue] Pacing: waiting ${Math.round(waitMs/1000)}s before next Gemini call (rate-limit safety)`);
        await sleep(waitMs);
      }
    }

    let quotaRetried = false;
    while (true) {
      try {
        const result = await getAIComplianceForPO(po);
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
            console.warn(`[AI Queue] Quota hit on ${po.purchaseorder_number || po.purchaseorder_id} — waiting ${Math.round(waitMs/1000)}s (Gemini's own retry hint) then retrying once`);
            await sleep(waitMs);
            quotaRetried = true;
            continue; // retry the same PO
          }
          console.error('AI queue: Gemini quota exceeded again after retry (or out of time budget) — stopping batch:', e.message);
          stoppedReason = 'quota_exceeded';
          break;
        }
        console.error(`AI queue: failed on PO ${po.purchaseorder_number || po.purchaseorder_id}:`, e.message);
        lastCallTime = Date.now(); // still pace even after a failed call attempt, since it still counted against quota
        break;
      }
    }
    if (stoppedReason) break;

    processed++;
  }

  await storeSet(KEYS.AI_QUEUE_STATUS, {
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
];

function buildBillPrompt(bill, linkedPO) {
  const lineItemsSummary = (bill.line_items || [])
    .map(l => `- ${l.name || 'Item'}: qty ${l.quantity ?? '?'}, rate ₹${l.rate ?? '?'}, total ₹${l.item_total ?? '?'}`)
    .join('\n') || '(no line items on record)';

  return `You are a meticulous compliance reviewer for a solar EPC company (Rays Power Experts Ltd.)'s Bill approval workflow. Your judgments directly affect real financial approval decisions, so accuracy and honesty matter more than being agreeable — if evidence is genuinely absent or ambiguous, say so plainly rather than guessing favorably.

=== BILL CONTEXT (from Zoho Books, already-structured data — treat this as ground truth for these fields) ===
Bill Number: ${bill.bill_number || 'unknown'} | Date: ${bill.date || 'unknown'} | Due: ${bill.due_date || 'unknown'}
Vendor: ${bill.vendor_name || 'unknown'}
Total: ₹${(bill.total || 0).toLocaleString('en-IN')}
Linked PO: ${linkedPO ? (linkedPO.purchaseorder_number || 'linked') : 'No PO linked — this bill needs management approval + RP Sir sign-off instead'}
Bill Type: ${bill.bill_type || 'not set'}
Notes (Zoho's own Notes field): ${bill.notes ? `"${bill.notes}"` : '(empty)'}
Terms & Conditions (Zoho's own Terms field): ${bill.terms ? `"${bill.terms}"` : '(empty)'}
Line items:
${lineItemsSummary}

=== ATTACHMENTS ===
Attached below are this bill's supporting documents. Some may be scanned/photographed documents (read them as images — the text may not be selectable/native, look at the visual content directly). Some may be printed emails — read the nested "On [date], X wrote:" quoting structure carefully to know WHO said WHAT. Some may be WhatsApp screenshots — the sender is shown by bubble position and color; WhatsApp messages are often written in Hinglish (Hindi words spelled out in Roman/English script, mixed with English) — read and understand this naturally, the way a fluent Hindi-English bilingual speaker would.

=== HOW TO JUDGE — READ THIS CAREFULLY ===
- Do NOT rely on keyword-spotting. Read for actual meaning and context, the way a careful human reviewer would.
- A generic boilerplate clause repeated near-identically on every contract this company issues does NOT count as genuine, case-specific evidence — e.g. a standard "10% retention will be held" clause appearing in routine Terms & Conditions is NOT sufficient evidence that retention was actually, specifically addressed for THIS bill; look for something substantive and specific.
- APPROVAL AUTHORITY IS STRICT (relevant to "bill_no_po" specifically) — valid management approval can ONLY come from Nidhi Gupta (Co-Director), Rahul Gupta (Director), Rajendra Prasad Gupta / "RP Sir" (Head of Finance & Accounting, Rahul Gupta's father — his sign-off is SPECIFICALLY required for bills without a PO, in addition to general management approval), or Seema (HoD), or another person EXPLICITLY identified as holding equivalent authority. A signature, initial, or mark from any other employee does NOT constitute approval, no matter how official it looks.
- "DLP" (Defect Liability Period) is EQUIVALENT to a warranty commitment.
- If a check genuinely cannot be judged because no relevant attachment or context was provided at all, set "passed": false and say so plainly — do not guess or assume something favorable just because it's not contradicted.

=== CHECKS TO JUDGE ===
1. "ld_clause" — Does a genuine, specific Liquidated Damages / penalty-for-delay clause exist for THIS bill/its linked PO (not just generic boilerplate)?
2. "completion_proof" — Is there a genuine milestone/completion certificate, measurement sheet, or GRN evidence (not just "an attachment exists" or a suggestive filename)?
3. "grn" — Does a Goods Receipt Note genuinely appear to confirm material receipt (not just a filename containing "GRN")? If this is a service bill (not goods), set "passed": true and note it's not applicable.
4. "client_acceptance" — For service bills specifically, is there genuine internal technical acceptance/sign-off evidence? If this is a goods bill, set "passed": true and note it's not applicable.
5. "warranty" — Is there a genuine warranty/guarantee/DLP commitment for the billed items (if any require it)?
6. "bill_no_po" — If this bill has no linked PO, is there genuine management approval AND specifically Rajendra Prasad Gupta / "RP Sir"'s sign-off attached (per the strict authority rule above — his sign is required specifically for bills without a PO)? If a PO IS linked, set "passed": true and note it's not applicable.
7. "retention" — For service bills, is there a genuine, specific 10% retention clause for this bill (not generic boilerplate)?
8. "rcm" — For RCM-applicable item categories (taxi/transport/rent/advocate fees), is there genuine evidence that RCM was correctly applied/deducted?
9. "freight_bills" — If freight/transport items are billed, is genuine supporting documentation (LR/POD/E-Way Bill/weight slip) actually present in content (not just filename)?
10. "ex_works" — Are genuine, specific freight-responsibility terms (Ex-Works vs. FOR/freight-included) found in the attachments or context?
11. "gstr2b" — Search the attachments SPECIFICALLY for a GSTR-2B reconciliation report/screenshot (from Zoho Books' GST Filing module, showing matched/partially matched/unmatched transaction status). Set "documentFound": true only if such a document genuinely appears among the attachments, and in that case set "passed" based on whether THIS bill's invoice appears matched/reconciled. If no such document exists among the attachments, set "documentFound": false and "passed": false with a comment explaining none was found — do NOT guess based on other documents.

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
  "gstr2b": { "passed": true/false, "documentFound": true/false, "comment": "..." }
}`;
}

async function getAIComplianceForBill(bill, linkedPO) {
  const billLabel = bill.bill_number || bill.bill_id || 'unknown';
  const fingerprint = buildFingerprint(bill);
  const cache = (await storeGet(KEYS.AI_COMPLIANCE_CACHE)) || {};
  const cacheKey = `bill:${bill.bill_id || bill.bill_number}`;
  const cached = cache[cacheKey];

  if (cached && cached.fingerprint === fingerprint) {
    console.log(`[AI] ${billLabel}: cache HIT (fingerprint unchanged) — ${Object.keys(cached.results || {}).length} checks cached`);
    return { results: cached.results, fromCache: true, aiCallMade: false };
  }

  console.log(`[AI] ${billLabel}: cache MISS or changed — running fresh check`);

  const docs = bill.documents || [];
  console.log(`[AI] ${billLabel}: ${docs.length} attachment(s) on this bill`);

  const needsAI = docs.length > 0;
  let aiResults = {};
  let aiCallMade = false;

  if (needsAI) {
    const attachments = [];
    for (const d of docs) {
      try {
        const base64Data = await fetchAttachmentBase64(d.document_id || d.documentId);
        attachments.push({ fileName: d.file_name || d.fileName || 'attachment', base64Data });
        console.log(`[AI] ${billLabel}: fetched attachment "${d.file_name || d.fileName}" OK (${base64Data.length} base64 chars)`);
      } catch (e) {
        console.error(`[AI] ${billLabel}: FAILED to fetch attachment "${d.file_name || d.fileName}" (doc id ${d.document_id || d.documentId}):`, e.message);
      }
    }

    if (attachments.length > 0) {
      console.log(`[AI] ${billLabel}: calling Gemini (Bills key) with ${attachments.length} attachment(s)...`);
      aiResults = await callGeminiWithDocuments({
        tabType: 'bill',
        prompt: buildBillPrompt(bill, linkedPO),
        attachments,
      });
      aiCallMade = true;
      console.log(`[AI] ${billLabel}: Gemini responded with keys: [${Object.keys(aiResults).join(', ')}]`);
    } else {
      console.warn(`[AI] ${billLabel}: has ${docs.length} attachment(s) listed but ALL failed to download — skipping AI call, will retry next run (NOT caching this failure)`);
    }
  } else {
    console.log(`[AI] ${billLabel}: no attachments at all — nothing for AI to review`);
  }

  const results = {};
  for (const id of AI_CHECK_IDS_BILL) {
    if (aiResults[id]) results[id] = aiResults[id];
  }

  const shouldCache = !needsAI || aiCallMade;
  if (shouldCache) {
    cache[cacheKey] = { fingerprint, results, checkedAt: new Date().toISOString() };
    await storeSet(KEYS.AI_COMPLIANCE_CACHE, cache);
  } else {
    console.warn(`[AI] ${billLabel}: NOT caching (attachment fetch failed) — will retry on next check`);
  }

  return { results, fromCache: false, aiCallMade };
}

// Sequential batch processor for Bills — identical structure/pacing/
// self-healing quota-retry logic as the PO version above.
async function processAIQueueForBills(bills, linkedPOMap = {}, { timeBudgetMs = 270000 } = {}) {
  const startTime = Date.now();
  const cache = (await storeGet(KEYS.AI_COMPLIANCE_CACHE)) || {};

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

  await storeSet(KEYS.AI_QUEUE_STATUS_BILL, {
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

    await storeSet(KEYS.AI_QUEUE_STATUS_BILL, {
      tabType: 'bill', total: toProcess.length, processed,
      currentItem: bill.bill_number || bill.bill_id,
      startedAt: new Date().toISOString(), finishedAt: null, stoppedReason: null,
    });

    if (lastCallTime > 0) {
      const elapsed = Date.now() - lastCallTime;
      if (elapsed < MIN_MS_BETWEEN_GEMINI_CALLS) {
        const waitMs = MIN_MS_BETWEEN_GEMINI_CALLS - elapsed;
        console.log(`[AI Queue - Bills] Pacing: waiting ${Math.round(waitMs/1000)}s before next Gemini call (rate-limit safety)`);
        await sleep(waitMs);
      }
    }

    const linkedPO = linkedPOMap[bill.bill_id] || null;
    let quotaRetried = false;
    while (true) {
      try {
        const result = await getAIComplianceForBill(bill, linkedPO);
        if (result.aiCallMade) lastCallTime = Date.now();
        break;
      } catch (e) {
        if (e.isQuotaExceeded) {
          if (!quotaRetried && (Date.now() - startTime + e.retryAfterMs + 2000) < timeBudgetMs) {
            const waitMs = e.retryAfterMs + 2000;
            console.warn(`[AI Queue - Bills] Quota hit on ${bill.bill_number || bill.bill_id} — waiting ${Math.round(waitMs/1000)}s then retrying once`);
            await sleep(waitMs);
            quotaRetried = true;
            continue;
          }
          console.error('AI queue (Bills): Gemini quota exceeded again after retry (or out of time budget) — stopping batch:', e.message);
          stoppedReason = 'quota_exceeded';
          break;
        }
        console.error(`AI queue (Bills): failed on Bill ${bill.bill_number || bill.bill_id}:`, e.message);
        lastCallTime = Date.now();
        break;
      }
    }
    if (stoppedReason) break;

    processed++;
  }

  await storeSet(KEYS.AI_QUEUE_STATUS_BILL, {
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
  return `You are a meticulous compliance reviewer for a solar EPC company (Rays Power Experts Ltd.)'s Payment Memo (PMO) approval workflow. Your judgment directly affects a real financial approval decision, so accuracy and honesty matter more than being agreeable — if evidence is genuinely absent or ambiguous, say so plainly rather than guessing favorably.

=== PMO CONTEXT ===
PMO Number: ${pmo.pmo_number || pmo.id || 'unknown'}
Payee: ${pmo.vendor_name || pmo.payee_name || 'unknown'}
Amount: ₹${(pmo.amount || pmo.total || 0).toLocaleString('en-IN')}
Payment Type: ${isAdvance ? 'ADVANCE payment (paid before material dispatch/delivery)' : 'Regular payment'}

=== ATTACHMENTS ===
Attached below are this PMO's supporting documents. Some may be scanned/photographed documents (read as images). Some may be printed emails — read the nested "On [date], X wrote:" / reply-quoting structure carefully to know who said what, and who is REPLYING to whom (the original requester's own message is NOT approval — only a reply from the approving authority counts). Some may be WhatsApp screenshots (sender shown by bubble position/color) — these are often in Hinglish (Hindi in Roman script mixed with English); read and understand naturally.

=== HOW TO JUDGE — READ THIS CAREFULLY ===
- APPROVAL AUTHORITY IS STRICT: valid approval can ONLY come from Nidhi Gupta (Co-Director), Rahul Gupta (Director), or Seema (HoD), or another person explicitly identified as holding equivalent Director/HoD-level authority. A reply, signature, or mark from any other employee does NOT constitute approval, no matter how official it looks.
- Approval is often phrased briefly and informally — a one-word reply like "Approved" directly replying to a request email DOES count, as does an instruction implying approval (e.g. "Go with X" or "proceed"), as long as it's from one of the named authorities above, responding to the actual request (not the requester's own message).
- Do NOT guess favorably — if you cannot clearly identify a genuine approval from one of the named authorities, set "passed": false.

- APPROVAL SUBSTANCE MATTERS MORE THAN LITERAL WORDING — an approval email is often written from the REQUESTER'S perspective (e.g. approving "10 additional Google Workspace user licenses") and will rarely mention the actual billing/invoicing vendor by name, since that's an accounts-department detail the requester wouldn't know. When judging "authorization", compare the SUBSTANCE of what was approved — the amount, quantity, description/purpose, and dates — against this PMO's own amount/remarks, NOT whether the vendor name in this PMO literally appears in the approval email. If the substance clearly matches (same quantity, same product/service, same cost basis, same time period), treat it as approved even if the PMO's vendor name (which may be a reseller/billing entity) never appears in the approval thread at all. Only flag a mismatch if the substance itself is genuinely different (different amount, different purpose, different item entirely) — not merely because the vendor name isn't mentioned.

=== CHECKS TO JUDGE ===
1. "material_status" — ${isAdvance
    ? 'Is there a genuine vendor email/document confirming that the ordered material is ready for dispatch, or has already been dispatched? IMPORTANT: if this PMO is clearly for a SERVICE, SUBSCRIPTION, LICENSE, or other non-physical item (e.g. software licenses, SaaS subscriptions, professional services, utility bills) — there is no physical material to dispatch at all. In that case set "passed": true and note this check does not apply to non-physical items, rather than flagging it as missing evidence. Only require genuine dispatch confirmation when the PMO is actually for physical goods/equipment.'
    : 'This is not an advance payment, so this check does not apply — set "passed": true and note it\'s not applicable.'}
2. "authorization" — Has this PMO genuinely been approved by one of the named authorities above? Judge by SUBSTANCE per the guidance above (matching amount/description/purpose/dates), not by literal vendor-name matching. Quote the specific approving phrase and name the person who said it in your comment.

=== OUTPUT FORMAT ===
Return ONLY a JSON object (no markdown, no code fences) in exactly this shape:
{
  "material_status": { "passed": true/false, "comment": "..." },
  "authorization": { "passed": true/false, "comment": "..." }
}`;
}

async function getAIComplianceForPMO(pmo) {
  const pmoLabel = pmo.pmo_number || pmo.id || 'unknown';
  const fingerprint = buildFingerprint(pmo);
  const cache = (await storeGet(KEYS.AI_COMPLIANCE_CACHE)) || {};
  const cacheKey = `pmo:${pmo.pmo_number || pmo.id}`;
  const cached = cache[cacheKey];

  if (cached && cached.fingerprint === fingerprint) {
    console.log(`[AI] PMO ${pmoLabel}: cache HIT — ${Object.keys(cached.results || {}).length} checks cached`);
    return { results: cached.results, fromCache: true, aiCallMade: false };
  }

  console.log(`[AI] PMO ${pmoLabel}: cache MISS or changed — running fresh check`);

  const docs = pmo.documents || pmo.attachments || [];
  const needsAI = docs.length > 0;
  let aiResults = {};
  let aiCallMade = false;

  if (needsAI) {
    const attachments = [];
    for (const d of docs) {
      try {
        const base64Data = await fetchAttachmentBase64(d.document_id || d.documentId);
        attachments.push({ fileName: d.file_name || d.fileName || 'attachment', base64Data });
      } catch (e) {
        console.error(`[AI] PMO ${pmoLabel}: FAILED to fetch attachment:`, e.message);
      }
    }
    if (attachments.length > 0) {
      console.log(`[AI] PMO ${pmoLabel}: calling Gemini (PO/PMO key) with ${attachments.length} attachment(s)...`);
      aiResults = await callGeminiWithDocuments({ tabType: 'pmo', prompt: buildPMOPrompt(pmo), attachments });
      aiCallMade = true;
    } else {
      console.warn(`[AI] PMO ${pmoLabel}: attachments listed but all failed to download — skipping, will retry next run`);
    }
  }

  const results = {};
  for (const id of AI_CHECK_IDS_PMO) {
    if (aiResults[id]) results[id] = aiResults[id];
  }

  const shouldCache = !needsAI || aiCallMade;
  if (shouldCache) {
    cache[cacheKey] = { fingerprint, results, checkedAt: new Date().toISOString() };
    await storeSet(KEYS.AI_COMPLIANCE_CACHE, cache);
  }

  return { results, fromCache: false, aiCallMade };
}

async function processAIQueueForPMOs(pmos, { timeBudgetMs = 270000 } = {}) {
  const startTime = Date.now();
  const cache = (await storeGet(KEYS.AI_COMPLIANCE_CACHE)) || {};

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

  await storeSet(KEYS.AI_QUEUE_STATUS_PMO, {
    tabType: 'pmo', total: toProcess.length, processed: 0,
    currentItem: toProcess[0] ? (toProcess[0].pmo_number || toProcess[0].id) : null,
    startedAt: new Date().toISOString(), finishedAt: null, stoppedReason: null,
  });

  let processed = 0;
  let stoppedReason = null;
  let lastCallTime = 0;

  for (const pmo of toProcess) {
    if (Date.now() - startTime > timeBudgetMs) { stoppedReason = 'time_budget_exceeded'; break; }

    await storeSet(KEYS.AI_QUEUE_STATUS_PMO, {
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
        const result = await getAIComplianceForPMO(pmo);
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
        console.error(`AI queue (PMOs): failed on ${pmo.pmo_number || pmo.id}:`, e.message);
        lastCallTime = Date.now();
        break;
      }
    }
    if (stoppedReason) break;
    processed++;
  }

  await storeSet(KEYS.AI_QUEUE_STATUS_PMO, {
    tabType: 'pmo', total: toProcess.length, processed, currentItem: null,
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), stoppedReason,
  });

  return { totalNeeded: toProcess.length, processed, stoppedReason, completedFully: stoppedReason === null };
}

module.exports = {
  getAIComplianceForPO, processAIQueueForPOs, buildFingerprint, AI_CHECK_IDS_PO,
  getAIComplianceForBill, processAIQueueForBills, AI_CHECK_IDS_BILL,
  getAIComplianceForPMO, processAIQueueForPMOs, AI_CHECK_IDS_PMO,
};
