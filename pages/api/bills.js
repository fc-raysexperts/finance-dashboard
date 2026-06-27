// pages/api/bills.js
// Returns all Bills pending Jatin's approval
// Runs DUAL checks: (1) Bill compliance, (2) PO match + PFB alignment — separately
//
// This is your actual deployed logic (pulled from your repo) — the
// checkBillAgainstPO line-item-level rate/qty variance check, severity
// sorting, and detailed buildRecommendation() — merged with two
// improvements confirmed needed afterwards:
//   - findLinkedPO() checks bill.purchaseorders[], then line_items[]
//     .purchaseorder_id, then a text-match fallback against reference
//     number/notes — not just the single purchaseorders[0] field, which
//     Zoho often leaves empty even when a PO really is linked.
//   - Project matching uses line_items[].project_name, and the project
//     list includes user-added projects + Zoho-name overrides from the
//     store.
// Data fetching is unchanged — getPendingBills() from lib/zoho.js (your
// proven smart-delta-cache version) does all the list/detail/approver work.

import { getPendingBills, getPODetail, getPendingPOs } from '../../lib/zoho';
import { generatePFB, checkPOAlignment } from '../../lib/pfbEngine';
import { PROJECTS, matchProject } from '../../data/projects';
import { runBillCompliance, getComplianceStatus } from '../../lib/checklistEngine';
const { storeGet, KEYS } = require('../../lib/store');

// Items that legitimately have no PO — used so the "no reference" message
// doesn't read as an error for these
const NO_PO_EXPECTED_KEYWORDS = [
  'electrical inspection', 'legal', 'loading', 'unloading', 'freight',
  'transport', 'consultancy', 'professional fee', 'audit', 'bank charge',
  'government fee', 'license', 'rvpnl', 'rrec', 'ceig',
];

function findLinkedPO(bill) {
  // 1. Standard Zoho field: bill.purchaseorders array
  if (Array.isArray(bill.purchaseorders) && bill.purchaseorders.length > 0) {
    return bill.purchaseorders[0];
  }
  // 2. line_items[].purchaseorder_id — present even when the document-level
  //    `purchaseorders` array is empty
  const liWithPO = (bill.line_items || []).find(li => li.purchaseorder_id);
  if (liWithPO) {
    return { purchaseorder_id: liWithPO.purchaseorder_id, purchaseorder_number: liWithPO.purchaseorder_number || null };
  }
  // 3. Reference number text match — PO numbers often appear in notes/reference_number.
  //    No real ID here, just a guessed number — can't fetch full detail for it.
  const refText = `${bill.reference_number || ''} ${bill.notes || ''}`.toUpperCase();
  const poMatch = refText.match(/PO[\/\s-]?\d{2,}[\/\-]\d{2,}[\/\-]\d{2,}/i) || refText.match(/PO\d{5,}/i);
  if (poMatch) {
    return { purchaseorder_id: null, purchaseorder_number: poMatch[0], _textMatched: true };
  }
  return null;
}

