// pages/api/projects.js
// Returns the full projects + parks list for the Projects/PFBs/Parks tabs.
// Merges in: user-added projects (item 2), user-added parks (item 2),
// per-project variable overrides DC/AC/SW/Piling/Wall/Road (item 1),
// and per-project Zoho Name overrides (item 9).

const { PROJECTS, SOLAR_PARKS, groupByFirm, quarterFromEndDate } = require('../../data/projects');
const { generatePFB } = require('../../lib/pfbEngine');
const { storeGet, KEYS } = require('../../lib/store');

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const [userProjects, userParks, zohoNameOvr, variableOvr, projectOvr] = await Promise.all([
      storeGet(KEYS.USER_PROJECTS),
      storeGet(KEYS.USER_PARKS),
      storeGet(KEYS.ZOHO_NAME_OVR),
      storeGet(KEYS.VARIABLE_OVR),
      storeGet(KEYS.PROJECT_OVR),
    ]);

    const addedProjects = userProjects || [];
    const addedParks     = userParks    || {};
    const nameOverrides   = zohoNameOvr  || {};
    const varOverrides    = variableOvr  || {};
    const fieldOverrides  = projectOvr   || {};

    // Merge hardcoded + user-added projects
    let allProjects = [...PROJECTS, ...addedProjects].map(p => {
      const ov = varOverrides[p.id] || {};
      const fov = fieldOverrides[p.id] || {};
      const merged = {
        ...p,
        ...fov, // general field edits (name/bess/totalValue/epcCost/dates/park) from the EDIT button
        dc:     ov.dc     ?? p.dc,
        ac:     ov.ac     ?? p.ac,
        sw:     ov.sw     ?? p.sw,
        piling: ov.piling ?? p.piling ?? 2000,
        wall:   ov.wall   ?? p.wall   ?? 2000,
        road:   ov.road   ?? p.road   ?? 2000,
        zohoNames: [...(p.zohoNames || []), ...(nameOverrides[p.id] || [])],
      };
      // Recompute revenue quarter if the End Date was edited
      if (fov.endDate) merged.quarter = quarterFromEndDate(fov.endDate);

      // Compute PFB total + rate if technical variables are ready
      if (merged.dc && merged.ac && merged.sw) {
        const items = generatePFB(merged.name, merged.dc, merged.ac, merged.sw, merged.piling, merged.wall, merged.road);
        const total = items.reduce((s, i) => s + i.amount, 0);
        merged.pfbTotal  = total;
        merged.ratePerWp = total / (merged.dc * 1000000);
        merged.pfbReady  = true;
      } else {
        merged.pfbReady = false;
      }
      return merged;
    });

    // Merge hardcoded + user-added parks
    const mergedParkDefs = { ...SOLAR_PARKS, ...addedParks };

    const parks = Object.entries(mergedParkDefs).map(([parkName, info]) => {
      // A park's projects = projects whose CURRENT `park` field matches this
      // park name. Using the current field (rather than blindly trusting the
      // hardcoded SOLAR_PARKS id-list) means a project whose park was
      // changed via the EDIT button moves cleanly to its new park instead
      // of appearing under both the old and new one.
      const byIdList = (info.projects || [])
        .map(id => allProjects.find(p => p.id === id))
        .filter(p => p && p.park === parkName);
      const byParkField = allProjects.filter(p => p.park === parkName && !byIdList.includes(p));
      const parkProjects = [...byIdList, ...byParkField];

      return {
        name:       parkName,
        district:   info.district || '',
        state:      info.state    || 'Rajasthan',
        projects:   parkProjects,
        totalDC:    parkProjects.reduce((s, p) => s + (p.dc || 0), 0),
        totalBESS:  parkProjects.reduce((s, p) => s + (p.bess || 0), 0),
        totalValue: parkProjects.reduce((s, p) => s + (p.totalValue || 0), 0),
        count:      parkProjects.length,
      };
    }).sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0));

    const firms = groupByFirm(allProjects);

    return res.status(200).json({
      success: true,
      allProjects,
      firms,
      parks,
    });
  } catch (err) {
    console.error('Projects API error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
