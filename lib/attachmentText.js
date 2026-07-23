// lib/attachmentText.js
//
// Attachment-content reading pipeline for Compliance Checks. This is the
// fallback layer only — checks should always try to answer from
// structured Zoho fields FIRST (cheap, reliable, already correct for most
// checks), and only call into this module when the structured data
// genuinely can't answer the question (e.g. Zoho has no dedicated field
// for "does the LD clause exist" — that can only live in an attachment).
//
// Two extraction paths, tried in order, per real sample analysis:
//   1. Plain text PDFs (the vast majority of PO/SO Annexures, price
//      approvals, quotations, estimates, work orders) — fast, cheap,
//      accurate. Handled by pdf-parse.
//   2. Scanned PDFs / photographed documents / raw images — these need
//      OCR. This isn't specific to any one PBP subtype (PO/SO/LO) or
//      document category; any attachment on any PBP could turn out to
//      be a scan or photo rather than a native-text PDF, so this check
//      always runs generically rather than assuming based on file type
//      or which PBP it's attached to. Confirmed real case so far: a
//      28-page scanned Jamabandi-style land document under an LO — but
//      the logic here doesn't special-case LO at all, it just reacts to
//      whatever comes back from extraction. Handled by tesseract.js,
//      and ONLY invoked when path 1 comes back empty/too short, since
//      OCR is much slower and more resource-intensive than plain text
//      extraction.
//
// Extracted text is cached (keyed by documentId) so the same attachment
// is never re-downloaded or re-parsed twice — this matters both for
// speed (OCR is slow) and for Zoho API rate limits.

const axios = require('axios');
const { getAccessToken } = require('./zohoToken');
const { storeGet, storeSet, KEYS } = require('./store');

// ── Fetch the raw attachment binary (same endpoint/logic as attachment-proxy.js) ──
async function fetchAttachmentBinary(documentId) {
  const token = await getAccessToken();
  const response = await axios.get(`https://www.zohoapis.in/books/v3/documents/${documentId}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID },
    responseType: 'arraybuffer',
  });
  return Buffer.from(response.data);
}

function looksLikePDF(buf) {
  return buf.slice(0, 5).toString('utf-8') === '%PDF-';
}
function looksLikeImage(buf) {
  // JPEG (FFD8), PNG (89 50 4E 47)
  return (buf[0] === 0xFF && buf[1] === 0xD8) || (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47);
}

// Minimum chars to consider a PDF's "native" text extraction successful.
// Below this, treat the PDF as scanned/image-based and fall back to OCR.
// Real basis: a text-based Annexure/estimate/work-order in the sample set
// returns 700-7000+ chars; the one confirmed scanned PDF returned 0.
const MIN_TEXT_CHARS = 50;

async function extractPDFText(buf) {
  const { PDFParse } = require('pdf-parse');
  try {
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    return (result.text || '').trim();
  } catch (e) {
    console.error('pdf-parse failed:', e.message);
    return '';
  }
}

// pdf-parse inserts a "-- N of M --" separator between every page even
// when a page has zero real text (confirmed: a 28-page scanned PDF came
// back with 491 "chars" that were ENTIRELY these separators — a naive
// length check would have wrongly treated that as real content and
// skipped OCR). Strip them before measuring actual extracted content.
function stripPageMarkers(text) {
  return (text || '').replace(/--\s*\d+\s*of\s*\d+\s*--/g, '').trim();
}

// OCR fallback — only reached for scanned PDFs or raw image attachments.
// Tesseract.js runs in plain Node (no native binary needed for the OCR
// engine itself), but is meaningfully slower than plain text extraction —
// expect several seconds per page.
//
// IMPORTANT — two production considerations specific to serverless:
// 1. Tesseract.js downloads its language model (eng.traineddata, ~11MB)
//    from a CDN on first use per cold start. This could NOT be verified
//    end-to-end in the sandbox this was built in (its network policy
//    blocks that CDN entirely) — Vercel's runtime has normal internet
//    access, so this should work there, but test it against a real
//    scanned attachment after deploying rather than assuming.
// 2. Vercel serverless functions have execution time limits (10s on
//    Hobby, up to 60s+ on Pro). A 28-page scanned document run through
//    OCR page-by-page could realistically exceed that. MAX_OCR_PAGES
//    caps it defensively — increase only after confirming your actual
//    Vercel plan's timeout and real per-page OCR duration.
const MAX_OCR_PAGES = 8;

async function extractViaOCR(buf, isPDF) {
  const Tesseract = require('tesseract.js');
  try {
    if (isPDF) {
      // Render each PDF page to a PNG using pdf-parse's own built-in
      // getScreenshot() — deliberately NOT using pdf-img-convert (which
      // depends on the native `canvas` package; confirmed it fails to
      // compile in this sandbox and is a well-known pain point on
      // Vercel too). pdf-parse's screenshot renderer has no native
      // dependency and was confirmed working against a real scanned PDF.
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: buf });
      const info = await parser.getInfo();
      const totalPages = info.total || info.pages || 1;
      const pagesToRead = Math.min(totalPages, MAX_OCR_PAGES);
      const pageNumbers = Array.from({ length: pagesToRead }, (_, i) => i + 1);

      const screenshots = await parser.getScreenshot({ pages: pageNumbers });
      let combined = '';
      for (const page of screenshots.pages) {
        const pngBuf = Buffer.from(page.data);
        const { data } = await Tesseract.recognize(pngBuf, 'eng');
        combined += (data.text || '') + '\n';
      }
      if (totalPages > MAX_OCR_PAGES) {
        combined += `\n[Note: only first ${MAX_OCR_PAGES} of ${totalPages} pages OCR'd — raise MAX_OCR_PAGES once real per-page OCR timing is confirmed safe within your Vercel function timeout]`;
      }
      return combined.trim();
    } else {
      const { data } = await Tesseract.recognize(buf, 'eng');
      return (data.text || '').trim();
    }
  } catch (e) {
    console.error('OCR extraction failed:', e.message);
    return '';
  }
}

