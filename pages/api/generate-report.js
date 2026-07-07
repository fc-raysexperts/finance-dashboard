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

export const config = {
  api: {
    responseLimit: false,
    bodyParser: { sizeLimit: '10mb' }, // real fix: a full PO/Bill's data (all line items + every compliance/alignment/reference-rate check) can exceed Next.js's default 1MB limit, silently failing the request
  },
};

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


    // Real fix: pdf-lib's standard fonts (WinAnsi encoding) can't render
    // arrows, most symbols/emoji, or various Unicode punctuation - this
    // sanitizes ALL text before drawing, replacing known problematic
    // characters with safe equivalents and stripping anything else
    // outside WinAnsi's supported range, so this can't crash again
    // regardless of what characters show up in the underlying data.
    function sanitizeText(str) {
      return String(str ?? '-')
        .replace(/[\u2192\u2190\u2191\u2193]/g, '->')  // arrows
        .replace(/[\u2018\u2019]/g, "'")                // smart single quotes
        .replace(/[\u201C\u201D]/g, '"')                // smart double quotes
        .replace(/[\u2013\u2014]/g, '-')                // en/em dash
        .replace(/[\u2022\u25CF]/g, '*')                // bullets
        .replace(/[\u2026]/g, '...')                    // ellipsis
        .replace(/[^\x00-\xFF]/g, '')                   // anything else outside WinAnsi's range - stripped, not crashed on
        .trim();
    }
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
      page.drawText(sanitizeText(str), { x: opts.x || MARGIN, y, size, font: useFont, color, maxWidth: opts.maxWidth || (PAGE_WIDTH - 2 * MARGIN) });
      y -= (opts.lineHeight || size + 6);
    }
    function sectionHeader(str) {
      ensureSpace(30);
      y -= 6;
      page.drawRectangle({ x: MARGIN, y: y - 4, width: PAGE_WIDTH - 2 * MARGIN, height: 20, color: rgb(0.92, 0.95, 1) });
      page.drawText(sanitizeText(str), { x: MARGIN + 6, y: y, size: 12, font: bold, color: rgb(0.09, 0.25, 0.65) });
      y -= 26;
    }
    function tableRow(cells, widths, opts = {}) {
      ensureSpace(16);
      let x = MARGIN;
      const useFont = opts.bold ? bold : font;
      cells.forEach((c, i) => {
        page.drawText(sanitizeText(c).slice(0, 40), { x, y, size: 9, font: useFont, color: rgb(0.15, 0.15, 0.2) });
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
    const buffer = Buffer.from(pdfBytes);
    const fileName = `Review_Report_${title.replace(/[\/\s]+/g, '_')}.pdf`;
    // Real fix: res.send() in Next.js API routes isn't always reliable for
    // raw binary payloads without an explicit Content-Length - this is the
    // standard, well-documented fix for a downloaded file that looks like
    // it worked but won't actually open ("failed to load", "not a
    // supported file type"). res.end() with an explicit length avoids any
    // implicit re-encoding of the buffer.
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', buffer.length);
    res.status(200).end(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
