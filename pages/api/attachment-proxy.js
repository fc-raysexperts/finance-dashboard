// pages/api/attachment-proxy.js
//
// Streams a specific attachment's real binary content through this
// server. Real bug fixed: GET /purchaseorders/{id}/attachment (and the
// Bill/PMO equivalents) do NOT return file binary at all - they return
// metadata about the attached documents (confirmed directly from a real
// captured response: {code, message, documents:[{file_name, document_id,
// ...}]}). Calling that same endpoint regardless of which specific file
// was clicked is exactly why every attachment button showed the same
// file. The real endpoint to download ONE SPECIFIC file's actual bytes
// is GET /documents/{document_id} - keyed by that individual document's
// own unique ID, not the parent record's ID.

import { getAccessToken } from '../../lib/zohoToken';
const axios = require('axios');

export default async function handler(req, res) {
  const { documentId, filename } = req.query;
  if (!documentId) {
    return res.status(400).send('Missing documentId');
  }

  try {
    const token = await getAccessToken();
    const response = await axios.get(`https://www.zohoapis.in/books/v3/documents/${documentId}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID },
      responseType: 'arraybuffer',
    });

    // Real bug: Zoho's /documents/{id} endpoint sometimes returns a
    // content-type of application/octet-stream (or similar generic type)
    // even when the underlying file genuinely is a PDF. Browsers refuse
    // to render octet-stream inline in an <iframe> and force a download
    // instead — which is exactly the "some PMOs download instead of
    // preview" behavior. Since the vast majority of these attachments
    // are PDFs, and Zoho's own content-disposition header name usually
    // carries the real extension, sniff the magic bytes (PDF files
    // always start with "%PDF-") and correct the content-type when it's
    // actually a PDF but wasn't labeled as one.
    const buf = Buffer.from(response.data);
    const zohoContentType = response.headers['content-type'] || '';
    const looksLikePDF = buf.slice(0, 5).toString('utf-8') === '%PDF-';
    const contentType = looksLikePDF ? 'application/pdf' : (zohoContentType || 'application/octet-stream');

    res.setHeader('Content-Type', contentType);
    // Real fix: include the actual filename so browsers use it for
    // Save-As / downloads, instead of deriving a name from the URL
    // itself (which always showed as "attachment-proxy"). Still
    // "inline" disposition (so it previews in the iframe as before) —
    // the filename is just metadata riding along with that, used only
    // when the user explicitly saves/downloads the file. RFC 5987
    // (filename*=UTF-8''...) handles special characters and non-ASCII
    // names safely; the plain filename="" fallback covers older clients.
    if (filename) {
      const safeName = String(filename).replace(/[\r\n"]/g, '');
      const encoded = encodeURIComponent(safeName);
      res.setHeader('Content-Disposition', `inline; filename="${safeName.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encoded}`);
    } else {
      res.setHeader('Content-Disposition', 'inline');
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).send(buf);
  } catch (e) {
    const zohoErrorBody = e.response?.data ? Buffer.from(e.response.data).toString('utf-8').slice(0, 500) : null;
    res.status(500).send('Could not load attachment: ' + (e.response?.status || e.message) + (zohoErrorBody ? ' | Zoho said: ' + zohoErrorBody : ''));
  }
}