function isExpectedNoPOItem(lineItems) {
  const allNames = (lineItems || []).map(li => (li.name || '').toLowerCase()).join(' ');
  return NO_PO_EXPECTED_KEYWORDS.some(kw => allNames.includes(kw));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const userProjects = (await storeGet(KEYS.USER_PROJECTS)) || [];
    const zohoNameOvr   = (await storeGet(KEYS.ZOHO_NAME_OVR)) || {};
    const allProjects = [...PROJECTS, ...userProjects].map(p => ({
      ...p, zohoNames: [...(p.zohoNames || []), ...(zohoNameOvr[p.id] || [])]
    }));

    // 1. Fetch all bills pending Jatin's approval (smart delta cache — see
    // lib/zoho.js). forceRefresh is only true when the user explicitly
    // clicked Refresh; a normal page load serves from the persisted cache
    // with zero Zoho calls.
    const forceRefresh = req.query.refresh === '1';
    const bills = await getPendingBills(forceRefresh);
    console.log(`bills: ${bills.length} currently pending Jatin's approval`);

    // Recent PO numbers, for verifying a text-matched reference is real —
    // always cache-only here regardless of the Bills refresh, since this
    // is just a minor verification fallback, not worth forcing a POs
    // refresh as a side effect of refreshing Bills.
    let recentPONumbers = [];
    try {
      const pos = await getPendingPOs();
      recentPONumbers = pos.map(p => p.purchaseorder_number);
    } catch {}

    // 2. Enrich each bill in parallel
    const enriched = await Promise.all(bills.map(async bill => {
      const lineItems = bill.line_items || [];

      // ── PROJECT MATCHING — from line items (tag-based, reliable) ──
      const projectNamesFromLines = [...new Set(lineItems.map(li => li.project_name).filter(Boolean))];
      const zohoProjectName = projectNamesFromLines[0] || bill.project_name || bill.customer_name || '';
      const project = projectNamesFromLines.map(pn => matchProject(pn, allProjects)).find(Boolean)
                    || matchProject(zohoProjectName, allProjects);

      // ── FIND + FETCH LINKED PO ─────────────────────────────
      let linkedPORef = findLinkedPO(bill);
      // Text-matched guesses get verified against the real pending-PO list
      if (linkedPORef?._textMatched && !recentPONumbers.includes(linkedPORef.purchaseorder_number)) {
        linkedPORef = null;
      }
      let linkedPO = null;
      if (linkedPORef?.purchaseorder_id) {
        try { linkedPO = await getPODetail(linkedPORef.purchaseorder_id); } catch { linkedPO = null; }
      }
      const noPOExpected = !linkedPORef && isExpectedNoPOItem(lineItems);

      // ── COMPLIANCE CHECK (always runs) ────────────────────
      const compliance       = runBillCompliance(bill, linkedPO || linkedPORef);
      const complianceStatus = getComplianceStatus(compliance);

      // ── PO MATCH CHECK ────────────────────────────────────
      // Checks each bill line item against the linked PO's line items —
      // only possible when we have the PO's real detail (not a text guess)
      let poLineChecks = [];
      let poStatus     = 'na';

      if (linkedPO && lineItems.length > 0) {
        poLineChecks = checkBillAgainstPO(lineItems, linkedPO.line_items || []);
        const hasReject = poLineChecks.some(c => c.status === 'reject');
        const hasFlag   = poLineChecks.some(c => c.status === 'flag');
        const hasNoMatch= poLineChecks.some(c => c.status === 'no_match');
        poStatus = hasReject ? 'reject' : (hasFlag || hasNoMatch) ? 'flag' : 'ok';
      }

      // ── PFB ALIGNMENT CHECK ───────────────────────────────
      let pfbLineChecks = [];
      let pfbStatus     = 'na';

      if (project && project.dc && project.ac && project.sw) {
        const pfbItems = generatePFB(project.name, project.dc, project.ac, project.sw, project.piling || 2000, project.wall || 2000, project.road || 2000);
        pfbLineChecks  = checkPOAlignment(lineItems, pfbItems);

        const matchedChecks = pfbLineChecks.filter(l =>
          l.status !== 'na' && l.status !== 'no_match'
        );
        if (matchedChecks.length === 0) {
          pfbStatus = 'na';
        } else if (matchedChecks.some(l => l.status === 'reject')) {
          pfbStatus = 'reject';
        } else if (matchedChecks.some(l => l.status === 'flag')) {
          pfbStatus = 'flag';
        } else {
          pfbStatus = 'aligned';
        }
      }

      // ── OVERALL ALIGNMENT STATUS — worst of poStatus and pfbStatus ──
      const alignmentStatus =
        [poStatus, pfbStatus].includes('reject') ? 'reject' :
        [poStatus, pfbStatus].includes('flag')   ? 'flag'   :
        poStatus === 'ok' || pfbStatus === 'aligned' ? 'aligned' :
        'na';

      // ── FINAL RECOMMENDATION ──────────────────────────────
      const recommendation = buildRecommendation(
        complianceStatus, alignmentStatus, compliance, linkedPO || linkedPORef
      );

      return {
        id:             bill.bill_id,
        billNumber:     bill.bill_number,
        date:           bill.date,
        dueDate:        bill.due_date        || '',
        vendor:         bill.vendor_name,
        vendorId:       bill.vendor_id,
        gstin:          bill.gst_no          || '',
        projectZoho:    projectNamesFromLines.length ? projectNamesFromLines : (zohoProjectName ? [zohoProjectName] : []),
        projectMatched: project?.name        || null,
        projectId:      project?.id          || null,
        total:          bill.total,
        subTotal:       bill.sub_total,
        balance:        bill.balance,
        currency:       bill.currency_symbol || '₹',
        lineItems,
        taxes:          bill.taxes           || [],
        notes:          bill.notes           || '',
        terms:          bill.terms           || '',
        submittedBy:    bill.submitted_by_name || '',
        submittedDate:  bill.submitted_date    || '',
        attachments:    bill.documents         || [],
        noPOExpected,

        // Linked PO summary (uses full detail when we have it, otherwise the reference)
        linkedPO: (linkedPO || linkedPORef) ? {
          id:     linkedPO?.purchaseorder_id ?? linkedPORef?.purchaseorder_id ?? null,
          number: linkedPO?.purchaseorder_number ?? linkedPORef?.purchaseorder_number ?? null,
          total:  linkedPO?.total ?? null,
          vendor: linkedPO?.vendor_name ?? null,
          date:   linkedPO?.date ?? null,
        } : null,

        // DUAL STATUS — both shown as separate badges in the row
        complianceStatus,    // 'pass' | 'warn' | 'fail'
        alignmentStatus,     // 'aligned' | 'flag' | 'reject' | 'na'

        // Detailed check arrays — used in View Details popup
        compliance,          // Bill compliance checklist
        poLineChecks,        // Bill line items vs PO line items
        pfbLineChecks,       // Bill line items vs PFB scope

        poStatus,
        pfbStatus,

        recommendation,
      };
    }));

    // Sort: most critical first
    const SEVERITY = { fail:0, reject:0, warn:1, flag:1, pass:2, aligned:2, na:3 };
    enriched.sort((a, b) =>
      Math.min(SEVERITY[a.complianceStatus] ?? 9, SEVERITY[a.alignmentStatus] ?? 9) -
      Math.min(SEVERITY[b.complianceStatus] ?? 9, SEVERITY[b.alignmentStatus] ?? 9)
    );

    return res.status(200).json({
      success: true,
      count:   enriched.length,
      data:    enriched,
    });

  } catch (err) {
    console.error('Bills API error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// CHECK BILL LINE ITEMS AGAINST LINKED PO
// Each bill item is matched to a PO item by name similarity.
// Rate and quantity are then compared.
// ─────────────────────────────────────────────────────────────
function checkBillAgainstPO(billItems, poItems) {
  return billItems.map(bi => {
    const biName = (bi.name || '').toLowerCase().trim();

    let bestMatch  = null;
    let bestScore  = 0;

    for (const pi of poItems) {
      const piName = (pi.name || '').toLowerCase().trim();
      const biWords = biName.split(/\s+/);
      const piWords = piName.split(/\s+/);
      const common  = biWords.filter(w => w.length > 2 && piWords.includes(w)).length;
      if (common > bestScore) {
        bestScore = common;
        bestMatch = pi;
      }
    }

    if (!bestMatch || bestScore === 0) {
      return {
        lineItem:     bi.name,
        billQty:      bi.quantity,
        billRate:     bi.rate,
        billAmount:   bi.item_total,
        poQty:        null,
        poRate:       null,
        poAmount:     null,
        rateVariance: null,
        qtyVariance:  null,
        status:       'no_match',
        comment:      `"${bi.name}" — not found in linked PO. Item not ordered or wrong PO linked.`,
      };
    }

    const rateVar = bestMatch.rate > 0
      ? ((bi.rate - bestMatch.rate) / bestMatch.rate * 100)
      : null;

    const qtyVar = bestMatch.quantity > 0
      ? ((bi.quantity - bestMatch.quantity) / bestMatch.quantity * 100)
      : null;

    const flags = [];
    if (rateVar !== null && Math.abs(rateVar) > 0.5) {
      flags.push(`Rate mismatch: Bill ₹${bi.rate} vs PO ₹${bestMatch.rate} (${rateVar > 0 ? '+' : ''}${rateVar.toFixed(1)}%) — must match PO exactly`);
    }
    if (qtyVar !== null && qtyVar > 0) {
      flags.push(`Qty overbilled: Bill ${bi.quantity} vs PO ${bestMatch.quantity} (${qtyVar.toFixed(1)}% over PO qty)`);
    }

    const status =
      (rateVar !== null && Math.abs(rateVar) > 25) || (qtyVar !== null && qtyVar > 25) ? 'reject' :
      flags.length > 0 ? 'flag' :
      'ok';

    return {
      lineItem:     bi.name,
      billQty:      bi.quantity,
      billRate:     bi.rate,
      billAmount:   bi.item_total,
      poQty:        bestMatch.quantity,
      poRate:       bestMatch.rate,
      poAmount:     bestMatch.item_total,
      rateVariance: rateVar !== null ? +rateVar.toFixed(1) : null,
      qtyVariance:  qtyVar  !== null ? +qtyVar.toFixed(1)  : null,
      status,
      comment:      flags.length > 0 ? flags.join(' | ') : `Matches PO item "${bestMatch.name}" exactly`,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// FINAL RECOMMENDATION — based on both compliance and alignment statuses
// ─────────────────────────────────────────────────────────────
function buildRecommendation(compStatus, alignStatus, compliance, linkedPO) {
  const failed = compliance.filter(c => !c.passed);

  const criticalFails = failed.filter(c =>
    ['bill_basic', 'vendor_active', 'po_ref', 'gst_type', 'amount_calc', 'bill_no_po'].includes(c.id)
  );

  if (compStatus === 'fail' || alignStatus === 'reject' || criticalFails.length > 0) {
    return {
      decision: 'REJECT',
      color:    'red',
      reasons: [
        ...criticalFails.map(c => c.comment),
        ...(alignStatus === 'reject' ? ['PFB budget exceeded — management approval required before payment'] : []),
        ...(alignStatus === 'reject' && !linkedPO ? ['Bill has no linked PO'] : []),
      ],
    };
  }

  if (compStatus === 'warn' || alignStatus === 'flag') {
    return {
      decision: 'FLAG FOR REVIEW',
      color:    'amber',
      reasons: [
        ...failed.map(c => c.comment),
        ...(alignStatus === 'flag' ? ['One or more items have rate/qty variance vs PO or PFB'] : []),
      ],
    };
  }

  if (alignStatus === 'na' && !linkedPO) {
    return {
      decision: 'FLAG FOR REVIEW',
      color:    'amber',
      reasons: [
        'No PO linked to this bill',
        'Bills without PO require management approval + RP Sir sign-off',
        ...failed.map(c => c.comment),
      ],
    };
  }

  if (alignStatus === 'na') {
    return {
      decision: compStatus === 'pass' ? 'APPROVE (No PFB Scope)' : 'FLAG FOR REVIEW',
      color:    compStatus === 'pass' ? 'green' : 'amber',
      reasons:  compStatus === 'pass'
        ? ['All compliance checks passed', 'Items outside standard PFB scope — acceptable (e.g. services, freight, legal)']
        : failed.map(c => c.comment),
    };
  }

  return {
    decision: 'APPROVE',
    color:    'green',
    reasons:  [
      'All bill compliance checks passed',
      linkedPO ? `Amounts match PO ${linkedPO.number || linkedPO.purchaseorder_number || ''}` : '',
      'PFB alignment confirmed',
    ].filter(Boolean),
  };
}
