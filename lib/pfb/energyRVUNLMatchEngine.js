// lib/pfb/energyRVUNLMatchEngine.js
//
// PFB Match engine for RPE Energy Reserve's RVUNL Heerapura BESS project.
// Matches a real PO/Bill/PMO line item's description against the
// project's own budget (lib/pfb/energyRVUNL.js), so its actual cost can
// be compared against what was budgeted for it.
//
// Deliberately its own file, completely separate from
// lib/aiComplianceEngine.js and lib/pfbEngine.js — nothing here touches
// either of those, and this only ever runs for Energy's own PBPs.
//
// THE REAL FLOW, for one incoming line item's description:
//   1. Check memory first (KEYS-equivalent KV cache, keyed by the
//      normalized description) — if this exact text was already
//      resolved before (automatically or manually), reuse it instantly.
//      Zero computation, zero AI call, every time after the first.
//   2. Layer 1 — one clean, code-only attempt: normalize both sides and
//      look for an exact or very-near-exact match against the full
//      candidate list. This is NOT a fuzzy "good enough" match — it's
//      deliberately strict, matching the explicit design decision that
//      code should try ONCE cleanly and then hand off, rather than keep
//      guessing with looser and looser thresholds (which produces
//      confident-looking wrong answers more often than it helps).
//   3. If Layer 1 finds exactly one clear winner — done, save it to
//      memory, no AI needed.
//   4. If Layer 1 finds nothing, or finds several plausible ties —
//      straight to AI (Layer 2), passing only the specific tied
//      candidates (if any) or the whole candidate list (if none matched
//      at all) — never a vague "figure it out" prompt with no structure.
//   5. If AI is confident — use its pick, save to memory.
//   6. If AI is also unsure — return "unmatched, needs manual review."
//      The frontend/API layer surfaces a Component+Item picker; once the
//      user picks one, saveManualMatch() below records it the same way
//      an automatic match would, so the exact same real-world text
//      never needs re-resolving again.
//   7. Whatever the match method, if it resolved to a LOT SUB-ITEM
//      (CCTV/Insurance), the running total for JUST that sub-item is
//      updated (persisted), and the comparison is against that
//      sub-item's own allocated share — not the full lot. If it matched
//      the parent lot as a whole (the whole thing ordered together),
//      the comparison is against the full lot total directly.
//
// Categories 8–11 (Land Cost, Preliminary & Preoperative, Contingency,
// IDC) are deliberately EXCLUDED from the candidate list entirely — they
// aren't real, named, vendor-invoiceable items (a nominal land fee, two
// computed overhead percentages, and bank loan interest), so there's
// nothing genuine to match a PO/Bill/PMO item against for any of them.
// Tracking spend against these 4 belongs to the separate Budget Tracker
// feature (category-level utilization), not this item-level matcher.

const { storeGet, storeSet, orgScopedKey } = require('../store');
const { waitForSharedPOPMOSlot } = require('../aiComplianceEngine');
const crypto = require('crypto');
const { callGeminiWithDocuments } = require('../geminiClient');
const {
  BESS_COST, ELECTRICAL_BOM, BUILDING_AND_CIVIL,
  INSTALLATION_UPTO_PSS, PSS, BAY_GSS_220KV,
} = require('./energyRVUNL');

const MATCH_MEMORY_KEY = 'pfb_match_memory__energy_rvunl';
const LOT_TRACKER_KEY = 'pfb_lot_tracker__energy_rvunl';
const MATCH_RESULTS_CACHE_KEY = 'pfb_match_results__energy_rvunl'; // per-PBP match results, keyed by fingerprint — same content-change-detection pattern already used for AI compliance caching

