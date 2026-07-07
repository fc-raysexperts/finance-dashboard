// pages/api/send-notifications.js
//
// Called on a schedule (GitHub Actions, Mon-Sat 10am-6pm IST hourly) -
// checks for genuinely new pending POs/Bills/PMOs since the last run and
// notifies Jatin via WhatsApp if anything new has come up.
//
// Email notifications were deliberately dropped: Zoho itself already
// sends Jatin an email whenever a new PO/Bill/PMO needs his approval, and
// the org's Google Workspace policy blocks the App Password + personal-
// Gmail workarounds needed to send email from this app. No nodemailer
// dependency here at all - that's what was missing from package.json and
// broke the build.
//
// WHATSAPP: no special "reply" API trick needed or used - WhatsApp
// already keeps every message between the same two phone numbers in ONE
// continuous chat by default, so sequential messages already satisfy
// "one chat only" without needing an unconfirmed Twilio capability.

const axios = require('axios');
const { storeGet, storeSet } = require('../../lib/store');
const { detectNewItems, buildMessageText } = require('../../lib/notifications');
const { getAccessToken } = require('../../lib/zohoToken');

const KNOWN_IDS_KEY = 'notification_known_ids';

async function zohoGET(path, params = {}) {
  const token = await getAccessToken();
  try {
    const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID, ...params },
    });
    return res.data;
  } catch (e) {
    // Real fix: surface Zoho's actual error message, not just the bare
    // status code - this is what let us finally pin down the wrong
    // filter parameter below instead of guessing again.
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    throw new Error(`Zoho ${path} failed: ${e.response?.status || ''} - ${detail}`);
  }
}

// Fetches ALL company-wide pending POs/Bills (not just Jatin's own),
// since we specifically want to catch anything new regardless of who
// it's currently awaiting approval from, matching "any new PBP that's
// come up" as stated. PMOs use the existing custom-module pending list.
async function getCurrentPendingIds() {
  const [poData, billData] = await Promise.all([
    zohoGET('/purchaseorders', { status: 'pending_approval', per_page: 200 }),
    zohoGET('/bills', { status: 'pending_approval', per_page: 200 }),
  ]);
  const pos   = (poData.purchaseorders || []).map(p => p.purchaseorder_id);
  const bills = (billData.bills || []).map(b => b.bill_id);

  let pmos = [];
  try {
    const pmoData = await zohoGET('/cm_payment_memos', { filter_by: 'Status.MyApprovals', per_page: 200 });
    pmos = (pmoData.cm_payment_memos || []).map(p => p.module_record_id || p.id);
  } catch { /* PMO module path may differ - non-fatal, POs/Bills still work */ }

  return { pos, bills, pmos };
}

async function sendWhatsApp(text) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_WHATSAPP_FROM; // e.g. 'whatsapp:+14155238886'
  const to         = process.env.JATIN_WHATSAPP_TO;    // e.g. 'whatsapp:+91XXXXXXXXXX'
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
    const current = await getCurrentPendingIds();
    const known = await storeGet(KNOWN_IDS_KEY).catch(() => null) || { pos: [], bills: [], pmos: [] };
    const result = detectNewItems(current, known);

    // Always persist the current full snapshot, whether or not anything
    // was new, so next hour's comparison is always against the right
    // baseline.
    await storeSet(KNOWN_IDS_KEY, result.updatedKnown);

    if (result.totalNew === 0) {
      return res.status(200).json({ sent: false, reason: 'No new items since last check', ...result });
    }

    const messageText = buildMessageText(result);
    await sendWhatsApp(messageText).catch(e => console.log('WhatsApp send failed:', e.message));

    return res.status(200).json({ sent: true, message: messageText, ...result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
