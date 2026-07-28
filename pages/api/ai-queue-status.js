// pages/api/ai-queue-status.js
// Simple read-only status check — powers the live "%" on the Compliance
// Check button. Cheap: just reads one KV key, no Zoho/AI calls at all.

const { storeGet, KEYS, orgScopedKey } = require('../../lib/store');

export default async function handler(req, res) {
  const orgKey = req.query.org || 'rays';
  const status = (await storeGet(orgScopedKey(KEYS.AI_QUEUE_STATUS, orgKey))) || { total: 0, processed: 0, currentItem: null, finishedAt: new Date().toISOString() };
  const percent = status.total > 0 ? Math.round((status.processed / status.total) * 100) : 100;
  const running = !!status.startedAt && !status.finishedAt;
  return res.status(200).json({ ...status, percent, running });
}
