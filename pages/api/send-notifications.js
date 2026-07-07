// pages/api/send-notifications.js
//
// Called on a schedule (GitHub Actions, Mon-Sat 10am-6pm IST hourly) -
// checks for genuinely new items PENDING JATIN'S OWN APPROVAL specifically
// (not company-wide) since the last run, and notifies him via WhatsApp.
//
// Two real bugs fixed this round:
// 1. COLD START: the very first time this ever ran, there was no prior
//    baseline to compare against, so EVERY currently-pending item got
//    counted as "new" (271 items - a company-wide total, not a real
//    change). Fixed: the first run now silently records the baseline and
//    sends nothing, since there's no genuine "new" to report yet.
// 2. WRONG SCOPE: this was querying ALL company-wide pending POs/Bills,
//    not just what's actually pending Jatin's own approval - explaining
//    why the count (271) was wildly higher than what he actually sees on
//    his dashboard ("dozens"). Fixed: now reuses getPendingPOs/
//    getPendingBills directly from lib/zoho.js - the EXACT same functions
//    the dashboard itself uses, guaranteeing identical scope, not a
//    separately hand-rolled (and wrong) version of the same filtering.
//
// Email notifications were deliberately dropped: Zoho itself already
// sends Jatin an email whenever a new PO/Bill/PMO needs his approval, and
// the org's Google Workspace policy blocks the workarounds needed to
// send email from this app.

const axios = require('axios');
const { storeGet, storeSet } = require('../../lib/store');
const { detectNewItems, buildMessageText } = require('../../lib/notifications');
const { getPendingPOs, getPendingBills } = require('../../lib/zoho');

const KNOWN_IDS_KEY = 'notification_known_ids';
// Bumped because the previous version's baseline was scoped WRONG
// (company-wide instead of Jatin-specific) - this forces that corrupted
// baseline to be discarded and a genuine, correctly-scoped cold start to
// happen once, rather than comparing fresh Jatin-specific data against an
// old company-wide snapshot.
const KNOWN_IDS_VERSION = 2;

// Real fix: reuses the dashboard's OWN pending-fetch functions instead of
// a separately hand-rolled (and wrongly company-wide) version - this
// guarantees the exact same scope Jatin already sees on his dashboard.
async function getCurrentPendingIds() {
  const [pos, bills] = await Promise.all([
    getPendingPOs(false),
    getPendingBills(false),
  ]);

  // Real fix: PMO approval-matching genuinely requires checking
  // approvers_list on each record's FULL detail (confirmed directly from
  // pmos.js's own logic - isJatinCurrentApprover) - there's no reliable
  // list-level filter for this, which is exactly why the simple
  // filter_by attempt came back empty. Rather than duplicate that
  // non-trivial logic separately here (risking it drift out of sync with
  // the real dashboard), this calls the already-deployed, already-tested
  // /api/pmos endpoint directly instead - guaranteeing byte-for-byte the
  // same PMOs the dashboard itself shows Jatin.
  let pmos = [];
  let pmoError = null;
  try {
    const siteUrl = process.env.SITE_URL || 'https://finance-dashboard-liard-three.vercel.app';
    const pmoRes = await axios.get(`${siteUrl}/api/pmos`);
    pmos = (pmoRes.data.data || []).map(p => p.id);
  } catch (e) {
    pmoError = e.response?.data ? JSON.stringify(e.response.data) : e.message;
  }

  return {
    pos: (pos || []).map(p => p.purchaseorder_id),
    bills: (bills || []).map(b => b.bill_id),
    pmos, pmoError,
  };
}

async function sendWhatsApp(text) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_WHATSAPP_FROM;
  const to         = process.env.JATIN_WHATSAPP_TO;
  if (!accountSid || !authToken || !from || !to) {
    console.log('WhatsApp not sent - missing Twilio env vars');
    return;
  }
  const params = new URLSearchParams({ From: from, To: to, Body: text });
  await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, params, {
    auth: { username: accountSid, password: authToken },
  });
}

export default async function handler(req, res) {
  if (req.query.key !== 'check123') {
    return res.status(403).json({ error: 'Add ?key=check123 to the URL' });
  }

  try {
    const rawCurrent = await getCurrentPendingIds();
    const { pmoError, ...current } = rawCurrent; // keep the diagnostic separate from what actually gets persisted
    const stored = await storeGet(KNOWN_IDS_KEY).catch(() => null);
    const known = (stored && stored.version === KNOWN_IDS_VERSION) ? stored.data : null;

    // Real fix for the cold-start bug: if this is genuinely the FIRST
    // time this has ever run (no baseline exists at all), OR the stored
    // baseline is from the old, wrongly-scoped version, there is no
    // valid "new" to report - everything currently pending was simply
    // already there before we started watching correctly. Silently
    // establish the baseline and send nothing this one time only.
    if (known === null) {
      await storeSet(KNOWN_IDS_KEY, { version: KNOWN_IDS_VERSION, data: current });
      return res.status(200).json({
        sent: false, reason: 'Baseline established (fresh or re-scoped) - no notification sent',
        baselineCounts: { pos: current.pos.length, bills: current.bills.length, pmos: current.pmos.length },
        pmoError: pmoError || undefined,
      });
    }

    const result = detectNewItems(current, known);
    await storeSet(KNOWN_IDS_KEY, { version: KNOWN_IDS_VERSION, data: result.updatedKnown });

    if (result.totalNew === 0) {
      return res.status(200).json({ sent: false, reason: 'No new items since last check', ...result, pmoError: pmoError || undefined });
    }

    const messageText = buildMessageText(result);
    await sendWhatsApp(messageText).catch(e => console.log('WhatsApp send failed:', e.message));

    return res.status(200).json({ sent: true, message: messageText, ...result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
