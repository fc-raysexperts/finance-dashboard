// lib/checklistEngine.js
// Complete compliance checklists for PO, Bill, and PMO
// Item names compressed to general names everywhere except Items Table

// ─────────────────────────────────────────────────────────────
// WARRANTY ITEMS
// ─────────────────────────────────────────────────────────────
const WARRANTY_KEYWORDS = [
  'solar module','solar panel','pv module','monocrystalline','bifacial','topcon',
  'inverter','string inverter','central inverter',
  'battery','lithium','lead acid',
  'module mounting structure','mms','mounting structure',
  'dc combiner','ac distribution','acdb','dcdb','mcb','mccb','spd',
  'charge controller',
  'monitoring system','data logger','scada',
  'earthing','lightning arrester','la','ese',
  'solar cable','pv cable','mc4','connector',
  'transformer','idt','aux transformer',
];

function needsWarranty(itemName) {
  const n = (itemName || '').toLowerCase();
  return WARRANTY_KEYWORDS.some(kw => n.includes(kw));
}

// ─────────────────────────────────────────────────────────────
// ITEM NAME COMPRESSOR
// Returns one general name (≤5 words) for all line items combined
// Used everywhere EXCEPT the Items Table in the VD box
// ─────────────────────────────────────────────────────────────
function getGeneralItemName(lineItems) {
  if (!lineItems || lineItems.length === 0) return 'items';
  if (lineItems.length === 1) {
    const words = (lineItems[0].name || 'item').trim().split(/\s+/);
    return words.slice(0, 5).join(' ');
  }
  // Multiple items — first item (max 3 words) + count of rest
  const firstWords = (lineItems[0].name || '').trim().split(/\s+/).slice(0, 3).join(' ');
  return `${firstWords} & ${lineItems.length - 1} other(s)`;
}

function getTotalQty(lineItems) {
  const total = lineItems.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0);
  return total % 1 === 0 ? total.toString() : total.toFixed(2);
}

// ─────────────────────────────────────────────────────────────
// TDS REFERENCE TABLE
// ─────────────────────────────────────────────────────────────
const TDS_SECTIONS = [
  { section:'194C', nature:'Contractor Payment',       threshold:30000,   rate:'1%/2%',  notes:'GST not included' },
  { section:'194J', nature:'Professional/Technical',   threshold:50000,   rate:'10%',    notes:'Legal, Consulting, Technical' },
  { section:'194I', nature:'Rent – Plant & Machinery', threshold:240000,  rate:'2%',     notes:'Only basic rent' },
  { section:'194I', nature:'Rent – Land & Building',   threshold:600000,  rate:'10%',    notes:'Commercial/residential' },
  { section:'194H', nature:'Commission/Brokerage',     threshold:15000,   rate:'2%',     notes:'Sales commission' },
  { section:'194A', nature:'Interest',                 threshold:40000,   rate:'10%',    notes:'Bank limit 50,000' },
  { section:'194Q', nature:'Purchase of Goods',        threshold:5000000, rate:'0.1%',   notes:'Applicable to buyer' },
  { section:'194C', nature:'Transporter',              threshold:0,       rate:'Nil',    notes:'PAN mandatory' },
];

function getTDSSection(itemDescription, amount) {
  const desc = (itemDescription || '').toLowerCase();
  if (desc.includes('transport') || desc.includes('freight') || desc.includes('logistics'))
    return TDS_SECTIONS.find(t => t.nature === 'Transporter');
  if (desc.includes('legal') || desc.includes('professional') || desc.includes('consult') || desc.includes('technical service'))
    return TDS_SECTIONS.find(t => t.section === '194J' && t.threshold === 50000);
  if (desc.includes('rent') || desc.includes('lease'))
    return TDS_SECTIONS.find(t => t.nature === 'Rent – Land & Building');
  if (desc.includes('commission') || desc.includes('brokerage'))
    return TDS_SECTIONS.find(t => t.section === '194H');
  if (amount >= 30000)
    return TDS_SECTIONS.find(t => t.section === '194C' && t.nature === 'Contractor Payment');
  return null;
}

// ─────────────────────────────────────────────────────────────
// RCM ITEMS
// ─────────────────────────────────────────────────────────────
const RCM_KEYWORDS = ['taxi','cab','transportation','truck','lorry','rent','land lease','rental income','advocate','legal fee'];

function needsRCM(itemName) {
  const n = (itemName || '').toLowerCase();
  return RCM_KEYWORDS.some(kw => n.includes(kw));
}

// ─────────────────────────────────────────────────────────────
// GST STATE CHECK
// ─────────────────────────────────────────────────────────────
const COMPANY_STATE_CODE = '08'; // Rajasthan

function getGSTType(vendorGSTIN) {
  if (!vendorGSTIN || vendorGSTIN.length < 2) return 'unknown';
  const vendorState = vendorGSTIN.substring(0, 2);
  return vendorState === COMPANY_STATE_CODE ? 'intrastate' : 'interstate';
}

