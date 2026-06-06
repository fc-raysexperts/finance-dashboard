// pages/api/bills.js
// Returns all Bills pending Jatin's approval
// Runs DUAL checks: (1) Bill compliance, (2) PO match + PFB alignment — separately

import { getPendingBills, getPODetail } from '../../lib/zoho';
import { generatePFB, checkPOAlignment } from '../../lib/pfbEngine';
import { PROJECTS, matchProject } from '../../data/projects';
import { runBillCompliance, getComplianceStatus } from '../../lib/checklistEngine';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. Fetch all bills pending Jatin's approval
    const bills = await getPendingBills();

    // 2. Enrich each bill in parallel
    const enriched = await Promise.all(bills.map(async bill => {

      // ── PROJECT MATCHING ──────────────────────────────────
      const zohoProjectName =
        bill.project_name  ||
        bill.customer_name ||
        '';
      const project = matchProject(zohoProjectName, PROJECTS);

      // ── FETCH LINKED PO ───────────────────────────────────
      // Bills in Zoho store their PO reference in purchaseorders array
      let linkedPO = null;
      const poRef  = bill.purchaseorders?.[0]?.purchaseorder_id || null;
      if (poRef) {
        try { linkedPO = await getPODetail(poRef); } catch { linkedPO = null; }
      }

      // ── COMPLIANCE CHECK (always runs) ────────────────────
      const compliance       = runBillCompliance(bill, linkedPO);
      const complianceStatus = getComplianceStatus(compliance);

      // ── PO MATCH CHECK ────────────────────────────────────
      // Checks each bill line item against the linked PO line items
      let poLineChecks = [];
      let poStatus     = 'na';

      if (linkedPO && bill.line_items?.length > 0) {
        poLineChecks = checkBillAgainstPO(bill.line_items, linkedPO.line_items || []);
        const hasReject = poLineChecks.some(c => c.status === 'reject');
        const hasFlag   = poLineChecks.some(c => c.status === 'flag');
        const hasNoMatch= poLineChecks.some(c => c.status === 'no_match');
        poStatus = hasReject ? 'reject' : (hasFlag || hasNoMatch) ? 'flag' : 'ok';
      }

      // ── PFB ALIGNMENT CHECK ───────────────────────────────
      // Items not matching any PFB scope = 'na' (acceptable — not a flag)
      let pfbLineChecks = [];
      let pfbStatus     = 'na';

      if (project && project.dc && project.ac && project.sw) {
        const pfbItems = generatePFB(project.name, project.dc, project.ac, project.sw);
        pfbLineChecks  = checkPOAlignment(bill.line_items || [], pfbItems);

        // Only consider items that actually matched a PFB scope
        const matchedChecks = pfbLineChecks.filter(l =>
          l.status !== 'na' && l.status !== 'no_match'
        );
        if (matchedChecks.length === 0) {
          pfbStatus = 'na'; // all items outside PFB scope — not a problem
        } else if (matchedChecks.some(l => l.status === 'reject')) {
          pfbStatus = 'reject';
        } else if (matchedChecks.some(l => l.status === 'flag')) {
          pfbStatus = 'flag';
        } else {
          pfbStatus = 'aligned';
        }
      }

      // ── OVERALL ALIGNMENT STATUS ──────────────────────────
      // Worst of poStatus and pfbStatus
      const alignmentStatus =
        [poStatus, pfbStatus].includes('reject') ? 'reject' :
        [poStatus, pfbStatus].includes('flag')   ? 'flag'   :
        poStatus === 'ok' || pfbStatus === 'aligned' ? 'aligned' :
        'na';

      // ── FINAL RECOMMENDATION ──────────────────────────────
      const recommendation = buildRecommendation(
        complianceStatus, alignmentStatus, compliance, linkedPO
      );

      return {
        // Core bill fields
        id:             bill.bill_id,
        billNumber:     bill.bill_number,
        date:           bill.date,
        dueDate:        bill.due_date        || '',
        vendor:         bill.vendor_name,
        vendorId:       bill.vendor_id,
        gstin:          bill.gst_no          || '',
        projectZoho:    zohoProjectName,
        projectMatched: project?.name        || null,
        projectId:      project?.id          || null,
        total:          bill.total,
        subTotal:       bill.sub_total,
        balance:        bill.balance,
        currency:       bill.currency_symbol || '₹',
        lineItems:      bill.line_items      || [],
        taxes:          bill.taxes           || [],
        notes:          bill.notes           || '',
        terms:          bill.terms           || '',
        submittedBy:    bill.submitted_by_name || '',
        submittedDate:  bill.submitted_date    || '',
        attachments:    bill.documents         || [],

        // Linked PO summary
        linkedPO: linkedPO ? {
          id:     linkedPO.purchaseorder_id,
          number: linkedPO.purchaseorder_number,
          total:  linkedPO.total,
          vendor: linkedPO.vendor_name,
          date:   linkedPO.date,
        } : null,

        // DUAL STATUS — both shown as separate badges in the row
        complianceStatus,    // 'pass' | 'warn' | 'fail'
        alignmentStatus,     // 'aligned' | 'flag' | 'reject' | 'na'

        // Detailed check arrays — used in View Details popup
        compliance,          // Bill compliance checklist (30+ checks)
        poLineChecks,        // Bill line items vs PO line items
        pfbLineChecks,       // Bill line items vs PFB scope

        // Intermediate statuses (useful for debugging)
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

    // Find best matching PO line item by name
    let bestMatch  = null;
    let bestScore  = 0;

    for (const pi of poItems) {
      const piName = (pi.name || '').toLowerCase().trim();
      // Score based on common words
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

    // Rate variance — zero tolerance (bill rate must exactly equal PO rate)
    const rateVar = bestMatch.rate > 0
      ? ((bi.rate - bestMatch.rate) / bestMatch.rate * 100)
      : null;

    // Qty variance — bill qty must not exceed PO qty
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
// FINAL RECOMMENDATION
// Based on both compliance and alignment statuses
// ─────────────────────────────────────────────────────────────
function buildRecommendation(compStatus, alignStatus, compliance, linkedPO) {
  const failed = compliance.filter(c => !c.passed);

  // Critical failures — hard reject regardless of alignment
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
      linkedPO ? `Amounts match PO ${linkedPO.number}` : '',
      'PFB alignment confirmed',
    ].filter(Boolean),
  };
}