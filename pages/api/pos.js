// pages/api/pos.js — Updated with dual-status: compliance + alignment separate
//
// This is your actual deployed logic (pulled from your repo) — rich field
// set, severity-based sorting, and the detailed buildRecommendation() —
// merged with two improvements that were confirmed needed afterwards:
//   - Project matching uses line_items[].project_name (reliable, tag-based)
//     instead of the document-level po.project_name/customer_name fields,
//     which Zoho often leaves blank on the PO header itself.
//   - Projects include user-added projects and Zoho-name overrides from
//     the store, not just the hardcoded 23.
// Data fetching is unchanged — getPendingPOs() from lib/zoho.js (your
// proven smart-delta-cache version) does all the list/detail/approver work.

import { getPendingPOs } from '../../lib/zoho';
import { generatePFB, checkPOAlignment, isSevere, isCaution, nameSimilarity } from '../../lib/pfbEngine';
import { PROJECTS, matchProject } from '../../data/projects';
import { runPOCompliance, getComplianceStatus } from '../../lib/checklistEngine';
import { buildReferenceRateRow } from '../../lib/referenceRates';
const { storeGet, KEYS } = require('../../lib/store');

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const userProjects = (await storeGet(KEYS.USER_PROJECTS)) || [];
    const zohoNameOvr   = (await storeGet(KEYS.ZOHO_NAME_OVR)) || {};
    const allProjects = [...PROJECTS, ...userProjects].map(p => ({
      ...p, zohoNames: [...(p.zohoNames || []), ...(zohoNameOvr[p.id] || [])]
    }));

    // getPendingPOs() does its own list-fetch, delta-detail-cache, and
    // approver-filtering internally — what comes back is already exactly
    // Jatin's own pending queue, nothing more. forceRefresh is only true
    // when the user explicitly clicked Refresh; a normal page load serves
    // from the persisted cache with zero Zoho calls.
    const forceRefresh = req.query.refresh === '1';
    const pos = await getPendingPOs(forceRefresh);
    console.log(`pos: ${pos.length} currently pending Jatin's approval`);

    // Reference Rate data loaded ONCE per request, not per-PO - shared
    // across every PO in this response.
    const rrCatalog = await storeGet(KEYS.REFERENCE_RATE_CATALOG).catch(() => null) || {};
    const rrHistory = await storeGet(KEYS.REFERENCE_RATE_HISTORY).catch(() => null) || {};

    const enriched = pos.map(po => {
      const lineItems = po.line_items || [];

      // Same fix as bills.js: TDS-type deductions live in tds_summary, a
      // separate array from taxes.
      const tdsDeductions = (po.tds_summary || []).map(t => ({
        tax_name: t.tax_name || t.tds_tax_name || t.name || 'TDS',
        tax_amount: -Math.abs(Number(t.tax_amount ?? t.tds_amount ?? t.amount) || 0),
      })).filter(t => t.tax_amount !== 0);

      // Project extraction from line items (tag-based, reliable) rather
      // than the document-level field, which Zoho frequently leaves blank
      const projectNamesFromLines = [...new Set(lineItems.map(li => li.project_name).filter(Boolean))];
      const zohoProjectName = projectNamesFromLines[0] || po.project_name || po.customer_name || po.delivery_customer_name || '';
      const project = projectNamesFromLines.map(pn => matchProject(pn, allProjects)).find(Boolean)
                    || matchProject(zohoProjectName, allProjects);
      // Real bug fixed: "Project (PFB Match)" only ever showed the FIRST
      // matched project, even when a PO's line items span several
      // projects. This collects every distinct match instead, for display
      // only — `project` above (used for PFB generation) intentionally
      // stays as the single first match, since PFB generation needs one
      // project's DC/AC/Switchyards, not several.
      const allMatchedProjectNames = [...new Set(
        projectNamesFromLines.map(pn => matchProject(pn, allProjects)).filter(Boolean).map(p => p.name)
      )];

      // ── ALIGNMENT CHECK (only if PFB exists) — computed FIRST now, so
      // pfbTotal is available for the new Budget Availability check below.
      let lineChecks      = [];
      let alignmentStatus = 'na'; // not applicable by default
      let pfbTotal        = null;
      let pfbUnavailableReason = null; // shown to the user instead of the table just silently vanishing

      if (!project) {
        pfbUnavailableReason = 'No project matched this PO — PFB comparison needs a matched project to compare against.';
      } else if (!(project.dc && project.ac && project.sw)) {
        const missing = [!project.dc && 'DC', !project.ac && 'AC', !project.sw && 'Switchyards'].filter(Boolean).join(', ');
        pfbUnavailableReason = `Project "${project.name}" is missing ${missing} — set these in the project's PFB sheet to enable comparison.`;
      } else {
        const pfbItems = generatePFB(project.name, project.dc, project.ac, project.sw, project.piling || 2000, project.wall || 2000, project.road || 2000);
        pfbTotal       = pfbItems.reduce((s, i) => s + i.amount, 0);

        lineChecks = checkPOAlignment(lineItems, pfbItems);

        // Alignment status based only on items that actually matched a PFB scope
        const matchedChecks = lineChecks.filter(l => l.status !== 'na' && l.status !== 'no_match');
        if (matchedChecks.length === 0) {
          alignmentStatus = 'na'; // No items matched any PFB scope — N/A not a problem
        } else if (matchedChecks.some(l => isSevere(l.status))) {
          alignmentStatus = 'reject';
        } else if (matchedChecks.some(l => isCaution(l.status))) {
          alignmentStatus = 'flag';
        } else {
          alignmentStatus = 'aligned';
        }
      }

      // ── REFERENCE RATE CHECKS — independent of PFB alignment entirely,
      // shown in its own dedicated table, not mixed into the PFB/PO Match
      // tables. Every line item gets checked, regardless of whether it
      // also happens to match a PFB scope item.
      const referenceRateChecks = lineItems
        .map(li => buildReferenceRateRow(li, 'po', rrCatalog, rrHistory, nameSimilarity, new Date().toISOString()))
        .filter(Boolean);

      // ── COMPLIANCE CHECK (always runs, regardless of PFB) — now passes
      // pfbTotal for the new Budget Availability check.
      const compliance       = runPOCompliance(po, pfbTotal);
      const complianceStatus = getComplianceStatus(compliance);

      // ── FINAL RECOMMENDATION based on BOTH checks
      const recommendation = buildRecommendation(complianceStatus, alignmentStatus, compliance);

      return {
        id:             po.purchaseorder_id,
        poNumber:       po.purchaseorder_number,
        date:           po.date,
        vendor:         po.vendor_name,
        vendorId:       po.vendor_id,
        gstin:          po.gst_no || po.vendor_gst_in || '',
        projectZoho:    projectNamesFromLines.length ? projectNamesFromLines : (zohoProjectName ? [zohoProjectName] : []),
        projectMatched: allMatchedProjectNames.length ? allMatchedProjectNames.join(', ') : null,
        projectId:      project?.id   || null,
        total:          po.total,
        subTotal:       po.sub_total,
        taxes:          [...(po.taxes || []), ...tdsDeductions],
        currency:       po.currency_symbol || '₹',
        lineItems,
        notes:          po.notes || '',
        terms:          po.terms || '',
        submittedBy:    po.submitted_by_name || '',
        submittedDate:  po.submitted_date    || '',
        deliveryDate:   po.delivery_date     || '',
        shipVia:        po.ship_via          || '',
        paymentTerms:   po.payment_terms_label || po.payment_terms || '',
        attachments:    po.documents || [],
        pfbTotal,
        pfbUnavailableReason,

        // New in this round — confirmed against Zoho's official PO field
        // names. "subject" isn't a standard Books field, so it's pulled
        // defensively from custom fields by label match (this org appears
        // to use one for it, based on the sample PDF) — falls back to
        // empty rather than guessing wrong.
        referenceNumber: po.reference_number || '',
        // Real bug fixed: delivery_address?.attention was being used as a
        // fallback for Kind Attention, but that field actually holds a
        // LOCATION name (confirmed: showed "S.S. Nagar" instead of
        // "Mr. Rohit Bishnoi" on a real PO) — not a person's name at all.
        // Kind Attention is pulled from a custom field now, matching the
        // same approach as Subject/Quotation. The value that was
        // incorrectly appearing here is captured separately below as the
        // genuine Location field instead.
        kindAttention:   (po.custom_fields || []).find(f => /kind attention/i.test(f.label || f.placeholder || ''))?.value || po.attention || '',
        locationName:    po.location_name || po.branch_name || po.delivery_address?.attention || '',
        deliverTo:       po.delivery_address ? [
          po.delivery_address.attention,
          po.delivery_address.address,
          [po.delivery_address.city, po.delivery_address.state, po.delivery_address.zip].filter(Boolean).join(' '),
          po.delivery_address.country,
        ].filter(Boolean).join(', ') : '',
        subject: (po.custom_fields || []).find(f => /subject/i.test(f.label || f.placeholder || ''))?.value || '',
        referenceRateChecks,
        // Quotation and this document-level Project label are both visible
        // on the real sample PO but aren't standard Books fields — same
        // defensive custom-field lookup approach as Subject above.
        quotation: (po.custom_fields || []).find(f => /quotation/i.test(f.label || f.placeholder || ''))?.value || '',
        projectLabel: zohoProjectName || '',
        // Real bug fixed: vendor_address was empty because this org's real
        // field for it is (or falls back to) billing_address — same
        // address-formatting approach as Deliver To above.
        vendorAddress: (function(){
          const addr = po.vendor_address || po.billing_address;
          if (!addr) return '';
          return [addr.address, [addr.city, addr.state, addr.zip].filter(Boolean).join(' '), addr.country].filter(Boolean).join(', ');
        })(),
        discount: po.discount || 0,
        discountFormatted: po.discount_type === 'percentage' ? `${po.discount}%` : (po.discount ? `${po.currency_symbol||'₹'}${po.discount}` : ''),
        approversList: po.approvers_list || [],
        adjustment: po.adjustment || 0,
        adjustmentDescription: po.adjustment_description || '',
        // Optional fields — only present on some POs, so each is pulled
        // defensively by label match and simply left blank (never shown)
        // when this particular PO doesn't have them.
        requisition:      (po.custom_fields || []).find(f => /requisition/i.test(f.label || f.placeholder || ''))?.value || '',
        kccRecoverInYrs:  (po.custom_fields || []).find(f => /kcc recover/i.test(f.label || f.placeholder || ''))?.value || '',
        kccAmount:        (po.custom_fields || []).find(f => /kcc amount/i.test(f.label || f.placeholder || ''))?.value || '',
        checkStatus:      (po.custom_fields || []).find(f => /check status/i.test(f.label || f.placeholder || ''))?.value || '',
        shipmentPreference: po.shipment_preference || (po.custom_fields || []).find(f => /shipment preference/i.test(f.label || f.placeholder || ''))?.value || '',

        // DUAL STATUS — shown separately in dashboard row
        complianceStatus,   // 'pass' | 'warn' | 'fail'
        alignmentStatus,    // 'aligned' | 'flag' | 'reject' | 'na'

        compliance,         // full checklist array
        lineChecks,         // PFB line-by-line alignment array

        recommendation,
      };
    });

    const ORDER = { fail:0, reject:0, warn:1, flag:1, pass:2, aligned:2, na:3 };
    enriched.sort((a,b) =>
      Math.min(ORDER[a.complianceStatus]??9, ORDER[a.alignmentStatus]??9) -
      Math.min(ORDER[b.complianceStatus]??9, ORDER[b.alignmentStatus]??9)
    );

    return res.status(200).json({ success:true, count:enriched.length, data:enriched });

  } catch (err) {
    console.error('POs API error:', err.message);
    return res.status(500).json({ success:false, error:err.message });
  }
}