// ── Normalization + similarity — the Layer 1 code-only logic ────────────
function normalize(s) {
  if (!s) return '';
  let out = String(s).toLowerCase();
  // Real fix, found via direct testing: "245 kV" and "245kV" must
  // normalize to the exact same thing — otherwise one tokenizes as
  // ["245","kv"] and the other as ["245kv"], causing a genuine,
  // semantically-identical vendor phrasing to score lower than it
  // should purely due to spacing. Only collapses known technical unit
  // abbreviations specifically (not any arbitrary following word, since
  // that would inconsistently also collapse generic phrases like
  // "3 Phase" vs "(3-Phase)", which should stay as 2 tokens either way).
  out = out.replace(/(\d+(?:\.\d+)?)\s+(kv|kva|ka|kw|kwh|mw|mwh|mm|hz|va|amp|amps)\b/gi, '$1$2');
  out = out.replace(/[^\w\s]/g, ' '); // strip remaining punctuation
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

const STOPWORDS = new Set(['with','and','for','the','of','a','an','to','in','on','at','is','as','or','type','per']);

// Real fix found via testing: "breaker" vs "breakers" (plain plural)
// don't match as tokens at all without this, needlessly escalating an
// otherwise obvious match to AI. Deliberately conservative — only
// strips a trailing 's' from words 4+ letters (never short technical
// codes/units like "ka", "va", "3", which could be corrupted by naive
// stemming), and only when the word doesn't already end in a double 's'.
function stem(word) {
  if (word.length >= 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function tokenize(s) {
  return normalize(s).split(' ').filter(w => w && !STOPWORDS.has(w)).map(stem);
}

// Jaccard-style overlap, but technical tokens (anything with a digit —
// voltage/amperage/kA ratings etc.) count double, since those are the
// tokens that actually distinguish one real item from a superficially
// similar one (e.g. "245kV" vs "132kV" matters far more than "with").
function similarityScore(a, b) {
  const ta = tokenize(a), tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const weight = (tok) => (/\d/.test(tok) ? 2 : 1);
  const setB = new Set(tb);
  let intersection = 0, unionWeight = 0;
  const seen = new Set();
  for (const t of ta) {
    const w = weight(t);
    unionWeight += w;
    if (setB.has(t) && !seen.has(t)) { intersection += w; seen.add(t); }
  }
  for (const t of tb) {
    if (!seen.has(t)) unionWeight += weight(t);
  }
  return unionWeight === 0 ? 0 : intersection / unionWeight;
}

const LAYER1_CONFIDENT_THRESHOLD = 0.85; // deliberately strict — a clean win, not a "good enough" guess
const LAYER1_PLAUSIBLE_THRESHOLD = 0.5;  // below strict-confident but still worth showing AI as a real candidate to consider

// ── Build the full searchable candidate list ────────────────────────────
// Every candidate: { category, categoryLabel, itemName, description,
// budgetAmount, isLotSubItem, parentLotName }
function buildCandidateList() {
  const candidates = [];

  for (const item of BESS_COST.items) {
    candidates.push({ category: 'bessCost', categoryLabel: BESS_COST.category, itemName: item.itemName, description: item.description, budgetAmount: item.total, isLotSubItem: false, parentLotName: null });
  }

  for (const item of ELECTRICAL_BOM.items) {
    if (item.isLot) {
      // The parent lot itself is ALSO a real candidate — a PBP that
      // orders the whole lot together should match here, not against
      // any single sub-item.
      candidates.push({ category: 'electricalBOM', categoryLabel: ELECTRICAL_BOM.category, itemName: item.itemName, description: [item.description, ...(item.subItems||[])].join('; '), budgetAmount: item.lotTotal, isLotSubItem: false, parentLotName: null });
      for (const sub of item.lotItems) {
        candidates.push({ category: 'electricalBOM', categoryLabel: ELECTRICAL_BOM.category, itemName: item.itemName, description: sub.name, budgetAmount: sub.allocatedShare, isLotSubItem: true, parentLotName: item.itemName });
      }
    } else {
      candidates.push({ category: 'electricalBOM', categoryLabel: ELECTRICAL_BOM.category, itemName: item.itemName, description: item.description, budgetAmount: item.total, isLotSubItem: false, parentLotName: null });
    }
  }

  for (const item of BUILDING_AND_CIVIL.items) {
    candidates.push({ category: 'buildingAndCivil', categoryLabel: BUILDING_AND_CIVIL.category, itemName: item.itemName, description: item.description, budgetAmount: item.total, isLotSubItem: false, parentLotName: null });
  }

  for (const item of INSTALLATION_UPTO_PSS.items) {
    candidates.push({ category: 'installationUptoPSS', categoryLabel: INSTALLATION_UPTO_PSS.category, itemName: item.itemName, description: item.itemName + ' (' + item.group + ')', budgetAmount: item.totalWithGST, isLotSubItem: false, parentLotName: null });
  }

  for (const item of PSS.pssSpecificItems) {
    candidates.push({ category: 'pss', categoryLabel: PSS.category + ' — PSS-Specific', itemName: item.itemName, description: item.description, budgetAmount: item.total, isLotSubItem: false, parentLotName: null });
  }
  for (const item of PSS.commonPoolingItems) {
    candidates.push({ category: 'pss', categoryLabel: PSS.category + ' — Common Pooling', itemName: item.itemName, description: item.description, budgetAmount: item.total, isLotSubItem: false, parentLotName: null });
  }

  for (const item of BAY_GSS_220KV.items) {
    candidates.push({ category: 'bayGSS220kV', categoryLabel: BAY_GSS_220KV.category, itemName: item.itemName, description: item.description, budgetAmount: item.total, isLotSubItem: false, parentLotName: null });
  }

  return candidates;
}

// ── Layer 1 — one clean, code-only attempt ──────────────────────────────
// Deliberately simple, by explicit design decision: score >= 0.85 with a
// single unique winner is trusted outright, with zero AI call. Anything
// else — genuinely unclear, or several plausible candidates tied — goes
// straight to AI, since a single Gemini call resolves this reliably in
// one clean shot regardless, so there's no real cost to deferring more
// often rather than trying to stretch the code-only path further.
function runLayer1(newItemDescription, candidates) {
  const scored = candidates.map(c => ({ candidate: c, score: similarityScore(newItemDescription, c.description) }))
    .filter(s => s.score >= LAYER1_PLAUSIBLE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { outcome: 'no_match', ties: [] };

  const top = scored[0];
  const tiedAtTop = scored.filter(s => Math.abs(s.score - top.score) < 0.05);

  if (top.score >= LAYER1_CONFIDENT_THRESHOLD && tiedAtTop.length === 1) {
    return { outcome: 'confident', match: top.candidate, score: top.score };
  }
  // Either not confident enough, or genuinely tied between 2+ candidates
  // — either way, this goes to AI. Cap how many candidates get passed
  // along, so a pathological case doesn't send a huge list to Gemini.
  return { outcome: 'ambiguous', ties: scored.slice(0, 8).map(s => s.candidate) };
}

// ── Layer 2 — AI escalation ──────────────────────────────────────────────
async function runLayer2AI(newItemDescription, candidatesToConsider) {
  await waitForSharedPOPMOSlot(); // this shares the PO/PMO Gemini key — same real rate-limit discipline as everywhere else

  const prompt = `You are matching a real purchase item description against a list of budget line items from a project budget, to find which ONE budget line this item was bought for (if any).

New item description (from a real Purchase Order / Bill / Payment Memo):
"${newItemDescription}"

Candidate budget line items (pick the single best match, or none if genuinely none fit):
${candidatesToConsider.map((c, i) => `${i}. [${c.categoryLabel}] "${c.itemName}" — ${c.description} (budgeted: Rs ${c.budgetAmount})`).join('\n')}

Respond ONLY with JSON, no other text: {"matchIndex": <number 0-${candidatesToConsider.length - 1}, or null if genuinely no candidate is a real match>, "confidence": "high"|"low", "reasoning": "<one short sentence>"}`;

  const result = await callGeminiWithDocuments({ tabType: 'po', prompt, attachments: [] });
  if (result.matchIndex == null || result.confidence !== 'high') {
    return { outcome: 'unmatched', reasoning: result.reasoning || 'AI could not confidently match this item.' };
  }
  return { outcome: 'matched', match: candidatesToConsider[result.matchIndex], reasoning: result.reasoning };
}

// Batch version — resolves EVERY uncertain item from one PBP in a single
// Gemini call, each against its own candidate list, rather than one call
// per item. Explicit design decision: since a single Gemini call already
// resolves this reliably in one clean shot, there's no real benefit to
// keeping Layer 1's threshold artificially strict just to avoid AI calls
// — so it's worth combining everything one PBP needs into one request,
// rather than firing off several separate ones back to back.
async function runBatchAI(items) {
  await waitForSharedPOPMOSlot(); // ONE wait, ONE call, for the whole batch — not one per item

  const prompt = `You are matching several real purchase item descriptions against budget line items from a project budget — pick ONE best match for EACH item below, each against its OWN candidate list (or none, if genuinely no candidate fits that specific item).

${items.map((item, idx) => `=== ITEM ${idx} ===
Description: "${item.description}"
Candidates (pick the single best match for THIS item, or none):
${item.candidates.map((c, ci) => `${ci}. [${c.categoryLabel}] "${c.itemName}" — ${c.description} (budgeted: Rs ${c.budgetAmount})`).join('\n')}
`).join('\n')}
Respond ONLY with JSON, no other text, with exactly one entry per item: {"matches": [{"itemIndex": <0-${items.length - 1}>, "matchIndex": <candidate index for that item, or null if genuinely none fit>, "confidence": "high"|"low"}]}`;

  const result = await callGeminiWithDocuments({ tabType: 'po', prompt, attachments: [] });
  const matches = result.matches || [];
  return items.map((item, idx) => {
    const m = matches.find(mm => mm.itemIndex === idx);
    if (!m || m.matchIndex == null || m.confidence !== 'high') {
      return { outcome: 'unmatched', reasoning: 'AI could not confidently match this item.' };
    }
    return { outcome: 'matched', match: item.candidates[m.matchIndex] };
  });
}

// ── Memory — resolved matches, keyed by normalized description ─────────
async function getMemory() {
  return (await storeGet(orgScopedKey(MATCH_MEMORY_KEY, 'energy'))) || {};
}
async function saveMemory(memory) {
  await storeSet(orgScopedKey(MATCH_MEMORY_KEY, 'energy'), memory);
}

async function saveManualMatch(newItemDescription, candidate) {
  const memory = await getMemory();
  memory[normalize(newItemDescription)] = { candidate, method: 'manual', savedAt: new Date().toISOString() };
  await saveMemory(memory);
}

// ── Lot tracker — running totals per lot sub-item, persisted ───────────
async function getLotTracker() {
  return (await storeGet(orgScopedKey(LOT_TRACKER_KEY, 'energy'))) || {};
}
async function recordLotSpend(parentLotName, subItemName, amount) {
  const tracker = await getLotTracker();
  if (!tracker[parentLotName]) tracker[parentLotName] = {};
  tracker[parentLotName][subItemName] = (tracker[parentLotName][subItemName] || 0) + amount;
  await storeSet(orgScopedKey(LOT_TRACKER_KEY, 'energy'), tracker);
  return tracker[parentLotName][subItemName];
}

// ── The main entry point ─────────────────────────────────────────────────
async function matchPBPItemToBudget(newItemDescription, actualAmount) {
  const normalized = normalize(newItemDescription);
  const memory = await getMemory();

  if (memory[normalized]) {
    return finalizeMatch(memory[normalized].candidate, 'memory', actualAmount);
  }

  const candidates = buildCandidateList();
  const layer1 = runLayer1(newItemDescription, candidates);

  if (layer1.outcome === 'confident') {
    const mem = await getMemory();
    mem[normalized] = { candidate: layer1.match, method: 'layer1', savedAt: new Date().toISOString() };
    await saveMemory(mem);
    return finalizeMatch(layer1.match, 'layer1', actualAmount);
  }

  // Layer 1 found nothing or a genuine tie — straight to AI, exactly the
  // agreed design (one clean code attempt, then AI, no in-between guessing).
  const aiCandidates = layer1.outcome === 'ambiguous' ? layer1.ties : candidates;
  try {
    const layer2 = await runLayer2AI(newItemDescription, aiCandidates);
    if (layer2.outcome === 'matched') {
      const mem = await getMemory();
      mem[normalized] = { candidate: layer2.match, method: 'ai', savedAt: new Date().toISOString() };
      await saveMemory(mem);
      return finalizeMatch(layer2.match, 'ai', actualAmount);
    }
    return { matched: false, method: 'unmatched', reasoning: layer2.reasoning };
  } catch (e) {
    // AI itself failed (quota, network, etc.) — don't silently guess;
    // surface this honestly as unmatched, same as a genuine "unclear".
    return { matched: false, method: 'unmatched', reasoning: 'AI matching failed: ' + e.message };
  }
}

async function finalizeMatch(candidate, method, actualAmount) {
  let lotInfo = null;
  if (candidate.isLotSubItem) {
    const spentSoFar = await recordLotSpend(candidate.parentLotName, candidate.itemName === candidate.parentLotName ? candidate.description : candidate.description, actualAmount);
    lotInfo = { parentLotName: candidate.parentLotName, subItemName: candidate.description, allocatedShare: candidate.budgetAmount, spentSoFar };
  }
  return {
    matched: true,
    method, // 'memory' | 'layer1' | 'ai'
    category: candidate.category,
    categoryLabel: candidate.categoryLabel,
    itemName: candidate.itemName,
    matchedDescription: candidate.description,
    budgetAmount: candidate.budgetAmount,
    actualAmount,
    variance: actualAmount - candidate.budgetAmount,
    isLotSubItem: candidate.isLotSubItem,
    lotInfo,
  };
}

// ── Batch entry point — runs the whole flow across a real PBP's actual
// line items (Zoho's real shape: { name, rate, quantity, item_total }).
// Called from pos.js/bills.js/pmos.js, Energy-only.
//
// Genuinely batches: memory + Layer 1 run per-item first (cheap,
// code-only, no network calls at all), and everything still uncertain
// after that gets resolved in ONE combined Gemini call — not one call
// per uncertain item.
async function matchAllLineItems(lineItems) {
  const items = (lineItems || []).filter(li => li.name);
  const memory = await getMemory();
  const candidates = buildCandidateList();
  const results = new Array(items.length).fill(null);
  const needsAI = []; // { resultIndex, description, actualAmount, candidates }

  for (let i = 0; i < items.length; i++) {
    const li = items[i];
    const normalized = normalize(li.name);
    if (memory[normalized]) {
      results[i] = await finalizeMatch(memory[normalized].candidate, 'memory', li.item_total || 0);
      continue;
    }
    const layer1 = runLayer1(li.name, candidates);
    if (layer1.outcome === 'confident') {
      memory[normalized] = { candidate: layer1.match, method: 'layer1', savedAt: new Date().toISOString() };
      results[i] = await finalizeMatch(layer1.match, 'layer1', li.item_total || 0);
    } else {
      needsAI.push({
        resultIndex: i,
        description: li.name,
        actualAmount: li.item_total || 0,
        candidates: layer1.outcome === 'ambiguous' ? layer1.ties : candidates,
      });
    }
  }

  if (needsAI.length > 0) {
    try {
      const aiOutcomes = await runBatchAI(needsAI);
      for (let j = 0; j < needsAI.length; j++) {
        const item = needsAI[j];
        const outcome = aiOutcomes[j];
        if (outcome.outcome === 'matched') {
          memory[normalize(item.description)] = { candidate: outcome.match, method: 'ai', savedAt: new Date().toISOString() };
          results[item.resultIndex] = await finalizeMatch(outcome.match, 'ai', item.actualAmount);
        } else {
          results[item.resultIndex] = { matched: false, method: 'unmatched', reasoning: outcome.reasoning };
        }
      }
    } catch (e) {
      // The whole batch call failed (quota, network, etc.) — mark every
      // item that needed AI as honestly unmatched, not a silent guess.
      for (const item of needsAI) {
        results[item.resultIndex] = { matched: false, method: 'unmatched', reasoning: 'AI batch matching failed: ' + e.message };
      }
    }
  }

  await saveMemory(memory);

  return items.map((li, i) => ({ lineItemName: li.name, ...results[i] }));
}

// Looks up a specific candidate by category + itemName + (matched)
// description — used by the manual-override endpoint to resolve exactly
// which real candidate the user picked in the UI.
function findCandidateByChoice(category, itemName, matchedDescription) {
  const candidates = buildCandidateList();
  return candidates.find(c => c.category === category && c.itemName === itemName && (matchedDescription == null || c.description === matchedDescription)) || null;
}

// Dedicated fingerprint for PFB Match specifically — deliberately NOT
// the same one aiComplianceEngine.js uses (that one hashes notes,
// documents, and approvers, since that's what AI compliance re-checking
// actually cares about). Real bug found via direct testing: reusing
// that fingerprint here would silently keep serving a stale match
// result if a PBP's line items or amounts changed but its notes/
// documents/approvers didn't — exactly the opposite of what actually
// needs to trigger a re-match for THIS feature.
function buildPFBMatchFingerprint(pbp) {
  const items = (pbp.line_items || []).map(li => `${li.name || ''}:${li.item_total || 0}`).sort();
  return crypto.createHash('sha256').update(items.join('|')).digest('hex');
}

// ── The real entry point called from pos.js/bills.js/pmos.js ───────────
// Caches per-PBP, keyed by the fingerprint above — if this PBP's real
// line items (names + amounts) haven't changed since last time, this
// returns instantly with zero re-matching and zero AI calls. Only
// genuinely new or edited PBPs actually run the match engine again.
async function getPFBMatchForPBP(pbp, pbpType, pbpId) {
  const fingerprint = buildPFBMatchFingerprint(pbp);
  const cacheKey = `${pbpType}:${pbpId}`;
  const cache = (await storeGet(orgScopedKey(MATCH_RESULTS_CACHE_KEY, 'energy'))) || {};
  const cached = cache[cacheKey];

  if (cached && cached.fingerprint === fingerprint) {
    return cached.results;
  }

  const results = await matchAllLineItems(pbp.line_items || []);
  cache[cacheKey] = { fingerprint, results, checkedAt: new Date().toISOString() };
  await storeSet(orgScopedKey(MATCH_RESULTS_CACHE_KEY, 'energy'), cache);
  return results;
}

// Invalidates one specific PBP's cached match results — needed after a
// manual override. Saving a manual choice to memory alone isn't enough:
// if this PBP's own fingerprint hasn't changed (same line items, same
// amounts), getPFBMatchForPBP would keep serving its OLD cached results
// (still showing "unmatched" for the item that was just manually
// resolved) rather than picking up the new memory entry. Deleting the
// cache entry forces one fresh re-match next time this PBP is viewed,
// which will now correctly find the manual match via memory.
async function invalidatePFBMatchCache(pbpType, pbpId) {
  const cache = (await storeGet(orgScopedKey(MATCH_RESULTS_CACHE_KEY, 'energy'))) || {};
  delete cache[`${pbpType}:${pbpId}`];
  await storeSet(orgScopedKey(MATCH_RESULTS_CACHE_KEY, 'energy'), cache);
}

module.exports = {
  buildCandidateList,
  matchPBPItemToBudget,
  matchAllLineItems,
  getPFBMatchForPBP,
  invalidatePFBMatchCache,
  saveManualMatch,
  findCandidateByChoice,
  getMemory,
  getLotTracker,
  normalize,
  similarityScore,
};