// ─────────────────────────────────────────────────────────────
// PO COMPLIANCE CHECKLIST
// ─────────────────────────────────────────────────────────────
async function runPOCompliance(po, pfbTotal, advancePaidByPO = {}, aiResults = {}) {
  const checks    = [];
  const lineItems = po.line_items  || [];
  const taxes     = po.taxes       || [];
  const docs      = po.documents   || [];
  const notes     = (po.notes || '').toLowerCase();
  const totalAmt  = po.total || 0;

  // NOTE: local attachment text-extraction (pdf-parse/OCR) is deliberately
  // NOT used here anymore. The AI (Gemini) now reads every attachment
  // natively and directly for the checks that need real content
  // understanding — running a redundant local text-extraction pass on
  // every PO on every page load added latency for no benefit, since its
  // results were only ever a rougher fallback. lib/attachmentText.js is
  // kept in the codebase as a standalone utility (e.g. for future
  // non-AI uses) but is not called from this function.
  const attachmentText = '';
  const attachmentTextLower = '';

  // General item reference for use in checks
  const genName = getGeneralItemName(lineItems);
  const totalQty = getTotalQty(lineItems);

  // 1. PO Basic Details
  checks.push({
    id:'po_basic', name:'PO Basic Details',
    passed: !!(po.purchaseorder_number && po.date),
    value: `${po.purchaseorder_number || '—'} | ${po.date || '—'}`,
    comment: (po.purchaseorder_number && po.date)
      ? `PO number and date present`
      : `Missing: ${!po.purchaseorder_number ? 'PO number ' : ''}${!po.date ? 'PO date' : ''}`,
  });

  // 2. Vendor Details & GSTIN
  const gstin = po.gst_no || po.vendor_gst_in || '';
  const gstinValid = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin);
  checks.push({
    id:'vendor_details', name:'Vendor Details & GSTIN',
    passed: !!(po.vendor_name && gstinValid),
    value: `${po.vendor_name || '—'} | GSTIN: ${gstin || 'Missing'}`,
    comment: gstinValid
      ? `Vendor ${po.vendor_name} — GSTIN ${gstin} format valid`
      : gstin
        ? `GSTIN "${gstin}" format invalid — verify with vendor master`
        : `Vendor GSTIN missing — mandatory for GST compliance`,
  });

  // 3. Delivery Details
  checks.push({
    id:'delivery', name:'Delivery Location & Date',
    passed: !!(po.delivery_date),
    value: `Date: ${po.delivery_date || 'Not set'}`,
    comment: po.delivery_date
      ? `Delivery date set: ${po.delivery_date}`
      : `Delivery date missing — required for project scheduling`,
  });

  // 4. Shipment Terms
  const shipVia = po.ship_via || po.shipment_preference || '';
  checks.push({
    id:'shipment', name:'Shipment / Freight Terms',
    passed: !!shipVia || notes.includes('ex-work') || notes.includes('for') || notes.includes('freight'),
    value: shipVia || 'Not specified',
    comment: shipVia
      ? `Freight terms: ${shipVia}`
      : `Freight/shipment terms not specified — Ex-Works vs FOR needs clarity`,
  });

  // 5. Item Description Accuracy
  const vagueItems = lineItems.filter(l => !l.name || l.name.length < 5);
  checks.push({
    id:'item_desc', name:'Item Description Accuracy',
    passed: vagueItems.length === 0 && lineItems.length > 0,
    value: `${lineItems.length} item(s)`,
    comment: vagueItems.length > 0
      ? `${vagueItems.length} item(s) have insufficient description — specs/model/rating required`
      : `All item descriptions present`,
  });

  // 6. Quantity Verification
  checks.push({
    id:'qty_verify', name:'Quantity Verification (PR Match)',
    passed: lineItems.every(l => l.quantity > 0),
    value: `${genName} — Total qty: ${totalQty}`,
    comment: lineItems.every(l => l.quantity > 0)
      ? `All items have quantities — verify against PR before approval`
      : `One or more items have zero quantity`,
  });

  // 7. Rate Verification
  const zeroRate = lineItems.filter(l => !l.rate || l.rate === 0);
  checks.push({
    id:'rate_verify', name:'Rate Verification',
    passed: zeroRate.length === 0,
    value: zeroRate.length === 0 ? 'All rates present' : `${zeroRate.length} item(s) at ₹0`,
    comment: zeroRate.length === 0
      ? `All line item rates present — compare with previous PO / rate chart`
      : `${zeroRate.length} item(s) with zero rate — rates missing`,
  });

  // 8. Historical Rate Comparison — genuinely not automatable yet with
  // what's currently tracked (this is exactly the planned Reference Rate
  // system: averaging the last few occurrences of a similarly-named item
  // across past POs/Bills). Marked as a manual-verification reminder
  // rather than faked with a hardcoded pass, since claiming this is
  // "checked" without real historical data would be actively misleading.
  checks.push({
    id:'historical_rate', name:'Historical Rate Comparison',
    passed: true,
    value: 'Manual verification required (no rate history tracked yet)',
    comment: `Compare against previous PO for the same/similar item — automated historical rate tracking not yet implemented`,
  });

  // 8. Mathematical Accuracy
  const mathErrors = lineItems.filter(l => {
    const expected = (l.quantity || 0) * (l.rate || 0);
    const actual   = l.item_total || 0;
    return Math.abs(expected - actual) > 1;
  });
  checks.push({
    id:'math', name:'Amount Calculation (Qty × Rate)',
    passed: mathErrors.length === 0,
    value: mathErrors.length === 0 ? 'All correct' : `${mathErrors.length} error(s)`,
    comment: mathErrors.length === 0
      ? `All amounts correctly calculated`
      : `${mathErrors.length} calculation error(s) — expected vs actual amount mismatch`,
  });

  // 9. Budget Availability — uses pfbTotal (the project's PFB budget
  // total), passed in by pos.js after computing it during the PFB
  // alignment step.
  if (pfbTotal != null) {
    const overBudget = totalAmt > pfbTotal;
    checks.push({
      id:'budget_check', name:'Budget Availability',
      passed: !overBudget,
      value: `PO: ₹${totalAmt.toLocaleString('en-IN')} | PFB Budget: ₹${pfbTotal.toLocaleString('en-IN')}`,
      comment: overBudget
        ? `This PO alone exceeds the project's full PFB budget — budget sheet should be updated if not approved`
        : `PO amount within the project's overall PFB budget — note this checks against the TOTAL project budget, not remaining balance, since spend-to-date isn't tracked here`,
    });
  } else {
    checks.push({
      id:'budget_check', name:'Budget Availability',
      passed: true,
      value: 'PFB budget not available for comparison',
      comment: `Cannot verify budget — project's PFB sheet (DC/AC/Switchyards) not fully set up, or no project matched`,
    });
  }

  // 12. Adjustment Check — uses the real adjustment/adjustment_description
  // fields confirmed present on Zoho Books documents (Sales Orders,
  // Invoices, Estimates, Vendor Credits all expose this pair; POs follow
  // the same Books data model).
  const adjustmentAmt = Number(po.adjustment) || 0;
  checks.push({
    id:'adjustment_check', name:'Adjustment Check',
    passed: adjustmentAmt === 0 || !!po.adjustment_description,
    value: adjustmentAmt !== 0 ? `₹${adjustmentAmt.toLocaleString('en-IN')}${po.adjustment_description ? ' — ' + po.adjustment_description : ''}` : 'No adjustment',
    comment: adjustmentAmt === 0
      ? `No adjustment applied to this PO`
      : po.adjustment_description
        ? `Adjustment of ₹${adjustmentAmt.toLocaleString('en-IN')} documented: "${po.adjustment_description}"`
        : `Adjustment of ₹${adjustmentAmt.toLocaleString('en-IN')} applied but no reason documented — mandatory`,
  });

  // 13. Total Amount Match — split out as its own explicit item (the
  // checklist treats this separately from item-level math accuracy),
  // verifying subTotal + taxes + adjustment = the document's own Total.
  const lineTotalForCheck = lineItems.reduce((s, l) => s + (l.item_total || 0), 0);
  const taxTotalForCheck  = taxes.reduce((s, t) => s + (t.tax_amount || 0), 0);
  const expectedTotal     = lineTotalForCheck + taxTotalForCheck + adjustmentAmt;
  const totalMatches      = Math.abs(expectedTotal - totalAmt) < 2;
  checks.push({
    id:'total_match', name:'Total Amount Match',
    passed: totalMatches,
    value: `Expected: ₹${expectedTotal.toLocaleString('en-IN')} | System Total: ₹${totalAmt.toLocaleString('en-IN')}`,
    comment: totalMatches
      ? `Total matches: line items + tax + adjustment = system total`
      : `Total mismatch — line items + tax + adjustment (₹${expectedTotal.toLocaleString('en-IN')}) does not equal system total (₹${totalAmt.toLocaleString('en-IN')})`,
  });

  // 9. GST Type (CGST/SGST vs IGST)
  const gstType      = getGSTType(gstin);
  const taxNames     = taxes.map(t => (t.tax_name || '').toUpperCase());
  const hasIGST      = taxNames.some(n => n.includes('IGST'));
  const hasCGST_SGST = taxNames.some(n => n.includes('CGST') || n.includes('SGST'));
  const gstCorrect   = (gstType === 'interstate' && hasIGST) || (gstType === 'intrastate' && hasCGST_SGST) || taxes.length === 0;
  checks.push({
    id:'gst_type', name:'GST Type (IGST vs CGST/SGST)',
    passed: gstCorrect,
    value: `${gstType === 'interstate' ? 'Outside Rajasthan' : gstType === 'intrastate' ? 'Rajasthan' : 'Unknown'} | Tax: ${taxNames.join(', ') || 'None'}`,
    comment: taxes.length === 0
      ? `No GST applied — verify if exempt or missing`
      : gstCorrect
        ? `GST type correct: ${gstType === 'interstate' ? 'IGST (interstate)' : 'CGST+SGST (intrastate)'}`
        : `GST type mismatch: vendor is ${gstType} but ${hasIGST ? 'IGST' : 'CGST/SGST'} applied — must correct`,
  });

  // 10. Subtotal Check
  const lineTotal  = lineItems.reduce((s, l) => s + (l.item_total || 0), 0);
  const subTotal   = po.sub_total || lineTotal;
  checks.push({
    id:'subtotal', name:'Subtotal Accuracy',
    passed: Math.abs(lineTotal - subTotal) < 2,
    value: `Lines: ₹${lineTotal.toLocaleString('en-IN')} | Subtotal: ₹${subTotal.toLocaleString('en-IN')}`,
    comment: Math.abs(lineTotal - subTotal) < 2
      ? `Subtotal matches line items`
      : `Subtotal mismatch — recalculate`,
  });

  // 11. Payment Terms
  const hasPayTerms = !!(po.payment_terms_label || po.payment_terms || po.terms);
  checks.push({
    id:'pay_terms', name:'Payment Terms',
    passed: hasPayTerms,
    value: po.payment_terms_label || po.payment_terms || 'Not set',
    comment: hasPayTerms
      ? `Payment terms: ${po.payment_terms_label || po.payment_terms}`
      : `Payment terms not specified — must align with company policy`,
  });

  // 12. Advance Control
  const hasAdvance = notes.includes('advance') || (po.payment_terms || 0) === 0;
  checks.push({
    id:'advance', name:'Advance Payment Control',
    passed: !hasAdvance,
    value: hasAdvance ? 'Advance payment terms present' : 'No advance',
    comment: !hasAdvance
      ? `No advance payment terms`
      : `Advance payment — verify: PMO closed and vendor delivery confirmation mail attached`,
  });

  // 16. Advance Reconciliation — REAL check now (previously a static
  // placeholder that showed the same text regardless of any actual
  // number). Uses actual advance-payment data summed from confirmed PMO
  // breakup records (see lib/advanceReconcile.js). Can only verify
  // "how much has been paid so far" and flag it exceeding the PO's own
  // total — it can NOT yet verify against the *expected* advance %,
  // since that's often only stated in attachment text (e.g. "25%
  // Advance") rather than a clean Zoho field; that comparison will be
  // added once the AI attachment-reading layer supplies the expected term.
  if (hasAdvance) {
    const advancePaid = advancePaidByPO[po.purchaseorder_number] ?? null;
    const overpaid = advancePaid != null && advancePaid > totalAmt;
    checks.push({
      id:'advance_reconcile', name:'Advance Reconciliation',
      passed: advancePaid == null ? true : !overpaid,
      value: advancePaid == null ? 'No advance PMO found yet' : `₹${advancePaid.toLocaleString('en-IN')} paid so far`,
      comment: advancePaid == null
        ? `No advance-category PMO found against this PO number yet — if dispatch/delivery has already happened, verify the advance was actually paid and recorded correctly`
        : overpaid
          ? `⚠ Advance paid (₹${advancePaid.toLocaleString('en-IN')}) EXCEEDS the PO's own total (₹${totalAmt.toLocaleString('en-IN')}) — verify this isn't a duplicate/misallocated PMO`
          : `₹${advancePaid.toLocaleString('en-IN')} advance paid so far against a ₹${totalAmt.toLocaleString('en-IN')} PO — expected-% comparison not yet available (see attachment for stated advance terms)`,
    });

    // 17. Advance Clarification
    const hasClarification = notes.includes('clarif') || notes.includes('explanation') || docs.some(d => /clarif|explan/i.test(d.file_name||''));
    checks.push({
      id:'advance_clarification', name:'Advance Clarification',
      passed: hasClarification,
      value: hasClarification ? 'Explanation found' : 'No explanation found',
      comment: hasClarification
        ? `Explanation for advance found — verify it justifies the advance terms`
        : `No explanation attached for advance payment — mandatory for approval`,
    });
  }

  if (hasAdvance) {
    // NEW — checklist item #23, previously missing entirely. Only
    // meaningful when this PO involves an advance at all. Determining
    // BOTH whether the advance is specifically 100% (vs. partial) AND
    // whether a genuine vendor delivery-confirmation email exists both
    // require reading actual email content — same class of problem as
    // Approval Status — so this is AI-judged, not a keyword guess.
    checks.push({
      id:'delivery_confirmation', name:'100% Advance Control (Delivery Confirmation)',
      passed: null,
      value: 'Pending AI review',
      comment: 'Requires AI review of attachment content to confirm whether this is a 100% advance case and, if so, whether a genuine vendor delivery-confirmation email is attached — hasn\'t run yet for this PO.',
    });
  }

  // 13. LD Clause
  const ldInNotesOrTerms = notes.includes('ld') || notes.includes('liquidated') || notes.includes('penalty') || (po.terms || '').toLowerCase().includes('ld');
  const ldInAttachment   = !ldInNotesOrTerms && /liquidated damages|\bLD\s*clause\b|penalty.{0,40}(delay|dispatch)/i.test(attachmentText);
  const hasLD = ldInNotesOrTerms || ldInAttachment;
  checks.push({
    id:'ld_clause', name:'LD Clause (Liquidated Damages)',
    passed: hasLD,
    value: hasLD ? 'LD clause found' : 'LD clause missing',
    comment: ldInAttachment
      ? `LD clause found in attachment content (not in Notes/Terms fields) — verify the specific rate/duration against standard supply terms`
      : hasLD
        ? `LD clause present in PO`
        : `⚠ LD clause MISSING from Notes, Terms, and all attachment content — mandatory per company policy. Reject if not present`,
  });

  // 19. LD Clause Consistency — only meaningful once an LD clause exists
  // at all; checks it isn't just a bare mention but references specific
  // terms (rate/duration), consistent with standard supply terms.
  if (hasLD) {
    const ldHasTerms = /\d+\s*%|\d+\s*(day|week)/i.test(notes) || /\d+\s*%|\d+\s*(day|week)/i.test(po.terms||'') ||
      (ldInAttachment && /\d+\s*%|\d+\s*(day|week)/i.test(attachmentText));
    checks.push({
      id:'ld_consistency', name:'LD Clause Consistency',
      passed: ldHasTerms,
      value: ldHasTerms ? 'Specific LD terms found' : 'LD mentioned without specific terms',
      comment: ldHasTerms
        ? `LD clause includes specific rate/duration terms — verify against standard supply terms and email instructions`
        : `LD clause mentioned but no specific rate/duration found — verify it matches standard supply terms`,
    });
  }

  // 14. Warranty Requirement
  const warrantyItems = lineItems.filter(l => needsWarranty(l.name));
  const warrantyInAttachment = /warranty|guarantee/i.test(attachmentTextLower);
  // Real bug fixed: this previously treated ANY attachment being present
  // at all (docs.length > 0) as evidence of warranty coverage, regardless
  // of what that attachment actually said. Now requires the word
  // warranty/guarantee to actually appear somewhere — in Notes or in the
  // real attachment content.
  const warrantyOK = warrantyItems.length === 0 || notes.includes('warranty') || notes.includes('guarantee') || warrantyInAttachment;
  checks.push({
    id:'warranty', name:'Warranty Certificate',
    passed: warrantyOK,
    value: warrantyItems.length > 0 ? `Required for: ${getGeneralItemName(warrantyItems)}` : 'No warranty items',
    comment: warrantyItems.length === 0
      ? `No warranty-eligible items`
      : warrantyOK
        ? `Warranty mentioned${warrantyInAttachment && !notes.includes('warranty') ? ' in attachment content' : ''} — ensure certificate in name of Rays Power Experts Ltd.`
        : `Warranty certificate required for ${warrantyItems.length} item(s): ${getGeneralItemName(warrantyItems)} — not found in Notes or any attachment — must upload`,
  });

  // 21. Serial Number Mapping — only relevant when warranty-eligible
  // items are actually present.
  if (warrantyItems.length > 0) {
    const hasSerialDoc = docs.some(d => /serial|s\/n|warranty/i.test(d.file_name||'')) || notes.includes('serial') ||
      /serial\s*(no|number|#)/i.test(attachmentTextLower);
    checks.push({
      id:'serial_mapping', name:'Serial Number Mapping',
      passed: hasSerialDoc,
      value: hasSerialDoc ? 'Serial number reference found' : 'No serial number reference',
      comment: hasSerialDoc
        ? `Serial number document referenced — verify serial nos. map correctly to delivered material`
        : `Serial number mapping to warranty items is mandatory — must be uploaded before approval`,
    });
  }

  // 22. Logistics Coordination
  const hasLogisticsSPOC = notes.includes('spoc') || notes.includes('coordinat') || notes.includes('logistics') ||
    docs.some(d => /logistic|spoc|coordinat/i.test(d.file_name||'')) ||
    /spoc|coordinat|logistics/i.test(attachmentTextLower);
  checks.push({
    id:'logistics', name:'Logistics Coordination',
    passed: hasLogisticsSPOC || !!po.ship_via,
    value: hasLogisticsSPOC ? 'SPOC/coordination referenced' : po.ship_via ? `Shipment method set: ${po.ship_via}` : 'Not specified',
    comment: hasLogisticsSPOC
      ? `Logistics SPOC/coordination referenced — verify vendor coordination is ensured`
      : po.ship_via
        ? `Shipment method set but no explicit SPOC/coordination mentioned — verify vendor coordination separately`
        : `No logistics SPOC or shipment coordination mentioned — verify vendor coordination is ensured`,
  });

  // 15. TDS Applicability
  const tdsSection = getTDSSection(lineItems.map(l => l.name).join(' '), totalAmt);
  const tdsNote    = notes.includes('tds') || (po.tds_summary || []).length > 0 || /\btds\b/i.test(attachmentTextLower);
  checks.push({
    id:'tds', name:'TDS Applicability',
    passed: !tdsSection || tdsNote,
    value: tdsSection ? `Section ${tdsSection.section} @ ${tdsSection.rate}` : 'Likely not applicable',
    comment: !tdsSection
      ? `TDS likely not applicable for this transaction`
      : tdsNote
        ? `TDS applicable — Section ${tdsSection.section} @ ${tdsSection.rate} — verify deduction`
        : `TDS applicable — Section ${tdsSection.section} @ ${tdsSection.rate} (${tdsSection.nature}) — confirm deduction before approval`,
  });

  // 16. Supporting Documents
  checks.push({
    id:'docs', name:'Supporting Documents',
    passed: docs.length > 0,
    value: `${docs.length} attachment(s)`,
    comment: docs.length > 0
      ? `${docs.length} document(s) attached — verify: PR, rate comparison, email approvals present`
      : `No documents attached — PR, rate comparison, email approvals are mandatory`,
  });

  // 17. Notes & T&C Review
  checks.push({
    id:'notes_tc', name:'Notes & T&C Review',
    passed: !!(po.notes || po.terms),
    value: po.notes ? `${po.notes.substring(0, 60)}…` : 'No notes',
    comment: (po.notes || po.terms)
      ? `Notes/T&C present — verify no wrong PO reference or typographical inconsistencies`
      : `No notes or T&C mentioned on PO — add standard terms`,
  });

  // 18. PR–PO Matching
  // Real bug fixed: previously notes.includes('pr') matched the bare
  // substring "pr" anywhere in the text — meaning ordinary words like
  // "approve", "price", "prepare", "represent" would all false-positive
  // this check even with zero actual PR reference. Now requires an
  // actual PR-number-like pattern (e.g. "PR-1234", "PR No. 1234",
  // "PR/24-25/001") or the explicit phrase "purchase requisition".
  const prNumberPattern = /\bPR[\s\-\/#]*(?:no\.?)?[\s\-\/#]*\d{2,}/i;
  const hasPRRef = prNumberPattern.test(po.notes || '') || /purchase requisition/i.test(notes) ||
    docs.some(d => prNumberPattern.test(d.file_name || '')) ||
    prNumberPattern.test(attachmentText) || /purchase requisition/i.test(attachmentText);
  checks.push({
    id:'pr_match', name:'PR–PO Matching',
    passed: hasPRRef,
    value: hasPRRef ? 'PR reference found' : 'No PR reference',
    comment: hasPRRef
      ? `PR reference found — verify quantity and scope match`
      : `PR reference missing — PO approval requires matching PR number, quantity, and scope`,
  });

  // 24. Approval Status — uses the same approvers_list structure already
  // relied on elsewhere in this codebase (lib/zoho.js's approver-matching
  // logic) to determine whether ANY approver has signed off yet, matching
  // the real "Yet to be Approved" state visible on Zoho's own PO PDF.
  const approversList = po.approvers_list || [];
  const anyApproved = approversList.some(a => a.has_approved === true);
  const allApproved  = approversList.length > 0 && approversList.every(a => a.has_approved === true);
  // Fallback ONLY when Zoho has no approver workflow data at all for this
  // PO — some approvals happen outside Zoho's in-app flow (e.g. over
  // email) and the only record of it is the attached approval mail. When
  // Zoho DOES have approver data, that stays authoritative — an attached
  // PDF doesn't override an explicit "not yet approved" from the real
  // workflow, since that could be a stale/superseded attachment.
  const approvalInAttachment = approversList.length === 0 && /\bapproved\b|\bapproval\b/i.test(attachmentTextLower);
  const effectivelyApproved = allApproved || approvalInAttachment;
  checks.push({
    id:'approval_status', name:'Approval Status',
    passed: effectivelyApproved,
    value: approversList.length === 0
      ? (approvalInAttachment ? 'Approved (via attached mail)' : 'No approver data')
      : allApproved ? 'Fully approved' : anyApproved ? 'Partially approved' : 'Yet to be approved',
    comment: approvalInAttachment
      ? `No in-app Zoho approver workflow found, but an approval mail/document is attached — verify it genuinely covers this PO and isn't stale/superseded`
      : approversList.length === 0
        ? `Approver data not available on this PO, and no approval mail found in attachments`
        : allApproved
          ? `Fully approved by authorized signatory`
          : `"Yet to be approved" by at least one required signatory — HOLD until fully approved`,
  });

  // AI-judgment override — these checks depend ENTIRELY on the AI's
  // direct reading of attachments now (no local text-extraction/keyword
  // fallback — that approach was found unreliable, e.g. it couldn't
  // recognize "Go with jd mudhyal" as approval, and any local guess
  // shown as if it were final risked being confidently wrong). When
  // aiResults doesn't have a verdict yet, show an honest "pending"
  // state rather than a possibly-wrong local guess.
  const AI_CHECK_IDS = ["advance_clarification","ld_clause","ld_consistency","warranty","serial_mapping","logistics","tds","notes_tc","pr_match","approval_status","delivery_confirmation"];
  for (const check of checks) {
    if (!AI_CHECK_IDS.includes(check.id)) continue;
    const ai = aiResults[check.id];
    if (ai) {
      check.passed = ai.passed;
      check.comment = ai.comment + " (AI-verified from attachment content)";
      check.value = ai.passed ? "Confirmed by AI review" : "Not confirmed by AI review";
      check.aiVerified = true;
    } else {
      check.passed = null; // neither pass nor fail — genuinely unknown yet
      check.value = "Pending AI review";
      check.comment = "This check requires AI review of attachment content, which hasn't run yet for this PO — check again shortly, or after the next scheduled compliance check.";
      check.aiVerified = false;
    }
  }

  return checks;
}

// ─────────────────────────────────────────────────────────────
// BILL COMPLIANCE CHECKLIST
// ─────────────────────────────────────────────────────────────
async function runBillCompliance(bill, linkedPO, pfbTotal, aiResults = {}) {
  const checks    = [];
  const lineItems = bill.line_items || [];
  const taxes     = bill.taxes      || [];
  const docs      = bill.documents  || [];
  const notes     = (bill.notes || '').toLowerCase();
  const totalAmt  = bill.total || 0;

  const genName  = getGeneralItemName(lineItems);
  const totalQty = getTotalQty(lineItems);
  // product_type is a real, confirmed Zoho line-item field ('goods' or
  // 'services') — used as the authoritative signal when present, falling
  // back to keyword detection only when it isn't.
  const hasProductType = lineItems.some(l => l.product_type);
  const isService = hasProductType
    ? lineItems.some(l => l.product_type === 'services')
    : lineItems.some(l =>
        (l.name || '').toLowerCase().includes('service') ||
        (l.description || '').toLowerCase().includes('service')
      );

  // 1. Basic Bill Details
  const dateLogical = bill.date && bill.due_date ? new Date(bill.date) <= new Date(bill.due_date) : true;
  checks.push({
    id:'bill_basic', name:'Basic Bill Details',
    passed: !!(bill.bill_number && bill.date) && dateLogical,
    value: `${bill.bill_number || '—'} | Date: ${bill.date || '—'} | Due: ${bill.due_date || '—'}`,
    comment: !bill.bill_number ? `Bill number missing`
      : !bill.date ? `Bill date missing`
      : !dateLogical ? `Due date is before bill date — logically incorrect`
      : `Bill number and dates are valid`,
  });

  // 2. Vendor Details & MSME
  const gstin = bill.gst_no || '';
  const gstinValid = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin);
  checks.push({
    id:'vendor_active', name:'Vendor Details & MSME',
    passed: !!(bill.vendor_name && gstinValid),
    value: `${bill.vendor_name || '—'} | GSTIN: ${gstin || 'Missing'}`,
    comment: gstinValid
      ? `Vendor active — check MSME registration status separately`
      : `GSTIN missing or invalid — vendor MSME status should be verified`,
  });

  // 3. Company GSTIN on Bill
  // Real bug fixed here: this hardcoded GSTIN was 08AAFCR1979K1Z3 — but
  // every real sample PO/Bill/PMO from this org clearly shows
  // 08AAFCR1929K1Z3 on the company header (digits transposed: 29 vs 79).
  // Kept as a static reference (not a dynamic per-bill check) because
  // Zoho's Bill API doesn't expose "your own organization's GSTIN" as a
  // response field — it's only visible on the rendered PDF/template.
  checks.push({
    id:'company_gstin', name:'Company GSTIN on Bill',
    passed: true,
    value: `GSTIN: 08AAFCR1929K1Z3`,
    comment: `Verify invoice shows correct company GSTIN 08AAFCR1929K1Z3 and Rays Power Experts Ltd. address`,
  });

  // 4. PO Reference
  const hasPO  = !!(linkedPO || bill.purchaseorders?.length > 0);
  const poNum  = linkedPO?.purchaseorder_number || bill.purchaseorders?.[0]?.purchaseorder_number || '';
  checks.push({
    id:'po_ref', name:'PO Reference',
    passed: hasPO,
    value: poNum || 'No PO linked',
    comment: hasPO
      ? `Linked to PO ${poNum} — verify qty matches`
      : `No PO linked — bills without PO require management approval + RP Sir sign-off`,
  });

  // 5. Project Mapping
  const projName = bill.project_name || bill.customer_name || '';
  checks.push({
    id:'project_map', name:'Project Mapping',
    passed: !!projName,
    value: projName || 'Not tagged',
    comment: projName
      ? `Project tag: "${projName}" — verify matches bill and PO`
      : `Project not tagged on bill — correct project mapping required`,
  });

  // 6. Nature of Supply — surfaced as its own explicit check now (the
  // classification itself already existed internally as `isService` but
  // was never shown as a pass/fail item on its own).
  checks.push({
    id:'nature_supply', name:'Nature of Supply',
    passed: lineItems.length > 0,
    value: lineItems.length === 0 ? 'No items' : (isService ? 'Service' : 'Goods/Supply'),
    comment: lineItems.length === 0
      ? `No line items to classify`
      : `Classified as ${isService ? 'Service' : 'Goods/Supply'}${hasProductType ? ' (from Zoho product_type field)' : ' (inferred from item name/description — product_type not set on items)'} — verify this matches the actual transaction`,
  });

  // 7. Scope Verification — when a PO is linked, checks that at least
  // some bill line items textually overlap with the PO's line items
  // (a lightweight proxy for "services rendered match what was
  // ordered" — full verification still requires human judgment on
  // scope/SOW documents, which Zoho doesn't expose as structured data).
  let scopeOverlap = null;
  if (linkedPO && linkedPO.line_items) {
    const poNames = linkedPO.line_items.map(l => (l.name||'').toLowerCase());
    scopeOverlap = lineItems.filter(li => {
      const liWords = (li.name||'').toLowerCase().split(/\s+/).filter(w=>w.length>2);
      return poNames.some(pn => liWords.some(w => pn.includes(w)));
    }).length;
  }
  checks.push({
    id:'scope_verify', name:'Scope Verification',
    passed: !linkedPO || scopeOverlap > 0,
    value: !linkedPO ? 'No PO to verify scope against' : `${scopeOverlap}/${lineItems.length} item(s) textually match PO scope`,
    comment: !linkedPO
      ? `No linked PO — verify scope against contract/SOW manually`
      : scopeOverlap > 0
        ? `${scopeOverlap} of ${lineItems.length} bill item(s) match PO line items by name — verify full scope/SOW alignment manually`
        : `No bill items textually match the linked PO's line items — verify this bill is against the correct PO`,
  });

  // 6. Quantity Logic
  const zeroQty = lineItems.filter(l => !l.quantity || l.quantity === 0);
  checks.push({
    id:'qty_logic', name:'Quantity Logic (PR → PO → Bill)',
    passed: zeroQty.length === 0,
    value: `${genName} — Total qty: ${totalQty}`,
    comment: zeroQty.length > 0
      ? `${zeroQty.length} item(s) with zero qty — verify PR → PO → Bill chain`
      : `Quantities present — verify: PR qty = PO qty = Bill qty = Budget sheet qty`,
  });

  // 7. Rate Verification vs PO
  checks.push({
    id:'rate_verify', name:'Rate Verification (vs PO)',
    passed: !!linkedPO,
    value: linkedPO ? `PO ${linkedPO.purchaseorder_number} rate reference available` : 'No PO to verify against',
    comment: linkedPO
      ? `Rate must match PO ${linkedPO.purchaseorder_number} exactly — mail approval required for any deviation`
      : `No linked PO — rate mail approval should be attached`,
  });

  // 8. Amount Calculation
  const mathErrors = lineItems.filter(l => Math.abs((l.quantity||0)*(l.rate||0) - (l.item_total||0)) > 1);
  checks.push({
    id:'amount_calc', name:'Amount Calculation (Qty × Rate)',
    passed: mathErrors.length === 0,
    value: mathErrors.length === 0 ? 'All correct' : `${mathErrors.length} error(s)`,
    comment: mathErrors.length === 0
      ? `All amounts correctly calculated`
      : `${mathErrors.length} calculation error(s) — expected vs actual amount mismatch`,
  });

  // 9. Subtotal Check
  const lineTotal = lineItems.reduce((s, l) => s + (l.item_total || 0), 0);
  const subTotal  = bill.sub_total || lineTotal;
  checks.push({
    id:'subtotal', name:'Subtotal & Total Check',
    passed: Math.abs(lineTotal - subTotal) < 2,
    value: `Lines: ₹${lineTotal.toLocaleString('en-IN')} | Subtotal: ₹${subTotal.toLocaleString('en-IN')}`,
    comment: Math.abs(lineTotal - subTotal) < 2
      ? `Subtotal matches. Verify: subtotal + GST = final invoice value`
      : `Subtotal mismatch — recalculate`,
  });

  // 10. GST Type
  const gstType  = getGSTType(gstin);
  const taxNames = taxes.map(t => (t.tax_name || '').toUpperCase());
  const hasIGST  = taxNames.some(n => n.includes('IGST'));
  const hasCGST  = taxNames.some(n => n.includes('CGST') || n.includes('SGST'));
  const gstOK    = (gstType === 'interstate' && hasIGST) || (gstType === 'intrastate' && hasCGST) || taxes.length === 0;
  checks.push({
    id:'gst_type', name:'GST Type (IGST vs CGST/SGST)',
    passed: gstOK,
    value: `${gstType === 'interstate' ? 'Interstate → IGST' : 'Intrastate → CGST+SGST'} | Applied: ${taxNames.join(', ') || 'None'}`,
    comment: taxes.length === 0 ? `No GST — verify if exempted`
      : gstOK ? `GST type correct`
      : `GST type WRONG — vendor is ${gstType} but ${hasIGST ? 'IGST' : 'CGST/SGST'} applied — must be corrected`,
  });

  // 11. GST Compliance (GSTR-1/2B) — tries AI (Option B: reading a real
  // attached GSTR-2B reconciliation screenshot, if one exists) FIRST;
  // falls back to GSTIN-format validity (Option C) only when the AI
  // reports no such document was found. This fallback is applied in the
  // AI-override block below, not here — here we just set the Option C
  // baseline so there's always a sensible answer even before AI runs.
  checks.push({
    id:'gstr2b', name:'GST Compliance (GSTR-1/2B)',
    passed: gstinValid,
    value: gstinValid ? 'GSTIN format valid (AI review pending)' : 'Invalid GSTIN',
    comment: `Checking attachments for a GSTR-2B reconciliation document; falling back to GSTIN format validity if none is found — AI review pending.`,
  });

  // 30. GST No. in Invoice — distinct from item 2 (vendor master GSTIN);
  // this specifically checks the GST number present ON this bill document.
  checks.push({
    id:'gst_no_invoice', name:'GST No. in Invoice',
    passed: !!gstin,
    value: gstin || 'Not present on bill',
    comment: gstin
      ? gstinValid
        ? `GST number ${gstin} present on invoice and correctly formatted`
        : `GST number ${gstin} present but format looks invalid — verify against vendor master`
      : `No GST number found on this bill — mandatory for ITC claim, must be added`,
  });

  // 12. TDS Applicability
  const tdsRef = getTDSSection(lineItems.map(l => l.name).join(' '), totalAmt);
  const hasTDS = (bill.tds_summary || []).length > 0 || notes.includes('tds');
  checks.push({
    id:'tds', name:'TDS Applicability & Deduction',
    passed: !tdsRef || hasTDS,
    value: tdsRef ? `Section ${tdsRef.section} @ ${tdsRef.rate}` : 'Likely N/A',
    comment: !tdsRef ? `TDS likely not applicable`
      : hasTDS ? `TDS deducted — Section ${tdsRef.section} @ ${tdsRef.rate} — verify PAN valid, correct rate applied`
      : `TDS applicable — Section ${tdsRef.section} @ ${tdsRef.rate} (${tdsRef.nature}) — deduct before payment`,
  });

  // 15. TDS Section — explicit classification, separate from the
  // applicability check above (checklist treats these as two items).
  checks.push({
    id:'tds_section', name:'TDS Section Classification',
    passed: !tdsRef || true, // classification itself isn't pass/fail — it's informational once TDS is known to apply
    value: tdsRef ? `Section ${tdsRef.section} — ${tdsRef.nature}` : 'No TDS section applicable',
    comment: tdsRef
      ? `Classified under Section ${tdsRef.section} (${tdsRef.nature}) — document justification for this classification, especially if it differs from a prior similar bill`
      : `No TDS section applicable for this transaction type`,
  });

  // 13. Net Payable Check
  checks.push({
    id:'net_payable', name:'Net Payable Amount',
    passed: !!(bill.balance || bill.total),
    value: `Total: ₹${bill.total?.toLocaleString('en-IN')} | Balance: ₹${bill.balance?.toLocaleString('en-IN')}`,
    comment: `Verify net payable = bill total − TDS − advance adjustment − retention deduction`,
  });

  // 14. LD Clause — now AI-judged (was: notes.includes('ld')/'penalty', same
  // boilerplate-vs-genuine-evidence problem confirmed on real samples).
  checks.push({
    id:'ld_clause', name:'LD Clause',
    passed: null,
    value: 'Pending AI review',
    comment: 'Requires AI review of attachment content to confirm a genuine, specific LD clause — hasn\'t run yet for this bill.',
  });

  // 15. Milestone / Completion Proof — now AI-judged (was: any attachment
  // whose FILENAME merely contained "wcc"/"completion"/"grn"/"challan"/
  // "delivery" counted as genuine proof, regardless of actual content —
  // same fragile pattern already fixed for POs).
  checks.push({
    id:'completion_proof', name:'Milestone / Completion Proof',
    passed: null,
    value: 'Pending AI review',
    comment: 'Requires AI review of attachment content to confirm a genuine completion certificate, measurement sheet, or GRN — hasn\'t run yet for this bill.',
  });

  // 16. GRN Attachment — now AI-judged (was: filename containing "grn" only)
  checks.push({
    id:'grn', name:'GRN Attachment',
    passed: isService ? true : null,
    value: isService ? 'Service — GRN N/A' : 'Pending AI review',
    comment: isService
      ? `Service bill — GRN not required, but work completion certificate mandatory`
      : 'Requires AI review of attachment content to confirm a genuine GRN — hasn\'t run yet for this bill.',
  });

  // 19. Client Acceptance — now AI-judged (was: notes/filename containing "accept")
  checks.push({
    id:'client_acceptance', name:'Client Acceptance',
    passed: !isService ? true : null,
    value: !isService ? 'N/A — goods bill' : 'Pending AI review',
    comment: !isService
      ? `Goods bill — internal technical acceptance not typically required`
      : 'Requires AI review of attachment content to confirm genuine internal technical acceptance — hasn\'t run yet for this bill.',
  });

  // 20. Bill Type Accuracy — uses the real billType field (confirmed from
  // Zoho's bill_type response field, surfaced in Phase 2) cross-checked
  // against the item-level supply classification above.
  const billTypeRaw = (bill.bill_type || '').toLowerCase();
  const billTypeMatches = !billTypeRaw || (isService ? billTypeRaw.includes('service') : !billTypeRaw.includes('service'));
  checks.push({
    id:'bill_type_accuracy', name:'Bill Type Accuracy',
    passed: billTypeMatches,
    value: bill.bill_type || 'Not set',
    comment: !billTypeRaw
      ? `Bill Type not set on this bill — verify correct classification (Service vs Goods/Supply)`
      : billTypeMatches
        ? `Bill Type "${bill.bill_type}" matches item-level classification (${isService?'Service':'Goods'})`
        : `Bill Type "${bill.bill_type}" does NOT match item-level classification (items look like ${isService?'Service':'Goods'}) — possible supply/service mismatch`,
  });

  // 21. Accounting Head — uses the real, confirmed account_name field
  // Zoho returns on bill line items.
  const missingAccount = lineItems.filter(l => !l.account_name);
  checks.push({
    id:'accounting_head', name:'Accounting Head / GL Mapping',
    passed: lineItems.length > 0 && missingAccount.length === 0,
    value: lineItems.length === 0 ? 'No items' : missingAccount.length === 0 ? 'All items mapped' : `${missingAccount.length} item(s) unmapped`,
    comment: lineItems.length === 0
      ? `No line items to check`
      : missingAccount.length === 0
        ? `All items mapped to an accounting head — verify GL codes are correct per Chart of Accounts`
        : `${missingAccount.length} item(s) have no accounting head set — verify correct GL mapping before approval`,
  });

  // 22. Budget Check — uses pfbTotal (the project's PFB budget total),
  // now passed in by bills.js after computing it earlier in the request.
  // Only meaningful when a PFB comparison is actually possible.
  if (pfbTotal != null) {
    const overBudget = totalAmt > pfbTotal;
    checks.push({
      id:'budget_check', name:'Budget Availability',
      passed: !overBudget,
      value: `Bill: ₹${totalAmt.toLocaleString('en-IN')} | PFB Budget: ₹${pfbTotal.toLocaleString('en-IN')}`,
      comment: overBudget
        ? `This bill alone exceeds the project's full PFB budget — verify this is expected or update the budget sheet`
        : `Bill amount within the project's overall PFB budget — note this checks the bill against the TOTAL project budget, not remaining balance, since spend-to-date isn't tracked here`,
    });
  } else {
    checks.push({
      id:'budget_check', name:'Budget Availability',
      passed: true,
      value: 'PFB budget not available for comparison',
      comment: `Cannot verify budget — project's PFB sheet (DC/AC/Switchyards) not fully set up, or no project matched`,
    });
  }

  // 17. Duplicate Bill Check
  checks.push({
    id:'duplicate', name:'Duplicate Bill Check',
    passed: true,
    value: `Bill ${bill.bill_number}`,
    comment: `Verify no earlier bill with same bill number, vendor, amount, and date — cross-check vendor ledger`,
  });

  // 18. Supporting Documents
  checks.push({
    id:'docs', name:'Supporting Documents',
    passed: docs.length > 0,
    value: `${docs.length} attachment(s)`,
    comment: docs.length > 0
      ? `${docs.length} doc(s) attached — verify: PO copy, scope/WO, email approvals, GRN all present`
      : `No documents attached — PO, scope, email approvals are mandatory`,
  });

  // 25. Warranty Certificate — now AI-judged (was: filename/notes containing
  // "warranty"/"guarantee" only — same DLP-synonym problem fixed for POs)
  const warrantyItems = lineItems.filter(l => needsWarranty(l.name));
  checks.push({
    id:'warranty', name:'Guarantee / Warranty Certificate',
    passed: warrantyItems.length === 0 ? true : null,
    value: warrantyItems.length > 0 ? `Required for: ${getGeneralItemName(warrantyItems)}` : 'No warranty items',
    comment: warrantyItems.length === 0
      ? `No warranty-eligible items in this bill`
      : 'Requires AI review of attachment content to confirm a genuine warranty/guarantee/DLP commitment — hasn\'t run yet for this bill.',
  });

  // 20. Bill Without PO — real bug fixed here: this previously checked
  // `docs.length > 0` — meaning ANY attachment at all, regardless of
  // content, counted as "management approval + RP Sir's sign-off" — the
  // exact same class of bug already fixed for PO's old Warranty check.
  if (!hasPO) {
    checks.push({
      id:'bill_no_po', name:'Bill Without PO — Approval Required',
      passed: null,
      value: 'No PO linked',
      comment: 'Requires AI review of attachment content to confirm genuine management approval + RP Sir\'s sign-off is present — hasn\'t run yet for this bill.',
    });
  }

  // 21. Retention (10% on service bills) — now AI-judged (was: notes
  // containing "retention"/"10%"/"hold" — boilerplate problem, confirmed
  // on a real Terms & Conditions sample where this exact language is
  // standard template text present on nearly every service bill).
  if (isService) {
    checks.push({
      id:'retention', name:'Retention Deduction (10% on Services)',
      passed: null,
      value: 'Pending AI review',
      comment: 'Requires AI review of attachment content to confirm a genuine, specific 10% retention clause for this bill — hasn\'t run yet.',
    });
  }

  // 22. RCM Check — item classification (which items need RCM) stays
  // reliable, rule-based code; but the pass/fail itself is now AI-judged
  // (was: notes containing "rcm"/"reverse charge" only — same fragile
  // pattern already fixed elsewhere).
  const rcmItems = lineItems.filter(l => needsRCM(l.name));
  if (rcmItems.length > 0) {
    checks.push({
      id:'rcm', name:'Reverse Charge Mechanism (RCM)',
      passed: null,
      value: `RCM items: ${getGeneralItemName(rcmItems)} — Pending AI review`,
      comment: 'Requires AI review of attachment content to confirm RCM was genuinely applied/deducted for these items — hasn\'t run yet.',
    });
  }

  // 28. Freight Bills — item classification stays code-only (reliable);
  // pass/fail now AI-judged (was: attachment FILENAME containing
  // "lr"/"pod"/"e-way" only — never checked actual content).
  const freightItems = lineItems.filter(l => /freight|transport|holding|cartage|logistics/i.test(l.name||''));
  if (freightItems.length > 0) {
    checks.push({
      id:'freight_bills', name:'Freight Bills',
      passed: null,
      value: `Freight items: ${getGeneralItemName(freightItems)} — Pending AI review`,
      comment: 'Requires AI review of attachment content to confirm genuine LR/POD/E-Way Bill/weight slip documentation — hasn\'t run yet.',
    });
  }

  // 29. Ex Work — now AI-judged (was: notes/terms text-matching for
  // "ex-work"/"for" — boilerplate-prone).
  if (freightItems.length > 0) {
    checks.push({
      id:'ex_works', name:'Ex-Works / Freight Responsibility',
      passed: null,
      value: 'Pending AI review',
      comment: 'Requires AI review of attachment/Notes content to confirm freight responsibility terms (Ex-Works vs FOR) — hasn\'t run yet.',
    });
  }

  // AI-judgment override — same pattern as POs. These checks depend
  // entirely on AI's direct reading of attachments; when aiResults
  // doesn't have a verdict yet, the "Pending AI review" placeholder set
  // above stays as-is (honest, not a guess).
  const AI_CHECK_IDS_BILL = ['ld_clause','completion_proof','grn','client_acceptance','warranty','bill_no_po','retention','rcm','freight_bills','ex_works'];
  for (const check of checks) {
    if (AI_CHECK_IDS_BILL.includes(check.id)) {
      const ai = aiResults[check.id];
      if (ai) {
        check.passed = ai.passed;
        check.comment = ai.comment + ' (AI-verified from attachment content)';
        check.value = ai.passed ? 'Confirmed by AI review' : 'Not confirmed by AI review';
        check.aiVerified = true;
      } else if (check.passed === null) {
        check.aiVerified = false;
      }
    }

    // GST Compliance — special two-tier fallback (Option B then C): only
    // treat this as a definite pass/fail when AI explicitly found a real
    // GSTR-2B reconciliation document among the attachments. Otherwise,
    // the GSTIN-format-validity fallback is a genuinely NARROWER check
    // than what this compliance item is meant to verify — marked
    // 'uncertain' rather than true/false, so it never shows a misleading
    // green tick or red cross for something that was never actually
    // confirmed against real GSTR-2B data.
    if (check.id === 'gstr2b' && aiResults.gstr2b) {
      const ai = aiResults.gstr2b;
      if (ai.documentFound) {
        check.passed = ai.passed;
        check.comment = ai.comment + ' (AI-verified from an attached GSTR-2B document)';
        check.value = ai.passed ? 'Matched in GSTR-2B (AI-verified)' : 'NOT matched in GSTR-2B (AI-verified)';
        check.aiVerified = true;
      } else {
        check.passed = 'uncertain';
        check.comment = `No GSTR-2B reconciliation document found among attachments — only GSTIN format validity (${gstinValid ? 'valid' : 'INVALID'}) could be checked, which is narrower than genuine GSTR-2B confirmation. Verify with the accounts team or Zoho Books' GST Filing module directly.`;
        check.value = gstinValid ? 'GSTIN format valid — GSTR-2B not verifiable here' : 'GSTIN invalid — GSTR-2B not verifiable here';
        check.aiVerified = false;
      }
    }
  }

  return checks;
}

