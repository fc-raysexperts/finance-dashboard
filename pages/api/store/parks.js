// pages/api/store/parks.js
// Add a new solar park (item 2). Only asks Name + District + State;
// project list and totals auto-populate later as projects get assigned to it.
//
// PUT added: editing an existing park's wrong info (name/district/state).
// Works for both hardcoded (data/projects.js SOLAR_PARKS) and user-added
// parks — writing a USER_PARKS entry under the same name overrides a
// hardcoded one, since pages/api/projects.js merges as
// {...SOLAR_PARKS, ...addedParks}. A rename also re-points every project
// currently assigned to the old name, via PROJECT_OVR, so they don't
// silently fall off the park list.

const { storeGet, storeSet, KEYS } = require('../../../lib/store');
const { PROJECTS } = require('../../../data/projects');

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const parks = (await storeGet(KEYS.USER_PARKS)) || {};
    return res.status(200).json({ success: true, data: parks });
  }

  if (req.method === 'POST') {
    const { name, district, state } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const parks = (await storeGet(KEYS.USER_PARKS)) || {};
    parks[name] = {
      district: district || '',
      state:    state    || 'Rajasthan',
      projects: [], // empty — projects attach themselves via their `park` field
      createdAt: new Date().toISOString(),
    };
    await storeSet(KEYS.USER_PARKS, parks);

    return res.status(200).json({ success: true, data: parks[name] });
  }

  if (req.method === 'PUT') {
    const { originalName, name, district, state } = req.body;
    if (!originalName || !name) return res.status(400).json({ error: 'originalName and name are required' });

    const parks = (await storeGet(KEYS.USER_PARKS)) || {};
    const existing = parks[originalName] || { projects: [], createdAt: new Date().toISOString() };

    if (originalName !== name) {
      // Renaming — re-point every project currently on the old name first
      const userProjects = (await storeGet(KEYS.USER_PROJECTS)) || [];
      const projectOvr    = (await storeGet(KEYS.PROJECT_OVR))  || {};

      const allBase = [...PROJECTS, ...userProjects];
      for (const p of allBase) {
        const currentPark = projectOvr[p.id]?.park ?? p.park;
        if (currentPark === originalName) {
          projectOvr[p.id] = { ...(projectOvr[p.id] || {}), park: name, updatedAt: new Date().toISOString() };
        }
      }
      await storeSet(KEYS.PROJECT_OVR, projectOvr);

      delete parks[originalName];
    }

    parks[name] = {
      ...existing,
      district: district || existing.district || '',
      state:    state    || existing.state    || 'Rajasthan',
      updatedAt: new Date().toISOString(),
    };
    await storeSet(KEYS.USER_PARKS, parks);

    return res.status(200).json({ success: true, data: parks[name] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
