// pages/api/store/projects.js
// Add a new project (item 2). Auto-generates id from name, sets district/state
// from the chosen Solar Park, computes Revenue Quarter from End Date.

const { storeGet, storeSet, KEYS } = require('../../../lib/store');
const { SOLAR_PARKS, quarterFromEndDate } = require('../../../data/projects');

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const list = (await storeGet(KEYS.USER_PROJECTS)) || [];
    return res.status(200).json({ success: true, data: list });
  }

  if (req.method === 'POST') {
    const {
      name, firm, park,
      dc, ac, sw, bess = 0,
      piling = 2000, wall = 2000, road = 2000,
      totalValue, epcCost, agreementDate, endDate,
      zohoNames = [],
    } = req.body;

    if (!name || !park) {
      return res.status(400).json({ error: 'name and park are required' });
    }

    const parkInfo = SOLAR_PARKS[park] || (await storeGet(KEYS.USER_PARKS) || {})[park];
    const district = parkInfo?.district || '';
    const state    = parkInfo?.state    || 'Rajasthan';
    const quarter  = endDate ? quarterFromEndDate(endDate) : '';

    const id = slugify(name) + '_' + Date.now().toString(36).slice(-4);

    const newProject = {
      id, name, firm: firm || name, park, district, state,
      dc: dc != null ? parseFloat(dc) : null,
      ac: ac != null ? parseFloat(ac) : null,
      sw: sw != null ? parseInt(sw)   : null,
      bess: parseFloat(bess) || 0,
      piling: parseInt(piling) || 2000,
      wall:   parseInt(wall)   || 2000,
      road:   parseInt(road)   || 2000,
      totalValue: totalValue != null ? parseFloat(totalValue) : null,
      epcCost:    epcCost    != null ? parseFloat(epcCost)    : null,
      agreementDate: agreementDate || null,
      endDate:       endDate       || null,
      quarter,
      zohoNames: Array.isArray(zohoNames) ? zohoNames : [],
      createdAt: new Date().toISOString(),
    };

    const list = (await storeGet(KEYS.USER_PROJECTS)) || [];
    list.push(newProject);
    await storeSet(KEYS.USER_PROJECTS, list);

    // Also attach this project to the chosen park's project-id list if the
    // park is one of the hardcoded SOLAR_PARKS (for user-added parks the
    // `park` field match in projects.js API already covers it)
    return res.status(200).json({ success: true, data: newProject });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
