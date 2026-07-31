// pages/api/pfb-match-manual-override.js
//
// Manual override endpoint for PFB Match — Layer 4, the final fallback
// when a real PO/Bill/PMO line item couldn't be confidently matched by
// either Layer 1 (code) or Layer 2 (AI). The user picks the correct
// Component + Item themselves; this saves that choice to the match
// engine's memory (so the exact same real-world text auto-matches
// instantly next time, with no AI or manual work needed again), and
// invalidates this specific PBP's cached match results so the
// correction is reflected immediately, not just for future PBPs.
//
// Energy-only, RVUNL-specific — deliberately its own small, single-
// purpose route, matching the same "one file, one job" pattern already
// used throughout this project's API routes.

const {
  findCandidateByChoice,
  saveManualMatch,
  invalidatePFBMatchCache,
} = require('../../lib/pfb/energyRVUNLMatchEngine');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'POST only' });
  }

  const { pbpType, pbpId, lineItemDescription, category, itemName, matchedDescription } = req.body || {};

  if (!pbpType || !pbpId || !lineItemDescription || !category || !itemName) {
    return res.status(400).json({
      success: false,
      error: 'pbpType, pbpId, lineItemDescription, category, and itemName are all required',
    });
  }

  try {
    const candidate = findCandidateByChoice(category, itemName, matchedDescription ?? null);
    if (!candidate) {
      return res.status(404).json({
        success: false,
        error: `Could not find a budget item matching category="${category}", itemName="${itemName}"${matchedDescription ? `, description="${matchedDescription}"` : ''} — the choice may no longer exist in the current budget.`,
      });
    }

    await saveManualMatch(lineItemDescription, candidate);
    await invalidatePFBMatchCache(pbpType, pbpId);

    return res.status(200).json({
      success: true,
      saved: {
        lineItemDescription,
        category: candidate.category,
        categoryLabel: candidate.categoryLabel,
        itemName: candidate.itemName,
        matchedDescription: candidate.description,
        budgetAmount: candidate.budgetAmount,
        isLotSubItem: candidate.isLotSubItem,
      },
    });
  } catch (err) {
    console.error('[pfb-match-manual-override] error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