function buildRecommendation(compStatus, alignStatus, compliance) {
  const critFails = compliance.filter(c => !c.passed && ['po_basic','vendor_details','gst_type','ld_clause'].includes(c.id));

  if (compStatus === 'fail' || alignStatus === 'reject') {
    return {
      decision: 'REJECT',
      color: 'red',
      reasons: [
        ...(compStatus === 'fail' ? critFails.map(c => c.comment) : []),
        ...(alignStatus === 'reject' ? ['PFB budget exceeded — management approval required'] : []),
      ],
    };
  }
  if (compStatus === 'warn' || alignStatus === 'flag') {
    return {
      decision: 'FLAG FOR REVIEW',
      color: 'amber',
      reasons: [
        ...(compStatus === 'warn' ? compliance.filter(c=>!c.passed).map(c=>c.comment) : []),
        ...(alignStatus === 'flag' ? ['One or more items have PFB variance > 10%'] : []),
      ],
    };
  }
  if (alignStatus === 'na') {
    return {
      decision: compStatus === 'pass' ? 'APPROVE (No PFB)' : 'FLAG FOR REVIEW',
      color: compStatus === 'pass' ? 'green' : 'amber',
      reasons: compStatus === 'pass'
        ? ['All compliance checks passed', 'No PFB scope match — items outside standard budget (acceptable)']
        : compliance.filter(c=>!c.passed).map(c=>c.comment),
    };
  }
  return {
    decision: 'APPROVE',
    color: 'green',
    reasons: ['All compliance checks passed', 'All PFB alignment checks passed'],
  };
}
