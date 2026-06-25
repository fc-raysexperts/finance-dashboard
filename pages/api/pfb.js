// pages/api/pfb.js
// GET  /api/pfb?projectId=jsw            -> PFB for an existing project (uses stored overrides)
// POST /api/pfb  body:{name,dc,ac,sw,piling,wall,road,agreementDate} -> PFB for any project
//
// Rate-history note (per item 1's clarification in the original request):
// if rate tables are ever updated via the "Update Rates" upload feature,
// each update is stored with an `appliedAt` timestamp in lib/store.js
// (KEYS.RATE_HISTORY). When generating a PFB for a project, we pick the
// most recent rate-table whose appliedAt <= the project's agreementDate,
// so older projects keep using the rate table that was active when they
// were signed, even if rates have since changed multiple times.

import { generatePFB } from '../../lib/pfbEngine';
import { PROJECTS }    from '../../data/projects';
const { storeGet, KEYS } = require('../../lib/store');

function toComparable(ddmmyyyy) {
  if (!ddmmyyyy) return null;
  const [d, m, y] = ddmmyyyy.split('-');
  return `${y}-${m}-${d}`;
}

async function getRateOverridesForDate(agreementDateDDMMYYYY) {
  const history = (await storeGet(KEYS.RATE_HISTORY)) || [];
  if (history.length === 0) return null;

  const agreementComp = toComparable(agreementDateDDMMYYYY) || '9999-99-99'; // no date = use latest

  // Sort history oldest -> newest, find the latest entry whose appliedAt <= agreement date
  const sorted = [...history].sort((a, b) => new Date(a.appliedAt) - new Date(b.appliedAt));
  let applicable = null;
  for (const entry of sorted) {
    if (new Date(entry.appliedAt) <= new Date(agreementComp === '9999-99-99' ? Date.now() : agreementComp)) {
      applicable = entry;
    }
  }
  // If agreement date is before ALL rate updates, use the original defaults (return null)
  // If agreement date is after some updates, use the latest applicable one
  return applicable ? { rates: applicable.rates, newItems: applicable.newItems } : null;
}

export default async function handler(req, res) {

  if (req.method === 'GET') {
    const { projectId, overrides: overridesParam } = req.query;
    const project = PROJECTS.find(p => p.id === projectId);

    if (!project) {
      return res.status(404).json({ error: `Project "${projectId}" not found` });
    }

    let parsedOverrides = {};
    try { if (overridesParam) parsedOverrides = JSON.parse(decodeURIComponent(overridesParam)); } catch {}

    const variableOvr = (await storeGet(KEYS.VARIABLE_OVR)) || {};
    const ov = { ...(variableOvr[project.id] || {}), ...(parsedOverrides[project.id] || {}) };

    const dc     = ov.dc     ?? project.dc;
    const ac     = ov.ac     ?? project.ac;
    const sw     = ov.sw     ?? project.sw;
    const piling = ov.piling ?? project.piling ?? 2000;
    const wall   = ov.wall   ?? project.wall   ?? 2000;
    const road   = ov.road   ?? project.road   ?? 2000;

    if (!dc || !ac || !sw) {
      return res.status(400).json({ error: `Project "${project.name}" is missing DC/AC/SW variables` });
    }

    const rateOverrides = await getRateOverridesForDate(project.agreementDate);
    const pfb   = generatePFB(project.name, dc, ac, sw, piling, wall, road, rateOverrides);
    const total = pfb.reduce((s, i) => s + i.amount, 0);

    return res.status(200).json({
      success: true, project: project.name,
      dc, ac, sw, piling, wall, road,
      ratePerWp: total / (dc * 1000000),
      grandTotal: total,
      items: pfb,
    });
  }

  if (req.method === 'POST') {
    const {
      name, dc, ac, sw,
      piling = 2000, wall = 2000, road = 2000,
      agreementDate = null,
    } = req.body;

    if (!name || !dc || !ac || !sw) {
      return res.status(400).json({ error: 'name, dc, ac, sw are all required' });
    }

    const DC = parseFloat(dc), AC = parseFloat(ac), SW = parseInt(sw);
    const PILING = parseInt(piling) || 2000;
    const WALL   = parseInt(wall)   || 2000;
    const ROAD   = parseInt(road)   || 2000;

    const rateOverrides = await getRateOverridesForDate(agreementDate);
    const pfb   = generatePFB(name, DC, AC, SW, PILING, WALL, ROAD, rateOverrides);
    const total = pfb.reduce((s, i) => s + i.amount, 0);

    return res.status(200).json({
      success: true, project: name,
      dc: DC, ac: AC, sw: SW, piling: PILING, wall: WALL, road: ROAD,
      ratePerWp: total / (DC * 1000000),
      grandTotal: total,
      items: pfb,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
