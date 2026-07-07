// pages/api/attachment-proxy.js
//
// Streams a PO/Bill/PMO attachment from Zoho through this server, since a
// direct link to Zoho's own URL would require an auth token the browser
// doesn't have. Confirmed real endpoints (Zoho Books API documentation):
//   GET /purchaseorders/{purchaseorder_id}/attachment
//   GET /bills/{bill_id}/attachment
// PMO's real endpoint confirmed earlier from a captured network request:
//   GET /cm_payment_memos/{id}/attachment

import { getAccessToken } from '../../lib/zohoToken';
const axios = require('axios');

const ENDPOINT_MAP = {
  po:   (id) => `/purchaseorders/${id}/attachment`,
  bill: (id) => `/bills/${id}/attachment`,
  pmo:  (id) => `/cm_payment_memos/${id}/attachment`,
};

export default async function handler(req, res) {
  const { type, id } = req.query;
  if (!type || !id || !ENDPOINT_MAP[type]) {
    return res.status(400).send('Missing or invalid type/id');
  }

  try {
    const token = await getAccessToken();
    const path = ENDPOINT_MAP[type](id);
    const response = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID },
      responseType: 'arraybuffer', // binary content, not JSON
    });

    // Zoho reports the real content type itself - trust it, falling back
    // to PDF only if it's genuinely missing (most attachments are PDFs
    // in this org, confirmed from earlier real examples).
    const contentType = response.headers['content-type'] || 'application/pdf';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300'); // small cache - same attachment rarely changes within a session
    res.status(200).send(Buffer.from(response.data));
  } catch (e) {
    res.status(500).send('Could not load attachment: ' + (e.response?.status || e.message));
  }
}
