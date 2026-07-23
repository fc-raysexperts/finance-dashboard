// lib/geminiClient.js
//
// Thin wrapper around Google's Gemini API. Sends attachments (PDF/image)
// DIRECTLY as native document/image parts in one request — no local
// pdf-parse/OCR step needed for AI-judged checks (Gemini reads PDFs and
// photos natively). One call per PO, covering every attachment and every
// AI-dependent check in a single request, returning structured JSON.
//
// Two separate API keys supported (per Jatin's account-split plan):
// process.env.GEMINI_API_KEY_PO_PMO and process.env.GEMINI_API_KEY_BILLS.
// Free-tier quotas are per Google Cloud PROJECT, so two separate Google
// accounts genuinely give two separate quota pools — confirmed against
// Gemini's own rate-limit documentation, not an assumption.
//
// HONEST CAVEAT: this has NOT been tested against a live Gemini API call
// (no key available in the build/test environment this was written in).
// The request/response shape below follows Google's documented REST API
// exactly, but test the very first real call carefully after deploying —
// specifically: does the JSON come back parseable, and do the documents
// actually get read correctly.

const axios = require('axios');

// Model choice matters a lot on the free tier — confirmed via real usage
// data from AI Studio's own Rate Limit dashboard: gemini-2.5-flash only
// allows 5 requests/minute AND just 20 requests/DAY on the free tier,
// which is far too low for realistic daily PO/Bill/PMO volume (a single
// test session exhausted it). gemini-3.1-flash-lite offers 15 RPM and
// 500 RPD on the same free tier — dramatically more headroom for the
// same zero cost. Still multimodal (reads PDFs/images natively) — the
// "Flash Lite" naming refers to a smaller/faster model, not a
// text-only one.
const MODEL = 'gemini-3.1-flash-lite';

function getApiKey(tabType) {
  // tabType: 'po' | 'pmo' | 'bill'
  if (tabType === 'bill') {
    return process.env.GEMINI_API_KEY_BILLS || process.env.GEMINI_API_KEY_PO_PMO;
  }
  return process.env.GEMINI_API_KEY_PO_PMO || process.env.GEMINI_API_KEY_BILLS;
}

// mimeType must be a real Gemini-supported type: application/pdf,
// image/jpeg, image/png, image/webp.
function guessMimeType(fileName) {
  const ext = (fileName || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return null; // unsupported — caller should skip this attachment for the AI call
}

// attachments: [{ fileName, base64Data }] — base64Data is the raw file
// bytes already base64-encoded (caller fetches from Zoho and encodes).
// prompt: the full instruction text (built per-PBP-type in aiComplianceEngine.js).
// Returns the raw parsed JSON object from Gemini's response, or throws.
async function callGeminiWithDocuments({ tabType, prompt, attachments }) {
  const apiKey = getApiKey(tabType);
  if (!apiKey) {
    throw new Error(`No Gemini API key configured for tabType="${tabType}" — set GEMINI_API_KEY_PO_PMO / GEMINI_API_KEY_BILLS in Vercel env vars`);
  }

  const parts = [{ text: prompt }];
  for (const att of attachments || []) {
    const mimeType = guessMimeType(att.fileName);
    if (!mimeType) continue; // skip unsupported file types (e.g. .docx) — noted in prompt instead
    parts.push({ inline_data: { mime_type: mimeType, data: att.base64Data } });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0, // deterministic judgments, not creative — same input should give same verdict every time
    },
  };

  try {
    const response = await axios.post(url, body, { timeout: 55000 });
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned no usable content — full response: ' + JSON.stringify(response.data).slice(0, 500));
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('Gemini response was not valid JSON: ' + text.slice(0, 500));
    }
  } catch (e) {
    if (e.response?.status === 429) {
      const message = e.response.data?.error?.message || e.message;
      // Gemini's own error message tells us exactly how long to wait
      // (e.g. "Please retry in 10.959267729s.") — parse it out so the
      // caller can wait precisely that long instead of guessing.
      const retryMatch = message.match(/retry in ([\d.]+)s/i);
      const retryAfterMs = retryMatch ? Math.ceil(parseFloat(retryMatch[1]) * 1000) : 15000;
      const quotaErr = new Error('Gemini free-tier rate/quota limit hit for this key: ' + message);
      quotaErr.isQuotaExceeded = true;
      quotaErr.retryAfterMs = retryAfterMs;
      throw quotaErr;
    }
    throw e;
  }
}

module.exports = { callGeminiWithDocuments, guessMimeType };