// ── Main entry point ──────────────────────────────────────────
// Returns { text, method, error } — method is 'pdf-text' | 'ocr' | 'cached' | 'failed'.
async function getAttachmentText(documentId) {
  if (!documentId) return { text: '', method: 'failed', error: 'No documentId' };

  const cache = (await storeGet(KEYS.ATTACHMENT_TEXT_CACHE)) || {};
  if (cache[documentId]) {
    return { text: cache[documentId].text, method: cache[documentId].method, cached: true };
  }

  let text = '';
  let method = 'failed';
  try {
    const buf = await fetchAttachmentBinary(documentId);

    if (looksLikePDF(buf)) {
      text = await extractPDFText(buf);
      method = 'pdf-text';
      if (stripPageMarkers(text).length < MIN_TEXT_CHARS) {
        // Likely a scanned PDF — fall back to OCR
        text = await extractViaOCR(buf, true);
        method = 'ocr';
      }
    } else if (looksLikeImage(buf)) {
      text = await extractViaOCR(buf, false);
      method = 'ocr';
    } else {
      // Unknown/unsupported binary type (e.g. .docx/.xlsx) — not handled
      // by this pipeline yet; return empty rather than guessing.
      method = 'unsupported';
    }
  } catch (e) {
    console.error(`Attachment text extraction failed for ${documentId}:`, e.message);
    return { text: '', method: 'failed', error: e.message };
  }

  // Cache the result (including empty/unsupported outcomes, so we don't
  // keep retrying a document that genuinely has nothing extractable).
  cache[documentId] = { text, method, extractedAt: new Date().toISOString() };
  await storeSet(KEYS.ATTACHMENT_TEXT_CACHE, cache);

  return { text, method };
}

// Convenience: extract + search text from ALL of a PBP's attachments in
// one call, returning combined text for keyword matching across every
// attached document at once (e.g. LD clause could be in any one of them).
async function getAllAttachmentsText(docs) {
  const results = await Promise.all(
    (docs || []).map(d => getAttachmentText(d.document_id || d.documentId))
  );
  return results.map(r => r.text).filter(Boolean).join('\n\n---\n\n');
}

module.exports = { getAttachmentText, getAllAttachmentsText };
