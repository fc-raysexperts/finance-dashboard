// lib/notifications.js
//
// Detects genuinely NEW pending POs/Bills/PMOs since the last scheduled
// notification check - deliberately its own separate tracking, entirely
// independent of the dashboard's own delta-cache. Whether Jatin manually
// refreshes the live site or not has zero effect on this - it only cares
// about what's new since the last time IT successfully ran.

function findNewIds(currentIds, knownIds) {
  const known = new Set(knownIds || []);
  return currentIds.filter(id => !known.has(id));
}

// Compares current pending items against what was known as of the last
// check, returning counts of genuinely new ones plus the updated full
// known-ID sets to persist for next time.
function detectNewItems(current, known) {
  const newPOs   = findNewIds(current.pos, known.pos);
  const newBills = findNewIds(current.bills, known.bills);
  const newPMOs  = findNewIds(current.pmos, known.pmos);
  const totalNew = newPOs.length + newBills.length + newPMOs.length;
  return {
    totalNew,
    newPOs: newPOs.length, newBills: newBills.length, newPMOs: newPMOs.length,
    updatedKnown: { pos: current.pos, bills: current.bills, pmos: current.pmos },
  };
}

function buildMessageText(counts) {
  const parts = [];
  if (counts.newPOs > 0)   parts.push(`${counts.newPOs} new PO${counts.newPOs > 1 ? 's' : ''}`);
  if (counts.newBills > 0) parts.push(`${counts.newBills} new Bill${counts.newBills > 1 ? 's' : ''}`);
  if (counts.newPMOs > 0)  parts.push(`${counts.newPMOs} new PMO${counts.newPMOs > 1 ? 's' : ''}`);
  const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
  return `Finance Dashboard Update (${timeStr} IST)\n${parts.join(', ')} — Total: ${counts.totalNew} new item${counts.totalNew > 1 ? 's' : ''} pending your approval.`;
}

module.exports = { detectNewItems, buildMessageText, findNewIds };
