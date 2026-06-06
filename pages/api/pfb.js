// pages/api/pfb.js
// Generate PFB for a given project
// GET /api/pfb?projectId=jsw              → returns computed PFB
// POST /api/pfb  body:{name,dc,ac,sw,piling,wall,road} → returns computed PFB

import { generatePFB } from '../../lib/pfbEngine';
import { PROJECTS }    from '../../data/projects';

export default async function handler(req, res) {

  // ── GET — retrieve PFB for an existing project ───────────────
  if (req.method === 'GET') {
    const { projectId } = req.query;
    const project = PROJECTS.find(p => p.id === projectId);

    if (!project) {
      return res.status(404).json({ error: `Project "${projectId}" not found` });
    }
    if (!project.dc || !project.ac || !project.sw) {
      return res.status(400).json({
        error: `Project "${project.name}" is missing DC/AC/SW variables — set them first`
      });
    }

    // Load any localStorage overrides passed as query param
    const overrides = {};
    try {
      if (req.query.overrides) {
        Object.assign(overrides, JSON.parse(decodeURIComponent(req.query.overrides)));
      }
    } catch {}

    const ov     = overrides[project.id] || {};
    const dc     = ov.dc     || project.dc;
    const ac     = ov.ac     || project.ac;
    const sw     = ov.sw     || project.sw;
    const piling = ov.piling || project.piling || 2000;
    const wall   = ov.wall   || project.wall   || 2000;
    const road   = ov.road   || project.road   || 2000;

    const pfb   = generatePFB(project.name, dc, ac, sw, piling, wall, road);
    const total = pfb.reduce((s, i) => s + i.amount, 0);

    return res.status(200).json({
      success:    true,
      project:    project.name,
      dc, ac, sw, piling, wall, road,
      ratePerWp:  total / (dc * 1000000),
      grandTotal: total,
      items:      pfb,
    });
  }

  // ── POST — generate PFB for any project (new or existing) ────
  if (req.method === 'POST') {
    const {
      name,
      dc, ac, sw,
      piling = 2000,
      wall   = 2000,
      road   = 2000,
    } = req.body;

    if (!name || !dc || !ac || !sw) {
      return res.status(400).json({ error: 'name, dc, ac, sw are all required' });
    }

    const DC     = parseFloat(dc);
    const AC     = parseFloat(ac);
    const SW     = parseInt(sw);
    const PILING = parseInt(piling) || 2000;
    const WALL   = parseInt(wall)   || 2000;
    const ROAD   = parseInt(road)   || 2000;

    const pfb   = generatePFB(name, DC, AC, SW, PILING, WALL, ROAD);
    const total = pfb.reduce((s, i) => s + i.amount, 0);

    return res.status(200).json({
      success:    true,
      project:    name,
      dc: DC, ac: AC, sw: SW,
      piling: PILING, wall: WALL, road: ROAD,
      ratePerWp:  total / (DC * 1000000),
      grandTotal: total,
      items:      pfb,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}