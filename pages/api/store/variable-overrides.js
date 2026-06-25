// pages/api/store/variable-overrides.js
// Saves DC/AC/SW/Piling/Wall/Road overrides for a project — persists
// across devices via lib/store.js (Vercel KV in production, local JSON
// file fallback for `npm run dev`). Fixes item 1: edits made in the PFB
// "Confirm Variables" modal now actually stick.

const { storeGet, storeSet, KEYS } = require('../../../lib/store');

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const all = (await storeGet(KEYS.VARIABLE_OVR)) || {};
    return res.status(200).json({ success: true, data: all });
  }

  if (req.method === 'POST') {
    const { projectId, dc, ac, sw, piling, wall, road } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });

    const all = (await storeGet(KEYS.VARIABLE_OVR)) || {};
    all[projectId] = {
      ...(all[projectId] || {}),
      ...(dc     != null ? { dc:     parseFloat(dc) }     : {}),
      ...(ac     != null ? { ac:     parseFloat(ac) }     : {}),
      ...(sw     != null ? { sw:     parseInt(sw) }       : {}),
      ...(piling != null ? { piling: parseInt(piling) }   : {}),
      ...(wall   != null ? { wall:   parseInt(wall) }     : {}),
      ...(road   != null ? { road:   parseInt(road) }     : {}),
      updatedAt: new Date().toISOString(),
    };
    await storeSet(KEYS.VARIABLE_OVR, all);

    return res.status(200).json({ success: true, data: all[projectId] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
