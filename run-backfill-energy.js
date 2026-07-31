// run-backfill-energy.js
//
// Runs the Energy Reference Rate backfill to completion by itself — no
// manual URL-refreshing needed. Calls the deployed endpoint repeatedly,
// waits sensibly between calls, and specifically handles the one real
// stopping condition that isn't "keep going": Zoho's daily API quota
// running out. When that happens, it doesn't just retry immediately
// (which would burn through nothing but more failures) — it sleeps
// until roughly midnight IST (when Zoho's quota resets) and resumes
// automatically from exactly where the backfill's own cursor left off.
//
// Usage:
//   node run-backfill-energy.js
//
// Requires Node 18+ (built-in fetch). Edit BASE_URL below if your
// deployment URL ever changes.

const BASE_URL = 'https://finance-dashboard-liard-three.vercel.app';
const KEY = 'check123';
const DELAY_BETWEEN_CALLS_MS = 2000; // gentle pacing between normal batches
const RETRY_DELAY_MS = 30000;        // wait before retrying a genuine network/error failure

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Zoho's daily quota resets around midnight IST — sleeps until then
// (plus a small safety buffer) rather than hammering a call that will
// just keep failing for hours.
function msUntilMidnightIST() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const nextMidnightIST = new Date(Date.UTC(
    nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate() + 1, 0, 0, 0
  ));
  const msRemaining = nextMidnightIST.getTime() - nowIST.getTime();
  return msRemaining + 5 * 60 * 1000; // +5 min safety buffer past midnight
}

async function callBackfill() {
  const url = `${BASE_URL}/api/backfill-reference-rates-energy?key=${KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function run() {
  console.log('Starting Energy Reference Rate backfill — this will run on its own until fully complete.\n');

  let callNumber = 0;
  while (true) {
    callNumber++;
    let result;
    try {
      result = await callBackfill();
    } catch (err) {
      console.error(`[Call ${callNumber}] Failed: ${err.message} — retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const summary = result.stage === 'items_done'
      ? `Items catalog stored (${result.catalogSize} active items)`
      : result.stage === 'done'
      ? `DONE — ${result.catalogItemsCovered}/${result.catalogSize} catalog items covered (${result.coveragePercent}%), ${result.freehandItemsTracked} freehand items tracked`
      : `stage=${result.stage}, processed ${result.processedThisBatch} docs this batch (${result.totalProcessedSoFar} total), ${result.distinctItemsFound} distinct items found so far`;

    console.log(`[Call ${callNumber}] ${summary}`);

    if (result.stage === 'done') {
      console.log('\n✅ Backfill complete. The Energy Reference Rate history is now fully populated.');
      break;
    }

    if (result.stoppedEarly) {
      const waitMs = msUntilMidnightIST();
      const waitHours = (waitMs / (60 * 60 * 1000)).toFixed(1);
      console.log(`\n⏸ ${result.stoppedReason}`);
      console.log(`   Sleeping ~${waitHours}h until Zoho's quota resets, then resuming automatically...\n`);
      await sleep(waitMs);
      continue;
    }

    await sleep(DELAY_BETWEEN_CALLS_MS);
  }
}

run().catch(err => {
  console.error('Fatal error, stopping:', err.message);
  process.exit(1);
});
