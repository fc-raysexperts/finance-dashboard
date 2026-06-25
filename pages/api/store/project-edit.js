// pages/api/store/project-edit.js
// Saves general project field edits — name, BESS, total value, EPC cost,
// agreement/end date, and park — for the "EDIT" button on the Project
// Details popup. This is separate from variable-overrides.js (which only
// handles DC/AC/SW/Piling/Wall/Road) and from zoho-names.js (which only
// handles the Zoho Books project code aliases), so none of those existing,
// already-working flows are touched.
//
// Works for both the 23 hardcoded projects (data/projects.js) and any
// user-added project — the override is applied on top of whichever base
// record exists, by pages/api/projects.js.

const { storeGet, storeSet, KEYS } = require('../../../lib/store');

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const all = (await storeGet(KEYS.PROJECT_OVR)) || {};
    return res.status(200).json({ success: true, data: all });
  }

  if (req.method === 'POST') {
    const { projectId, name, bess, totalValue, epcCost, agreementDate, endDate, park } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });

    const all = (await storeGet(KEYS.PROJECT_OVR)) || {};
    all[projectId] = {
      ...(all[projectId] || {}),
      ...(name          != null ? { name }                          : {}),
      ...(bess           != null ? { bess: parseFloat(bess) }       : {}),
      ...(totalValue     != null ? { totalValue: parseFloat(totalValue) } : {}),
      ...(epcCost         != null ? { epcCost: parseFloat(epcCost) } : {}),
      ...(agreementDate != null ? { agreementDate }                 : {}),
      ...(endDate         != null ? { endDate }                     : {}),
      ...(park             != null ? { park }                       : {}),
      updatedAt: new Date().toISOString(),
    };
    await storeSet(KEYS.PROJECT_OVR, all);

    return res.status(200).json({ success: true, data: all[projectId] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
