// lib/approvalFastCheck.js
//
// Cheap pre-check for Approval Status, run BEFORE calling the AI. Catches
// the clear/obvious cases (misspellings, tense, case) without spending an
// AI call — but explicitly does NOT try to catch open-ended phrasing like
// "Go with jd mudhyal", which has no lexical relationship to "approved"
// at all and can only be judged by AI. Real risk if built carelessly:
// naive substring matching on "approv-" would also match "NOT approved"
// or "rejected" as if it were a positive — the negation guard below
// exists specifically to prevent that.

// Roots close enough to "approve"/"approved" to catch typos, case, tense.
// Deliberately narrow — anything not close to these still goes to AI.
const POSITIVE_ROOTS = ['approv', 'aprov', 'apprived', 'aprived', 'ok to proceed', 'go ahead', 'confirmed'];
const NEGATION_WINDOW_WORDS = ['not', 'never', 'reject', 'rejected', 'disapprov', "don't", 'do not', 'hold', 'pending', 'declin', 'cannot', "can't"];

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// Checks a short window of words around a match for negation terms.
function hasNegationNearby(words, matchIndex, windowSize = 4) {
  const start = Math.max(0, matchIndex - windowSize);
  const end = Math.min(words.length, matchIndex + windowSize + 1);
  const window = words.slice(start, end).join(' ').toLowerCase();
  return NEGATION_WINDOW_WORDS.some(neg => window.includes(neg));
}

// Returns { confident: true, passed: true, matchedWord, comment }
//      or { confident: false } — meaning: fall back to AI.
function fastApprovalCheck(text) {
  if (!text) return { confident: false };
  const words = text.split(/\s+/);

  for (let i = 0; i < words.length; i++) {
    const wordLower = words[i].toLowerCase().replace(/[^a-z]/g, '');
    if (wordLower.length < 4) continue;

    for (const root of POSITIVE_ROOTS) {
      const rootClean = root.replace(/[^a-z]/g, '');
      if (rootClean.length < 4) continue;
      // Allow up to 2 character edits — catches "Apprived", "Aproved",
      // "APROVED", etc. without being so loose it matches unrelated words.
      const dist = levenshtein(wordLower.slice(0, rootClean.length + 2), rootClean);
      if (dist <= 2) {
        if (hasNegationNearby(words, i)) {
          // Found something approval-shaped, but negated nearby — NOT
          // confident this is a positive. Escalate to AI rather than
          // guess wrong in either direction.
          return { confident: false, reason: 'negation-nearby' };
        }
        return {
          confident: true,
          passed: true,
          matchedWord: words[i],
          comment: `Fast-matched "${words[i]}" as a positive approval confirmation (no negation found nearby) — verified without an AI call`,
        };
      }
    }
  }

  return { confident: false }; // nothing obviously matched — needs AI judgment
}

module.exports = { fastApprovalCheck };
