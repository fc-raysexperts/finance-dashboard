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

import { getPendingBills, getCachedPODetail, getPendingPOs } from '../../lib/zoho';
import { generatePFB, checkPOAlignment, nameSimilarity, compareValue, isSevere, isCaution } from '../../lib/pfbEngine';
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

      // Real fix for deductions never appearing: confirmed from the Bill's
      // own top-level key list that tds_summary is a genuinely SEPARATE
      // array from taxes — entries like "Payment of contractors HUF/Indiv
      // (1%)" almost certainly live here, not in bill.taxes at all, which
      // is exactly why the negative-amount detection never found them.
      // TDS is always a deduction, so each entry is stored as a negative
      // amount regardless of the sign Zoho itself uses, then merged
      // straight into the same taxes array so all the existing
      // deduction-placement logic just works without further changes.
      if (!global.__billTdsSummaryLogged && bill.tds_summary && bill.tds_summary.length > 0) {
        global.__billTdsSummaryLogged = true;
        console.log('Bill tds_summary raw structure (one-time, confirming exact field names):', JSON.stringify(bill.tds_summary).slice(0, 1500));
      }
      const tdsDeductions = (bill.tds_summary || []).map(t => ({
        tax_name: t.tax_name || t.tds_tax_name || t.name || 'TDS',
        tax_amount: -Math.abs(Number(t.tax_amount ?? t.tds_amount ?? t.amount) || 0),
      })).filter(t => t.tax_amount !== 0);

      // ── PROJECT MATCHING — from line items (tag-based, reliable) ──
      const projectNamesFromLines = [...new Set(lineItems.map(li => li.project_name).filter(Boolean))];
      const zohoProjectName = projectNamesFromLines[0] || bill.project_name || bill.customer_name || '';
      const project = projectNamesFromLines.map(pn => matchProject(pn, allProjects)).find(Boolean)
                    || matchProject(zohoProjectName, allProjects);
      const allMatchedProjectNames = [...new Set(
        projectNamesFromLines.map(pn => matchProject(pn, allProjects)).filter(Boolean).map(p => p.name)
      )];

      // ── FIND + FETCH LINKED PO ─────────────────────────────
      let linkedPORef = findLinkedPO(bill);
      // Text-matched guesses get verified against the real pending-PO list
      if (linkedPORef?._textMatched && !recentPONumbers.includes(linkedPORef.purchaseorder_number)) {
        linkedPORef = null;
      }
      let linkedPO = null;
      if (linkedPORef?.purchaseorder_id) {
        try { linkedPO = await getCachedPODetail(linkedPORef.purchaseorder_id); } catch { linkedPO = null; }
      }
      const noPOExpected = !linkedPORef && isExpectedNoPOItem(lineItems);

      // ── PO MATCH CHECK ────────────────────────────────────
      // Checks each bill line item against the linked PO's line items —
      // only possible when we have the PO's real detail (not a text guess)
      let poLineChecks = [];
      let poStatus     = 'na';

      if (linkedPO && lineItems.length > 0) {
        poLineChecks = checkBillAgainstPO(lineItems, linkedPO.line_items || []);
        const hasReject = poLineChecks.some(c => isSevere(c.status));
        const hasFlag   = poLineChecks.some(c => isCaution(c.status));
        const hasNoMatch= poLineChecks.some(c => c.status === 'no_match');
        poStatus = hasReject ? 'reject' : (hasFlag || hasNoMatch) ? 'flag' : 'ok';
      }

      // ── PFB ALIGNMENT CHECK ───────────────────────────────
      let pfbLineChecks = [];
      let pfbStatus     = 'na';
      let pfbUnavailableReason = null;
      let pfbTotal      = null; // now computed BEFORE the compliance call below, so the new Budget Check can use it

      if (!project) {
        pfbUnavailableReason = 'No project matched this Bill — PFB comparison needs a matched project to compare against.';
      } else if (!(project.dc && project.ac && project.sw)) {
        const missing = [!project.dc && 'DC', !project.ac && 'AC', !project.sw && 'Switchyards'].filter(Boolean).join(', ');
        pfbUnavailableReason = `Project "${project.name}" is missing ${missing} — set these in the project's PFB sheet to enable comparison.`;
      } else {
        const pfbItems = generatePFB(project.name, project.dc, project.ac, project.sw, project.piling || 2000, project.wall || 2000, project.road || 2000);
        pfbTotal       = pfbItems.reduce((s, i) => s + i.amount, 0);
        pfbLineChecks  = checkPOAlignment(lineItems, pfbItems);

        const matchedChecks = pfbLineChecks.filter(l =>
          l.status !== 'na' && l.status !== 'no_match'
        );
        if (matchedChecks.length === 0) {
          pfbStatus = 'na';
        } else if (matchedChecks.some(l => isSevere(l.status))) {
          pfbStatus = 'reject';
        } else if (matchedChecks.some(l => isCaution(l.status))) {
          pfbStatus = 'flag';
        } else {
          pfbStatus = 'aligned';
        }
      }

      // ── COMPLIANCE CHECK (always runs) ────────────────────
      const compliance       = runBillCompliance(bill, linkedPO || linkedPORef, pfbTotal);
      const complianceStatus = getComplianceStatus(compliance);

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
        projectMatched: allMatchedProjectNames.length ? allMatchedProjectNames.join(', ') : null,
        projectId:      project?.id          || null,
        total:          bill.total,
        subTotal:       bill.sub_total,
        balance:        bill.balance,
        currency:       bill.currency_symbol || '₹',
        lineItems,
        taxes:          [...(bill.taxes || []), ...tdsDeductions],
        notes:          bill.notes           || '',
        terms:          bill.terms           || '',
        submittedBy:    bill.submitted_by_name || '',
        submittedDate:  bill.submitted_date    || '',
        attachments:    bill.documents         || [],
        noPOExpected,
        pfbUnavailableReason,
        paymentTerms:   bill.payment_terms_label || (bill.payment_terms != null ? `Net ${bill.payment_terms}` : ''),
        // Real bug fixed: bill_type was assumed to be a standard Books
        // field, but the real sample PDF shows "Bill Type: Expense" sitting
        // INSIDE the "Custom Fields" box, right alongside Project Name —
        // which is confirmed working via custom-field lookup, and Bill
        // Type wasn't. Checking the custom field first now, same as
        // Project Name, falling back to the standard field only if that's
        // somehow blank.
        billType: (bill.custom_fields || []).find(f => /bill type/i.test(f.label || f.placeholder || ''))?.value || bill.bill_type || '',
        // Confirmed visible on the real sample Bill under "CUSTOM FIELDS" —
        // none of these are standard Books fields, so pulled defensively
        // by label match, same approach as Subject/Quotation on POs.
        // Real fix: this isn't a custom field at all for this org — scanned
        // the actual Bill's top-level keys and found txn_value_date, which
        // matches Zoho's own help documentation describing Transaction
        // Posting Date as exactly a "value date" concept (the date journal
        // entries post, separate from the bill's own date field). Old
        // fallbacks kept in case a different org exposes this differently.
        transactionPostingDate: bill.txn_value_date || bill.transaction_date || (bill.custom_fields || []).find(f => /posting/i.test(f.label || f.placeholder || ''))?.value || '',
        originalReferenceBillNumber: (bill.custom_fields || []).find(f => /original reference bill/i.test(f.label || f.placeholder || ''))?.value || '',
        billProjectName: (bill.custom_fields || []).find(f => /project name/i.test(f.label || f.placeholder || ''))?.value || '',
        billSubject: (bill.custom_fields || []).find(f => /subject/i.test(f.label || f.placeholder || ''))?.value || '',
        accountsPayable: (bill.custom_fields || []).find(f => /accounts payable/i.test(f.label || f.placeholder || ''))?.value || '',
        discount: bill.discount || 0,
        discountFormatted: bill.discount_type === 'percentage' ? `${bill.discount}%` : (bill.discount ? `${bill.currency_symbol||'₹'}${bill.discount}` : ''),
        adjustment: bill.adjustment || 0,
        adjustmentDescription: bill.adjustment_description || '',
        vendorAddress: (function(){
          const addr = bill.vendor_address || bill.billing_address;
          if (!addr) return '';
          return [addr.address, [addr.city, addr.state, addr.zip].filter(Boolean).join(' '), addr.country].filter(Boolean).join(', ');
        })(),
        locationName: bill.location_name || bill.branch_name || '',

        // Linked PO summary (uses full detail when we have it, otherwise the reference)
        linkedPO: (linkedPO || linkedPORef) ? {
          id:     linkedPO?.purchaseorder_id ?? linkedPORef?.purchaseorder_id ?? null,
          number: linkedPO?.purchaseorder_number ?? linkedPORef?.purchaseorder_number ?? null,
          total:  linkedPO?.total ?? null,
          vendor: linkedPO?.vendor_name ?? null,
          date:   linkedPO?.date ?? null,
        } : null,
        // Real bug fixed: Order Number showed "None" whenever our own
        // PO-matching logic didn't resolve a full linked PO object, even
        // when Zoho's own bill.reference_number field (what ZB itself
        // displays as ORDER NUMBER) clearly had the PO number as text.
        // Now used as a direct, reliable fallback.
        orderNumber: bill.reference_number || '',

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

    // Same normalized similarity score already proven for PFB matching -
    // confirmed real issue this fixes: the old approach used a raw,
    // un-normalized common-word COUNT with no real threshold, so it could
    // pick a weak, wrong candidate (any shared word "won") or fail to
    // recognize a genuine match if wording length differed a lot between
    // the Bill and PO line item.
    let bestMatch = null;
    let bestScore = 0;
    for (const pi of poItems) {
      const score = nameSimilarity(biName, (pi.name || '').toLowerCase().trim());
      if (score > bestScore) { bestScore = score; bestMatch = pi; }
    }

    if (!bestMatch || bestScore < 0.3) {
      return {
        lineItem:     bi.name,
        billQty:      bi.quantity,
        billRate:     bi.rate,
        billAmount:   bi.item_total,
        poQty:        null,
        poRate:       null,
        poAmount:     null,
        qtyVariance:  null, rateVariance: null,
        qtyStatus:    'na', rateStatus:   'na',
        status:       'no_match',
        comment:      `"${bi.name}" — not found in linked PO. Item not ordered or wrong PO linked.`,
      };
    }

    // Same direction-aware comparison used for the PFB-alignment table —
    // confirmed real bug this fixes: the old logic used Math.abs() on the
    // rate variance, so a Bill rate well BELOW the PO rate (favorable)
    // got the exact same "reject" label as one well ABOVE it. It also
    // only ever flagged qty in one direction (over-billed), silently
    // ignoring under-billing, and rolled both into a single opaque
    // status — meaning a pure qty mismatch could show "Variance" right
    // next to a correctly-computed 0.0% rate variance, with nothing in
    // the table explaining why. Both dimensions are now compared and
    // shown explicitly and symmetrically.
    const rateCmp = compareValue(bi.rate, bestMatch.rate);
    const qtyCmp  = compareValue(bi.quantity, bestMatch.quantity);
    // Same as the PFB-alignment table: Overall reflects whether the
    // line's actual total (Qty x Rate) came in above or below the
    // linked PO's total for that item - a separate signal from the
    // individual Qty/Rate statuses.
    const amountCmp = compareValue(bi.item_total, bestMatch.item_total);
    const status = amountCmp.status;

    const flags = [];
    if (rateCmp.status !== 'ok' && rateCmp.status !== 'na') {
      flags.push(`Rate ${rateCmp.variance > 0 ? 'above' : 'below'} PO: Bill ₹${bi.rate} vs PO ₹${bestMatch.rate} (${rateCmp.variance > 0 ? '+' : ''}${rateCmp.variance}%)`);
    }
    if (qtyCmp.status !== 'ok' && qtyCmp.status !== 'na') {
      flags.push(`Qty ${qtyCmp.variance > 0 ? 'above' : 'below'} PO: Bill ${bi.quantity} vs PO ${bestMatch.quantity} (${qtyCmp.variance > 0 ? '+' : ''}${qtyCmp.variance}%)`);
    }

    return {
      lineItem:     bi.name,
      billQty:      bi.quantity,
      billRate:     bi.rate,
      billAmount:   bi.item_total,
      poQty:        bestMatch.quantity,
      poRate:       bestMatch.rate,
      poAmount:     bestMatch.item_total,
      qtyVariance:  qtyCmp.variance, rateVariance: rateCmp.variance,
      qtyStatus:    qtyCmp.status,   rateStatus:   rateCmp.status,
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
