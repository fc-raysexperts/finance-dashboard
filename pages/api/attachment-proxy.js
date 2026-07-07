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
  const { documentId } = req.query;
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

    const contentType = response.headers['content-type'] || 'application/pdf';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).send(Buffer.from(response.data));
  } catch (e) {
    res.status(500).send('Could not load attachment: ' + (e.response?.status || e.message));
  }
}
