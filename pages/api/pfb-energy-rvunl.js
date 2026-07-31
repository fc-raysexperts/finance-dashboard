// pages/api/pfb-energy-rvunl.js
//
// Serves the RVUNL Heerapura BESS project budget for RPE Energy Reserve's
// PFBs Tab. Deliberately its own dedicated route, separate from the
// existing /api/pfb (Solar Parks, Rays-specific) — this project's data
// lives in lib/pfb/energyRVUNL.js, not lib/pfbEngine.js, and nothing
// about the existing system needs to change for this to work.
//
// No org parameter needed here (unlike pos.js/bills.js/pmos.js) — this
// route only ever serves ONE specific project's budget, for ONE specific
// subsidiary. If Energy (or any other subsidiary) ever gets a second
// real project, that would warrant its own similarly-dedicated file and
// route, not a parameter added to this one.

const {
  PROJECT_INFO,
  SUMMARY,
  BESS_COST,
  PCS_COST,
  ELECTRICAL_BOM,
  BUILDING_AND_CIVIL,
  INSTALLATION_UPTO_PSS,
  PSS,
  BAY_GSS_220KV,
  verifyBudgetIntegrity,
} = require('../../lib/pfb/energyRVUNL');
const { buildCandidateList } = require('../../lib/pfb/energyRVUNLMatchEngine');

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Real safety net, not just a formality: if this data file is ever
    // edited later (e.g. correcting a figure, adding a future project)
    // and a mistake breaks the internal math, this check catches it
    // right here — surfaced clearly in the response — rather than
    // silently serving a budget that no longer ties out, which would be
    // far worse for a real financial tool than a visible warning.
    const integrity = verifyBudgetIntegrity();
    if (!integrity.allPassed) {
      console.error('[pfb-energy-rvunl] Budget integrity check FAILED:', JSON.stringify(integrity.failed));
    }

    return res.status(200).json({
      success: true,
      integrityCheckPassed: integrity.allPassed,
      integrityFailures: integrity.allPassed ? [] : integrity.failed.map(f => f.label),
      data: {
        project: PROJECT_INFO,
        summary: SUMMARY,
        components: {
          bessCost: BESS_COST,
          pcsCost: PCS_COST,
          electricalBOM: ELECTRICAL_BOM,
          buildingAndCivil: BUILDING_AND_CIVIL,
          installationUptoPSS: INSTALLATION_UPTO_PSS,
          pss: PSS,
          bayGSS220kV: BAY_GSS_220KV,
        },
        // Flattened Category+Item candidate list, straight from the same
        // function the match engine itself uses — so the manual-override
        // picker can never drift out of sync with what real matching
        // actually considers.
        matchCandidates: buildCandidateList(),
      },
    });
  } catch (err) {
    console.error('[pfb-energy-rvunl] API error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