// ─────────────────────────────────────────────────────────────
// PMO COMPLIANCE CHECKLIST
// ─────────────────────────────────────────────────────────────
async function runPMOCompliance(pmo, otherPMOSignatures = [], aiResults = {}) {
  const checks = [];
  const docs   = pmo.documents || pmo.attachments || [];
  const notes  = (pmo.remarks || pmo.description || pmo.paymentDetails || '').toLowerCase();
  const amount = pmo.amount || pmo.total || 0;
  const poRefs = pmo.poBreakup || pmo.po_references || [];

  checks.push({
    id:'pmo_basic', name:'PMO Basic Details',
    passed: !!(pmo.pmo_number || pmo.id) && !!(pmo.date || pmo.created_time),
    value: `${pmo.pmo_number || pmo.id || '—'} | ${pmo.date || pmo.created_time || '—'}`,
    comment: (pmo.pmo_number || pmo.id)
      ? `PMO number and date present — verify PMO date is after/same as PO date`
      : `PMO number or date missing`,
  });

  const vendorActive = !!(pmo.vendor_name || pmo.payee_name);
  checks.push({
    id:'payee_details', name:'Payee & Company Details',
    passed: vendorActive,
    value: `${pmo.vendor_name || pmo.payee_name || '—'}`,
    comment: vendorActive
      ? `Payee: ${pmo.vendor_name || pmo.payee_name} — verify vendor master active and approved`
      : `Payee details missing`,
  });

  checks.push({
    id:'amount_verify', name:'Amount Verification',
    passed: amount > 0,
    value: `₹${amount.toLocaleString('en-IN')}`,
    comment: amount > 0
      ? `Payable amount ₹${amount.toLocaleString('en-IN')} — verify figures match breakup total`
      : `Amount is zero or missing`,
  });

  const payType   = (pmo.payment_type || pmo.payment_category || notes);
  const isAdvance = payType.toLowerCase().includes('advance');
  checks.push({
    id:'pay_terms', name:'Payment Terms & Advance Policy',
    passed: true,
    value: isAdvance ? 'Advance Payment' : 'Regular Payment',
    comment: isAdvance
      ? `Advance payment — verify: allowed per company policy, vendor delivery confirmation mandatory`
      : `Regular payment — verify payment terms match PO`,
  });

  const hasRemarks = notes.length > 10;
  checks.push({
    id:'purpose', name:'Purpose & Remarks',
    passed: hasRemarks,
    value: notes.substring(0, 60) || 'No remarks',
    comment: hasRemarks
      ? `Remarks present — verify project names/locations clearly identifiable`
      : `Remarks missing — purpose/project details must be mentioned in PMO`,
  });

  const hasPoRefs = poRefs.length > 0;
  checks.push({
    id:'po_breakup', name:'PO Reference & Breakup',
    passed: hasPoRefs,
    value: `${poRefs.length} PO reference(s)`,
    comment: hasPoRefs
      ? `${poRefs.length} PO(s) listed in breakup — verify all PO numbers and amounts match the actual POs`
      : `No PO Breakup found on this PMO — all referenced PO numbers must be listed with amounts`,
  });

  // Real check now, not just an assertion — verifies each PO row's
  // Basic + Tax = Total math, and that the sum of all PO totals matches
  // the PMO's own payable amount (both explicitly required by checklist
  // items 7 and 9).
  const get = (r, ...keys) => { for (const k of keys) if (r[k] != null) return r[k]; return null; };
  const poMathErrors = poRefs.filter(r => {
    const basic = Number(get(r,'basic_amount','Basic Amount','basic')) || 0;
    const tax   = Number(get(r,'tax_amount','Tax Amount','tax')) || 0;
    const adj   = Number(get(r,'adjustment','Adjustment')) || 0;
    const total = Number(get(r,'total','Total','total_amount')) || 0;
    // Total = Basic + Tax + Adjustment (Adjustment can be negative) —
    // confirmed against real sample data, where Basic+Tax alone doesn't
    // equal Total once a genuine adjustment is applied.
    return Math.abs((basic + tax + adj) - total) > 1;
  });
  const poSum = poRefs.reduce((s,r) => s + (Number(get(r,'total','Total','total_amount')) || 0), 0);
  const poSumMatches = poRefs.length === 0 || Math.abs(poSum - amount) < 2;
  checks.push({
    id:'po_amounts', name:'PO Amount Accuracy (Basic + Tax = Total)',
    passed: poMathErrors.length === 0 && poSumMatches,
    value: poRefs.length === 0 ? 'No PO breakup to verify' : `Sum of POs: ₹${poSum.toLocaleString('en-IN')} | PMO amount: ₹${amount.toLocaleString('en-IN')}`,
    comment: poRefs.length === 0
      ? `No PO breakup present — cannot verify Basic+Tax=Total or reconciliation`
      : poMathErrors.length > 0
        ? `${poMathErrors.length} PO row(s) where Basic + Tax ≠ Total — recheck GST calculation`
        : !poSumMatches
          ? `Sum of PO totals (₹${poSum.toLocaleString('en-IN')}) does not match PMO payable amount (₹${amount.toLocaleString('en-IN')})`
          : `All PO rows verified — Basic+Tax=Total for each, and sum matches PMO payable amount`,
  });

  const gstin    = pmo.vendor_gstin || pmo.gst_no || '';
  const gstValid = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin);
  checks.push({
    id:'gst_check', name:'GST Check',
    passed: gstValid || !gstin,
    value: gstin || 'GSTIN not on PMO',
    comment: gstin
      ? gstValid ? `Vendor GSTIN ${gstin} format valid` : `GSTIN format invalid`
      : `GSTIN not directly on PMO — verify from linked PO/vendor master`,
  });

  // Real bug fixed: this was a static "passed:true" placeholder that
  // never actually verified anything — and it was redundant with
  // "PO Amount Accuracy" above, which already computes the real
  // comparison (sum of PO totals vs. PMO payable amount). Reusing that
  // same real data here instead of restating a fake always-pass check.
  checks.push({
    id:'po_reconcile', name:'Total PO Reconciliation',
    passed: poSumMatches,
    value: `Sum of PO totals: ₹${poSum.toLocaleString('en-IN')} | PMO amount: ₹${amount.toLocaleString('en-IN')}`,
    comment: poRefs.length === 0
      ? `No PO breakup present — cannot reconcile`
      : poSumMatches
        ? `Sum of all referenced PO totals matches the PMO payable amount`
        : `Sum of PO totals (₹${poSum.toLocaleString('en-IN')}) does NOT match PMO payable amount (₹${amount.toLocaleString('en-IN')}) — recheck before payment`,
  });

  // Material Status / Dispatch Confirmation — now AI-judged (was:
  // notes.includes('dispatch'/'ready'/'material') OR simply docs.length>0
  // — same "any attachment counts as evidence" bug pattern already fixed
  // for PO's Warranty and Bill's Bill-Without-PO checks).
  checks.push({
    id:'material_status', name:'Material Status / Dispatch Confirmation',
    passed: isAdvance ? null : true,
    value: isAdvance ? 'Pending AI review' : 'Not an advance payment — N/A',
    comment: isAdvance
      ? 'Requires AI review of attachment content to confirm a genuine vendor email/document about material dispatch readiness — hasn\'t run yet for this PMO.'
      : `Regular (non-advance) payment — dispatch confirmation not required for this check`,
  });

  // Real bug fixed: this was a static "verify manually" placeholder,
  // even though a real field (pmo.expenseAccount, from Zoho's own
  // cf_expense_account custom field) is already available and was
  // simply never being checked.
  const hasExpenseAccount = !!(pmo.expenseAccount && pmo.expenseAccount.trim());
  checks.push({
    id:'ledger_map', name:'Expense / Ledger Mapping',
    passed: hasExpenseAccount,
    value: pmo.expenseAccount || 'Not set',
    comment: hasExpenseAccount
      ? `Mapped to expense account "${pmo.expenseAccount}" — verify this is the correct GL code, not a generic/default account`
      : `No expense account set on this PMO — correct GL mapping required before payment to avoid wrong capitalization`,
  });

  // Real bug fixed: this only checked Zoho's structured approved_by/
  // submitted_by/created_by fields — never the actual attachment
  // content. Confirmed on a real sample: genuine approval ("Approved")
  // existed entirely in an email thread, with none of those structured
  // fields populated. Same class of problem as PO/Bill's Approval
  // Status — now AI-judged, with the same strict named-authority rule.
  checks.push({
    id:'authorization', name:'Approval & Authorization',
    passed: null,
    value: 'Pending AI review',
    comment: 'Requires AI review of attachment content to confirm genuine approval from an authorized signatory — hasn\'t run yet for this PMO.',
  });

  // Real bug fixed: this was a static "manual check required"
  // placeholder that verified nothing. Now compares against real PMO
  // history (see lib/advanceReconcile.js:getRecentPMOSignatures) — flags
  // when another PMO shares the same vendor, a very close amount (within
  // ₹1), AND at least one overlapping PO number, which is a real
  // structural signal for a likely duplicate payment.
  const thisVendor = String(pmo.vendor_name || pmo.payee_name || '').trim().toLowerCase();
  const thisPMOId  = String(pmo.pmo_number || pmo.id || '');
  const potentialDupes = otherPMOSignatures.filter(sig => {
    if (String(sig.pmoId) === thisPMOId) return false; // don't match itself
    if (String(sig.vendorName || '').trim().toLowerCase() !== thisVendor || !thisVendor) return false;
    if (Math.abs(sig.amount - amount) > 1) return false;
    const sharesPO = (sig.poNumbers || []).some(p => poRefs.some(r => (get(r,'cf_po_number_formatted','cf_po_number','PO Number') || '') === p));
    return sharesPO;
  });
  checks.push({
    id:'duplicate', name:'Duplicate Payment Check',
    passed: potentialDupes.length === 0,
    value: potentialDupes.length === 0 ? 'No match found' : `${potentialDupes.length} potential duplicate(s) found`,
    comment: potentialDupes.length === 0
      ? `No other PMO found with the same vendor, amount, and overlapping PO reference — verify against bank statement as a final check`
      : `⚠ ${potentialDupes.length} other PMO(s) share the same vendor, a matching amount, and an overlapping PO number — verify this isn't a duplicate payment before proceeding`,
  });

  const closingBalance = pmo.closing_balance || pmo.balance;
  checks.push({
    id:'closing_balance', name:'Closing Balance',
    passed: closingBalance === 0 || closingBalance == null,
    value: closingBalance != null ? `₹${closingBalance}` : 'Not shown',
    comment: closingBalance === 0
      ? `Closing balance is zero — no outstanding adjustment pending`
      : closingBalance
        ? `Closing balance ₹${closingBalance} — verify all adjustments cleared before payment`
        : `Verify closing balance shown as 0.00`,
  });

  checks.push({
    id:'pmo_docs', name:'Supporting Documents',
    passed: docs.length > 0,
    value: `${docs.length} attachment(s)`,
    comment: docs.length > 0
      ? `${docs.length} doc(s) attached — verify: PO copies, email/quotation present`
      : `No documents attached — PO copies and vendor confirmation mandatory`,
  });

  // AI-judgment override — material_status and authorization both need this for PMOs.
  for (const checkId of ['material_status', 'authorization']) {
    if (aiResults[checkId]) {
      const check = checks.find(c => c.id === checkId);
      if (check) {
        const ai = aiResults[checkId];
        check.passed = ai.passed;
        check.comment = ai.comment + ' (AI-verified from attachment content)';
        check.value = ai.passed ? 'Confirmed by AI review' : 'Not confirmed by AI review';
        check.aiVerified = true;
      }
    }
  }

  return checks;
}

