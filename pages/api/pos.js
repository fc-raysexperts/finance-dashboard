// pages/api/pos.js — Updated with dual-status: compliance + alignment separate

import { getPendingPOs } from '../../lib/zoho';
import { generatePFB, matchToPFB, checkPOAlignment } from '../../lib/pfbEngine';
import { PROJECTS, matchProject } from '../../data/projects';
import { runPOCompliance, getComplianceStatus } from '../../lib/checklistEngine';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const pos = await getPendingPOs();

    const enriched = pos.map(po => {
      const zohoProjectName = po.project_name || po.customer_name || po.delivery_customer_name || '';
      const project = matchProject(zohoProjectName, PROJECTS);

      // ── COMPLIANCE CHECK (always runs, regardless of PFB)
      const compliance       = runPOCompliance(po);
      const complianceStatus = getComplianceStatus(compliance);

      // ── ALIGNMENT CHECK (only if PFB exists)
      let lineChecks      = [];
      let alignmentStatus = 'na'; // not applicable by default
      let pfbTotal        = null;

      if (project && project.dc && project.ac && project.sw) {
        const pfbItems = generatePFB(project.name, project.dc, project.ac, project.sw);
        pfbTotal       = pfbItems.reduce((s, i) => s + i.amount, 0);

        lineChecks = checkPOAlignment(po.line_items || [], pfbItems);

        // Alignment status based only on items that actually matched a PFB scope
        const matchedChecks = lineChecks.filter(l => l.status !== 'na' && l.status !== 'no_match');
        if (matchedChecks.length === 0) {
          alignmentStatus = 'na'; // No items matched any PFB scope — N/A not a problem
        } else if (matchedChecks.some(l => l.status === 'reject')) {
          alignmentStatus = 'reject';
        } else if (matchedChecks.some(l => l.status === 'flag')) {
          alignmentStatus = 'flag';
        } else {
          alignmentStatus = 'aligned';
        }
      }

      // ── FINAL RECOMMENDATION based on BOTH checks
      const recommendation = buildRecommendation(complianceStatus, alignmentStatus, compliance);

      return {
        id:             po.purchaseorder_id,
        poNumber:       po.purchaseorder_number,
        date:           po.date,
        vendor:         po.vendor_name,
        vendorId:       po.vendor_id,
        gstin:          po.gst_no || po.vendor_gst_in || '',
        projectZoho:    zohoProjectName,
        projectMatched: project?.name || null,
        projectId:      project?.id   || null,
        total:          po.total,
        subTotal:       po.sub_total,
        taxes:          po.taxes || [],
        currency:       po.currency_symbol || '₹',
        lineItems:      po.line_items || [],
        notes:          po.notes || '',
        terms:          po.terms || '',
        submittedBy:    po.submitted_by_name || '',
        submittedDate:  po.submitted_date    || '',
        deliveryDate:   po.delivery_date     || '',
        shipVia:        po.ship_via          || '',
        paymentTerms:   po.payment_terms_label || po.payment_terms || '',
        attachments:    po.documents || [],
        pfbTotal,

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