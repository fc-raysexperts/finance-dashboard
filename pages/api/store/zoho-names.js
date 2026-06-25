// pages/api/store/zoho-names.js
// Modify/Add Zoho Books Project Names for a project (item 9). Used for
// edge cases like JSW splitting one large order into multiple Zoho project
// codes (JSW 13/15/20) that aren't really separate phases.

const { storeGet, storeSet, KEYS } = require('../../../lib/store');

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const all = (await storeGet(KEYS.ZOHO_NAME_OVR)) || {};
    return res.status(200).json({ success: true, data: all });
  }

  if (req.method === 'POST') {
    // action: 'add' | 'remove' | 'replace'
    const { projectId, action, value, oldValue } = req.body;
    if (!projectId || !action) return res.status(400).json({ error: 'projectId and action are required' });

    const all = (await storeGet(KEYS.ZOHO_NAME_OVR)) || {};
    const current = all[projectId] || [];

    if (action === 'add') {
      if (!value) return res.status(400).json({ error: 'value is required for add' });
      if (!current.includes(value)) current.push(value);
    } else if (action === 'remove') {
      const idx = current.indexOf(value);
      if (idx >= 0) current.splice(idx, 1);
    } else if (action === 'replace') {
      const idx = current.indexOf(oldValue);
      if (idx >= 0) current[idx] = value;
      else current.push(value);
    } else {
      return res.status(400).json({ error: 'action must be add, remove, or replace' });
    }

    all[projectId] = current;
    await storeSet(KEYS.ZOHO_NAME_OVR, all);

    return res.status(200).json({ success: true, data: current });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