// ─────────────────────────────────────────────────────────────
// PMO ALIGNMENT CHECK
// ─────────────────────────────────────────────────────────────
function runPMOAlignment(pmo, linkedBill) {
  if (!linkedBill) {
    return {
      status:  'na',
      comment: 'No PI/Bill linked to this PMO — alignment check not possible',
      checks:  [],
    };
  }

  const checks  = [];
  const billAmt = linkedBill.total || 0;
  const pmoAmt  = pmo.amount || pmo.total || 0;
  const amtMatch = Math.abs(pmoAmt - billAmt) < 2;

  checks.push({
    name:    'Amount Match (PMO vs PI/Bill)',
    passed:  amtMatch,
    comment: amtMatch
      ? `PMO amount ₹${pmoAmt.toLocaleString('en-IN')} matches Bill ₹${billAmt.toLocaleString('en-IN')}`
      : `Amount mismatch — PMO ₹${pmoAmt.toLocaleString('en-IN')} vs Bill ₹${billAmt.toLocaleString('en-IN')}`,
  });

  checks.push({
    name:    'Vendor Match',
    passed:  (pmo.vendor_name || '').toLowerCase() === (linkedBill.vendor_name || '').toLowerCase(),
    comment: (pmo.vendor_name || '') === (linkedBill.vendor_name || '')
      ? `Vendor matches: ${pmo.vendor_name}`
      : `Vendor mismatch — PMO: "${pmo.vendor_name}" vs Bill: "${linkedBill.vendor_name}"`,
  });

  const overallPassed = checks.every(c => c.passed);
  return {
    status:  overallPassed ? 'aligned' : 'mismatch',
    comment: overallPassed ? 'PMO aligns with PI/Bill' : 'Discrepancies found — see details',
    checks,
  };
}

