// pages/api/projects.js
// Projects come from data/projects.js only — no live Zoho fetch
// New projects: add to data/projects.js then push to GitHub

import { PROJECTS, SOLAR_PARKS, groupByFirm } from '../../data/projects';
import { generatePFB } from '../../lib/pfbEngine';

export default async function handler(req, res) {

  if (req.method === 'POST') {
    // Save DC/AC/SW override from frontend (for projects missing variables)
    const { projectId, dc, ac, sw } = req.body;
    return res.status(200).json({
      success: true,
      saved: { projectId, dc: parseFloat(dc), ac: parseFloat(ac), sw: parseInt(sw) }
    });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse localStorage overrides (for projects missing DC/AC/SW)
  const overrides = {};
  try {
    if (req.query.overrides) {
      Object.assign(overrides, JSON.parse(decodeURIComponent(req.query.overrides)));
    }
  } catch {}

  // Enrich projects with PFB totals
  const enriched = PROJECTS.map(p => {
    const ov  = overrides[p.id] || {};
    const dc  = ov.dc || p.dc;
    const ac  = ov.ac || p.ac;
    const sw  = ov.sw || p.sw;
    const ready = !!(dc && ac && sw);

    let pfbTotal = null, ratePerWp = null;
    if (ready) {
      try {
        const pfb = generatePFB(p.name, dc, ac, sw);
        pfbTotal  = pfb.reduce((s, i) => s + i.amount, 0);
        ratePerWp = pfbTotal / (dc * 1000000);
      } catch {}
    }

    return {
      ...p,
      dc, ac, sw,
      pfbReady: ready,
      pfbTotal,
      ratePerWp,
    };
  });

  const firms = groupByFirm(enriched);

  // Build solar parks with project details
  const parks = Object.entries(SOLAR_PARKS).map(([parkName, info]) => {
    const parkProjects = enriched.filter(p => info.projects.includes(p.id));
    return {
      name:        parkName,
      district:    info.district,    // ← add this
      state:       info.state,       // ← add this
      projects:    parkProjects,
      totalDC:     parkProjects.reduce((s, p) => s + (p.dc || 0), 0),
      totalValue:  parkProjects.reduce((s, p) => s + (p.totalValue || 0), 0),
      count:       parkProjects.length,
    };
  }).sort((a, b) => b.totalDC - a.totalDC);

  return res.status(200).json({
    success:       true,
    totalProjects: enriched.length,
    totalFirms:    firms.length,
    firms,
    allProjects:   enriched,
    parks,
  });
}