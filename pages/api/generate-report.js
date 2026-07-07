// pages/api/generate-report.js
//
// Generates the "Download Review Report" PDF - accepts the SAME item data
// already computed and sitting in the browser (compliance checks,
// alignment checks, reference rate checks, recommendation) via POST, so
// this never needs to re-fetch from Zoho or duplicate any business logic
// that already lives in pos.js/bills.js/pmos.js.
//
// Uses pdf-lib (confirmed pure-JS, works in any environment including
// Vercel serverless functions - no headless browser or native binary
// needed, unlike puppeteer).

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PAGE_WIDTH = 595, PAGE_HEIGHT = 842; // A4
const MARGIN = 40;

function fmt(n) {
  if (n == null) return '-';
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

    // Manual pagination - pdf-lib doesn't auto-flow text across pages,
    // so every write checks remaining space and adds a fresh page first
    // if needed.
    function ensureSpace(neededHeight) {
      if (y - neededHeight < MARGIN) {
        page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
    }
    function text(str, opts = {}) {
      const size = opts.size || 10;
      const useFont = opts.bold ? bold : font;
      const color = opts.color || rgb(0.1, 0.1, 0.15);
      ensureSpace(size + 6);
      page.drawText(String(str ?? '-'), { x: opts.x || MARGIN, y, size, font: useFont, color, maxWidth: opts.maxWidth || (PAGE_WIDTH - 2 * MARGIN) });
      y -= (opts.lineHeight || size + 6);
    }
    function sectionHeader(str) {
      ensureSpace(30);
      y -= 6;
      page.drawRectangle({ x: MARGIN, y: y - 4, width: PAGE_WIDTH - 2 * MARGIN, height: 20, color: rgb(0.92, 0.95, 1) });
      page.drawText(str, { x: MARGIN + 6, y: y, size: 12, font: bold, color: rgb(0.09, 0.25, 0.65) });
      y -= 26;
    }
    function tableRow(cells, widths, opts = {}) {
      ensureSpace(16);
      let x = MARGIN;
      const useFont = opts.bold ? bold : font;
      cells.forEach((c, i) => {
        page.drawText(String(c ?? '-').slice(0, 40), { x, y, size: 9, font: useFont, color: rgb(0.15, 0.15, 0.2) });
        x += widths[i];
      });
      y -= 15;
    }

    // ── Header ──
    const title = isPMO ? `PMO ${item.pmoNumber}` : isBill ? `Bill ${item.billNumber}` : `PO ${item.poNumber}`;
    text(title, { size: 18, bold: true, color: rgb(0.09, 0.25, 0.65) });
    text(`Vendor: ${item.vendor || '-'}   |   Date: ${item.date || '-'}   |   Total: ${fmt(item.total || item.amount)}`, { size: 10 });
    y -= 6;

    // ── Line Items ──
    const lineItems = item.lineItems || item.line_items || [];
    if (lineItems.length > 0) {
      sectionHeader('Line Items');
      tableRow(['Item', 'Qty', 'Rate', 'Amount'], [260, 90, 90, 90], { bold: true });
      lineItems.forEach(li => {
        tableRow([li.name || '-', li.quantity, fmt(li.rate), fmt(li.item_total)], [260, 90, 90, 90]);
      });
      y -= 8;
    }

    // ── Compliance Checks ──
    if (item.compliance && item.compliance.length > 0) {
      sectionHeader((isPMO ? 'PMO' : isBill ? 'Bill' : 'PO') + ' Compliance Checks');
      item.compliance.forEach(c => {
        const mark = c.passed ? 'PASS' : 'FLAG';
        const color = c.passed ? rgb(0.08, 0.5, 0.2) : rgb(0.7, 0.15, 0.15);
        ensureSpace(28);
        text(`[${mark}] ${c.name}`, { size: 10, bold: true, color, lineHeight: 13 });
        if (c.comment) text(c.comment, { size: 9, x: MARGIN + 14, color: rgb(0.35, 0.35, 0.4), maxWidth: PAGE_WIDTH - 2 * MARGIN - 14 });
      });
      y -= 8;
    }

    // ── PFB Alignment ──
    const pfbChecks = item.lineChecks || item.pfbLineChecks;
    if (pfbChecks && pfbChecks.length > 0) {
      sectionHeader('PFB Alignment');
      tableRow(['Item', 'Rate', 'PFB Rate', 'Status'], [220, 100, 100, 110], { bold: true });
      pfbChecks.forEach(c => {
        tableRow([c.lineItem, fmt(c.rate), c.pfbRate!=null?fmt(c.pfbRate):'-', c.status], [220, 100, 100, 110]);
      });
      y -= 8;
    }

    // ── PO Match (Bills only) ──
    if (isBill && item.poLineChecks && item.poLineChecks.length > 0) {
      sectionHeader('PO Match');
      tableRow(['Item', 'Bill Rate', 'PO Rate', 'Status'], [220, 100, 100, 110], { bold: true });
      item.poLineChecks.forEach(c => {
        tableRow([c.lineItem, fmt(c.billRate), c.poRate!=null?fmt(c.poRate):'-', c.status], [220, 100, 100, 110]);
      });
      y -= 8;
    }

    // ── Reference Rate ──
    const rrChecks = (item.referenceRateChecks || []).filter(c => c.hasHistory);
    if (rrChecks.length > 0) {
      sectionHeader('Reference Rate');
      tableRow(['Item', "Today's Rate", 'Reference Rate', 'Status'], [220, 100, 100, 110], { bold: true });
      rrChecks.forEach(c => {
        tableRow([c.itemName, fmt(c.currentRate), c.refRateUsed!=null?fmt(c.refRateUsed):'-', c.refStatus], [220, 100, 100, 110]);
      });
      y -= 8;
    }

    // ── Recommendation ──
    if (item.recommendation) {
      sectionHeader('Recommendation');
      const rec = typeof item.recommendation === 'string' ? item.recommendation : JSON.stringify(item.recommendation);
      text(rec, { size: 10, maxWidth: PAGE_WIDTH - 2 * MARGIN });
    }

    const pdfBytes = await pdfDoc.save();
    const fileName = `Review_Report_${title.replace(/[\/\s]+/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.status(200).send(Buffer.from(pdfBytes));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