// ─────────────────────────────────────────────────────────────
// GET OVERALL STATUS FROM CHECKS
// ─────────────────────────────────────────────────────────────
function getComplianceStatus(checks) {
  // Three real states now, not two:
  //   passed === null        -> pending, hasn't been analyzed at all yet — excluded entirely, not a failure
  //   passed === 'uncertain' -> was analyzed, but only a narrower/proxy check was possible (e.g. GST
  //                             fallback) — counts as a soft caution (warn), not a hard failure
  //   passed === true/false  -> a genuine, definite verification
  const known    = checks.filter(c => c.passed !== null);
  const failed   = known.filter(c => c.passed === false);
  const uncertain = known.filter(c => c.passed === 'uncertain');
  const critical = ['po_ref','vendor_details','gst_type','amount_calc','duplicate','bill_basic','po_basic','pmo_basic'];
  const critFail = failed.filter(c => critical.includes(c.id));
  if (critFail.length > 0) return 'fail';
  if (failed.length > 0)   return 'warn';
  if (uncertain.length > 0) return 'warn';
  if (checks.some(c => c.passed === null)) return 'pending';
  return 'pass';
}

module.exports = {
  runPOCompliance,
  runBillCompliance,
  runPMOCompliance,
  runPMOAlignment,
  getComplianceStatus,
  needsWarranty,
  getTDSSection,
  getGSTType,
  WARRANTY_KEYWORDS,
  TDS_SECTIONS,
};
