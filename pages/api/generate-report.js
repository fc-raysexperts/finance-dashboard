// pages/api/generate-report.js
//
// Generates the "Download Review Report" PDF - mirrors as much of the
// popup's real content as reasonably fits on a page, using pdf-lib
// (confirmed pure-JS, serverless-safe).
//
// Two real bugs fixed this round:
// 1. pdf-lib does NOT auto-wrap long text at all - text just overflows
//    past its box. Every long comment/description was overlapping the
//    next line because line-height was only ever reserved for ONE line
//    regardless of actual content length. Fixed with real word-wrapping
//    that measures actual text width and breaks it into as many lines as
//    genuinely needed, correctly advancing the cursor for each one.
// 2. item.recommendation is a real object {decision, color, reasons},
//    not a string - it was being JSON.stringify'd directly into the PDF,
//    which is exactly the "raw code" that was showing up. Now parsed and
//    written as plain English sentences.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const config = {
  api: {
    responseLimit: false,
    bodyParser: { sizeLimit: '10mb' },
  },
};

const PAGE_WIDTH = 595, PAGE_HEIGHT = 842; // A4
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

function fmt(n) {
  if (n == null || n === '') return '-';
  return 'Rs ' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { item, type } = req.body;
    const isBill = type === 'bill', isPMO = type === 'pmo';

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN;

    function ensureSpace(neededHeight) {
      if (y - neededHeight < MARGIN) {
        page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
    }

    function sanitizeText(str) {
      return String(str ?? '-')
        .replace(/[\u2192\u2190\u2191\u2193]/g, '->')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/[\u2022\u25CF]/g, '*')
        .replace(/[\u2026]/g, '...')
        .replace(/[^\x00-\xFF]/g, '')
        .trim();
    }

    // Real fix for the overlap bug: pdf-lib has no built-in word-wrap.
    // This measures actual rendered width and breaks text into however
    // many lines are genuinely needed to fit maxWidth, word by word.
    function wrapLines(str, useFont, size, maxWidth) {
      const clean = sanitizeText(str);
      const words = clean.split(/\s+/);
      const lines = [];
      let current = '';
      words.forEach(w => {
        const trial = current ? current + ' ' + w : w;
        if (useFont.widthOfTextAtSize(trial, size) > maxWidth && current) {
          lines.push(current);
          current = w;
        } else {
          current = trial;
        }
      });
      if (current) lines.push(current);
      return lines.length ? lines : [''];
    }

    // Writes text with REAL wrapping - correctly advances y by exactly as
    // many lines as the content actually needs, so nothing after it can
    // ever overlap.
    function text(str, opts = {}) {
      const size = opts.size || 10;
      const useFont = opts.bold ? bold : font;
      const color = opts.color || rgb(0.1, 0.1, 0.15);
      const maxWidth = opts.maxWidth || CONTENT_WIDTH;
      const x = opts.x || MARGIN;
      const lineHeight = opts.lineHeight || size + 4;
      const lines = wrapLines(str, useFont, size, maxWidth - (x - MARGIN));
      lines.forEach(line => {
        ensureSpace(lineHeight);
        page.drawText(line, { x, y, size, font: useFont, color });
        y -= lineHeight;
      });
    }

    function sectionHeader(str) {
      ensureSpace(30);
      y -= 6;
      page.drawRectangle({ x: MARGIN, y: y - 4, width: CONTENT_WIDTH, height: 20, color: rgb(0.92, 0.95, 1) });
      page.drawText(sanitizeText(str), { x: MARGIN + 6, y, size: 12, font: bold, color: rgb(0.09, 0.25, 0.65) });
      y -= 26;
    }

    // A labeled field grid (matches the popup's InfoGrid look) - N fields
    // per row, each with a small gray label and a value beneath it.
    function fieldGrid(fields, perRow = 3) {
      const colWidth = CONTENT_WIDTH / perRow;
      const visible = fields.filter(f => f[1] != null && f[1] !== '' && f[1] !== '-');
      for (let i = 0; i < visible.length; i += perRow) {
        const rowFields = visible.slice(i, i + perRow);
        ensureSpace(32);
        const rowY = y;
        rowFields.forEach((f, j) => {
          const x = MARGIN + j * colWidth;
          page.drawText(sanitizeText(f[0]).toUpperCase(), { x, y: rowY, size: 7, font: bold, color: rgb(0.55, 0.6, 0.68) });
          const lines = wrapLines(String(f[1]), font, 9, colWidth - 8);
          lines.slice(0, 2).forEach((line, li) => {
            page.drawText(line, { x, y: rowY - 11 - li * 11, size: 9, font, color: rgb(0.08, 0.08, 0.12) });
          });
        });
        y = rowY - 32;
      }
      y -= 4;
    }

    function tableRow(cells, widths, opts = {}) {
      ensureSpace(16);
      let x = MARGIN;
      const useFont = opts.bold ? bold : font;
      const size = opts.size || 8.5;
      cells.forEach((c, i) => {
        const lines = wrapLines(String(c ?? '-'), useFont, size, widths[i] - 4);
        page.drawText(lines[0] || '-', { x, y, size, font: useFont, color: opts.color || rgb(0.15, 0.15, 0.2) });
        x += widths[i];
      });
      y -= 14;
    }

    // ── Header ──
    const title = isPMO ? `PMO ${item.pmoNumber}` : isBill ? `Bill ${item.billNumber}` : `PO ${item.poNumber}`;
    text(title, { size: 18, bold: true, color: rgb(0.09, 0.25, 0.65), lineHeight: 24 });
    text(item.vendor || '-', { size: 11, bold: true });
    y -= 4;

    // ── General Details ── (mirrors the popup's Part A/B/C fields)
    sectionHeader('General Details');
    if (isBill) {
      fieldGrid([
        ['Order Number', (item.linkedPO && item.linkedPO.number) || item.orderNumber],
        ['Bill Date', item.date], ['Due Date', item.dueDate],
        ['Payment Terms', item.paymentTerms], ['Balance Due', fmt(item.balance)], ['Total', fmt(item.total)],
        ['Transaction Posting Date', item.transactionPostingDate],
        ['Vendor', item.vendor], ['Vendor GSTIN', item.gstin],
        ['PO Amount', item.linkedPO ? fmt(item.linkedPO.total) : null],
        ['Location', item.locationName], ['Project (PFB Match)', item.projectMatched],
        ['Submitted By', item.submittedBy], ['Submitted Date', item.submittedDate],
        ['Vendor Address', item.vendorAddress],
      ], 3);
      if (item.originalReferenceBillNumber || item.billProjectName || item.billType) {
        sectionHeader('Custom Fields');
        fieldGrid([
          ['Original Reference Bill Number', item.originalReferenceBillNumber],
          ['Project Name', item.billProjectName],
          ['Bill Type', item.billType],
        ], 3);
      }
    } else if (!isPMO) {
      fieldGrid([
        ['Reference#', item.referenceNumber], ['Order Date', item.date], ['Delivery Date', item.deliveryDate],
        ['Payment Terms', item.paymentTerms], ['Kind Attention', item.kindAttention], ['Subject', item.subject],
        ['Quotation', item.quotation], ['Project', item.projectLabel],
        ['Vendor', item.vendor], ['Vendor GSTIN', item.gstin], ['Total Amount', fmt(item.total)], ['PFB Budget', fmt(item.pfbTotal)],
        ['Location', item.locationName], ['Project (PFB Match)', item.projectMatched],
        ['Submitted By', item.submittedBy], ['Submitted Date', item.submittedDate],
        ['Vendor Address', item.vendorAddress], ['Delivery Address', item.deliverTo],
      ], 3);
    } else {
      fieldGrid([
        ['PMO Number', item.pmoNumber], ['PMO Date', item.date], ['Payable Amount', fmt(item.amount)],
        ['Payment Category', item.paymentCategory], ['Payment Sub-Category', item.paymentSubCat], ['Payment Type', item.paymentType],
        ['Vendor Name', item.vendor], ['Customer Name', item.customerName], ['Closing Balance', fmt(item.closingBalance)],
        ['Remarks', item.remarks], ['Payment Terms', item.paymentTerms],
      ], 3);
      // Matches the popup's "Vendor/Customer" section
      sectionHeader('Vendor/Customer');
      fieldGrid([
        ['Vendor Name', item.vendor], ['Customer Name', item.customerName],
        ['Expense Account', item.expenseAccount], ['Closing Balance', fmt(item.closingBalance)],
      ], 2);
    }

    // ── PMO-specific: PO/Expense Breakup tables (PMOs have no traditional
    // Line Items table - this is what actually replaces it in the popup) ──
    if (isPMO && item.poBreakup && item.poBreakup.length > 0) {
      sectionHeader('PO Breakup');
      const hasAnyTax = item.poBreakup.some(r => r.tax_amount != null);
      const hasAnyAdj = item.poBreakup.some(r => r.adjustment != null);
      const cols = [{h:'PO Number',w:120}];
      if (hasAnyTax) cols.push({h:'Tax Amount',w:90});
      cols.push({h:'Basic Amount',w:100});
      if (hasAnyAdj) cols.push({h:'Adjustment',w:90});
      cols.push({h:'Total',w:100});
      tableRow(cols.map(c=>c.h), cols.map(c=>c.w), { bold: true });
      item.poBreakup.forEach(r => {
        const row = [r.po_number || '-'];
        if (hasAnyTax) row.push(r.tax_amount != null ? fmt(r.tax_amount) : '-');
        row.push(r.basic_amount != null ? fmt(r.basic_amount) : '-');
        if (hasAnyAdj) row.push(r.adjustment != null ? fmt(r.adjustment) : '-');
        row.push(r.total != null ? fmt(r.total) : '-');
        tableRow(row, cols.map(c=>c.w));
      });
      y -= 4;
    }
    if (isPMO && item.expenseBreakup && item.expenseBreakup.length > 0) {
      sectionHeader('Expense Breakup');
      const cols = [{h:'Expense Detail',w:280},{h:'Basic Amount',w:130},{h:'Total',w:130}];
      tableRow(cols.map(c=>c.h), cols.map(c=>c.w), { bold: true });
      item.expenseBreakup.forEach(r => {
        tableRow([r.expense_detail || '-', r.basic_amount != null ? fmt(r.basic_amount) : '-', r.total != null ? fmt(r.total) : '-'], cols.map(c=>c.w));
      });
      y -= 4;
    }
    // ── PMO-specific: "To be filled by Finance Team" section, matching
    // the real popup exactly ──
    if (isPMO && (item.paymentDate || item.paymentDetails)) {
      sectionHeader('To be filled by Finance Team');
      fieldGrid([['Payment Date', item.paymentDate], ['Payment Details', item.paymentDetails]], 2);
    }

    // ── Notes / Terms ──
    if (item.notes) { sectionHeader('Notes'); text(item.notes, { size: 9 }); }
    if (!isBill && !isPMO && item.terms) { sectionHeader('Terms & Conditions'); text(item.terms, { size: 9 }); }

    // ── Line Items ──
    const lineItems = item.lineItems || item.line_items || [];
    if (lineItems.length > 0) {
      sectionHeader('Line Items');
      const hasProject = lineItems.some(li => li.project_name);
      const cols = hasProject
        ? [{h:'Item',w:180},{h:'Project',w:80},{h:'Qty',w:60},{h:'Rate',w:90},{h:'Amount',w:90}]
        : [{h:'Item',w:260},{h:'Qty',w:60},{h:'Rate',w:90},{h:'Amount',w:90}];
      tableRow(cols.map(c=>c.h), cols.map(c=>c.w), { bold: true });
      lineItems.forEach(li => {
        const row = hasProject
          ? [li.name, li.project_name, li.quantity, fmt(li.rate), fmt(li.item_total)]
          : [li.name, li.quantity, fmt(li.rate), fmt(li.item_total)];
        tableRow(row, cols.map(c=>c.w));
      });
      y -= 4;
      text(`Sub Total: ${fmt(item.subTotal)}   |   Total: ${fmt(item.total)}`, { size: 9, bold: true });
      y -= 4;
    }

    // ── Compliance Checks (full comments, properly wrapped) ──
    if (item.compliance && item.compliance.length > 0) {
      const passCount = item.compliance.filter(c => c.passed).length;
      sectionHeader(`${isPMO ? 'PMO' : isBill ? 'Bill' : 'PO'} Compliance Checks (${passCount}/${item.compliance.length} passed)`);
      item.compliance.forEach(c => {
        const mark = c.passed ? '[PASS]' : '[FLAG]';
        const color = c.passed ? rgb(0.08, 0.5, 0.2) : rgb(0.75, 0.15, 0.15);
        text(`${mark} ${c.name}`, { size: 9.5, bold: true, color, lineHeight: 12 });
        if (c.comment) text(c.comment, { size: 8.5, x: MARGIN + 12, color: rgb(0.38, 0.38, 0.44), maxWidth: CONTENT_WIDTH, lineHeight: 11 });
      });
      y -= 4;
    }

    // ── PMO-specific: PI/Bill Alignment (genuinely different from PFB
    // Alignment - checks against the PI/Bill breakup, not PFB scope
    // items) ──
    if (isPMO && item.alignment && item.alignment.checks && item.alignment.checks.length > 0) {
      sectionHeader('PI / Bill Alignment');
      item.alignment.checks.forEach(c => {
        const mark = c.passed ? '[PASS]' : '[FLAG]';
        const color = c.passed ? rgb(0.08, 0.5, 0.2) : rgb(0.75, 0.15, 0.15);
        text(`${mark} ${c.name}`, { size: 9.5, bold: true, color, lineHeight: 12 });
        if (c.comment) text(c.comment, { size: 8.5, x: MARGIN + 12, color: rgb(0.38, 0.38, 0.44), lineHeight: 11 });
      });
      y -= 4;
    }

    // ── PFB Alignment ──
    const pfbChecks = item.lineChecks || item.pfbLineChecks;
    if (pfbChecks && pfbChecks.length > 0) {
      sectionHeader('PFB Alignment - Line by Line');
      const cols = [{h:'Item',w:130},{h:'PFB Match',w:90},{h:'Rate',w:60},{h:'PFB Rate',w:60},{h:'Amount',w:70},{h:'PFB Amount',w:70},{h:'Status',w:75}];
      tableRow(cols.map(c=>c.h), cols.map(c=>c.w), { bold: true, size: 8 });
      pfbChecks.forEach(c => {
        const pfbAmount = (c.pfbRate != null && c.pfbQty != null) ? c.pfbRate * c.pfbQty : null;
        tableRow([c.lineItem, c.pfbMatch || '-', fmt(c.rate), c.pfbRate != null ? fmt(c.pfbRate) : '-', fmt(c.amount), pfbAmount != null ? fmt(pfbAmount) : '-', c.status],
          cols.map(c=>c.w), { size: 8, color: (c.status||'').includes('severe') ? rgb(0.75,0.15,0.15) : undefined });
      });
      y -= 4;
    }

    // ── PO Match (Bills only) ──
    if (isBill && item.poLineChecks && item.poLineChecks.length > 0) {
      sectionHeader('PO Match - Line by Line');
      const cols = [{h:'Item',w:160},{h:'Bill Rate',w:90},{h:'PO Rate',w:90},{h:'Bill Amt',w:90},{h:'PO Amt',w:90},{h:'Status',w:75}];
      tableRow(cols.map(c=>c.h), cols.map(c=>c.w), { bold: true, size: 8 });
      item.poLineChecks.forEach(c => {
        tableRow([c.lineItem, fmt(c.billRate), c.poRate != null ? fmt(c.poRate) : '-', fmt(c.billAmount), c.poAmount != null ? fmt(c.poAmount) : '-', c.status],
          cols.map(c=>c.w), { size: 8, color: (c.status||'').includes('severe') ? rgb(0.75,0.15,0.15) : undefined });
      });
      y -= 4;
    }

    // ── Reference Rate ──
    const rrChecks = (item.referenceRateChecks || []).filter(c => c.hasHistory);
    if (rrChecks.length > 0) {
      sectionHeader('Reference Rate');
      const cols = [{h:'Item',w:160},{h:"Today's Rate",w:110},{h:'Reference Rate',w:110},{h:'Status',w:75},{h:'Last Used',w:90}];
      tableRow(cols.map(c=>c.h), cols.map(c=>c.w), { bold: true, size: 8 });
      rrChecks.forEach(c => {
        tableRow([c.itemName, fmt(c.currentRate), c.refRateUsed != null ? fmt(c.refRateUsed) : '-', c.refStatus, c.lastUsedDocNumber || '-'],
          cols.map(c=>c.w), { size: 8 });
      });
      y -= 4;
    }

    // ── Attachments ──
    const docs = item.attachments || item.docs || item.documents;
    if (docs && docs.length > 0) {
      sectionHeader(`Attachments (${docs.length})`);
      docs.forEach(d => text('- ' + (d.file_name || 'Document'), { size: 9 }));
      y -= 4;
    }

    // ── Recommendation ── real fix: this is a real object
    // {decision, color, reasons}, not a string - parsed into plain
    // English instead of dumping raw JSON.
    if (item.recommendation) {
      sectionHeader('Recommendation');
      let rec = item.recommendation;
      if (typeof rec === 'string') {
        try { rec = JSON.parse(rec); } catch { /* genuinely just a plain string, leave as-is */ }
      }
      if (rec && typeof rec === 'object' && rec.decision) {
        const decisionColor = rec.decision === 'REJECT' || rec.decision === 'FLAG'
          ? rgb(0.75, 0.15, 0.15) : rec.decision === 'APPROVE' ? rgb(0.08, 0.5, 0.2) : rgb(0.15,0.15,0.2);
        text(`Decision: ${rec.decision}`, { size: 12, bold: true, color: decisionColor, lineHeight: 16 });
        (rec.reasons || []).forEach(r => text('- ' + r, { size: 9.5, lineHeight: 13 }));
      } else {
        text(typeof rec === 'string' ? rec : JSON.stringify(rec), { size: 10 });
      }
    }

    const pdfBytes = await pdfDoc.save();
    const buffer = Buffer.from(pdfBytes);
    const fileName = `Review_Report_${title.replace(/[\/\s]+/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    res.status(200).end(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
