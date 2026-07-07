// pages/api/send-notifications.js
//
// Called on a schedule (GitHub Actions, Mon-Sat 10am-6pm IST hourly) -
// checks for genuinely new pending POs/Bills/PMOs since the last run and
// notifies Jatin via WhatsApp + Email if anything new has come up.
//
// WHATSAPP: no special "reply" API trick needed or used - WhatsApp
// already keeps every message between the same two phone numbers in ONE
// continuous chat by default, so sequential messages already satisfy
// "one chat only" without needing an unconfirmed Twilio capability.
//
// EMAIL: genuinely needs real threading (Gmail doesn't auto-group
// unrelated emails) - uses nodemailer's dedicated inReplyTo/references
// properties. A fresh thread starts each new calendar day (IST); every
// notification within the same day replies to that day's first email.

const axios = require('axios');
const nodemailer = require('nodemailer');
const { storeGet, storeSet } = require('../../lib/store');
const { detectNewItems, buildMessageText } = require('../../lib/notifications');
const { getAccessToken } = require('../../lib/zohoToken');

const KNOWN_IDS_KEY = 'notification_known_ids';
const EMAIL_THREAD_KEY = 'notification_email_thread';

async function zohoGET(path, params = {}) {
  const token = await getAccessToken();
  const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: process.env.ZOHO_ORG_ID, ...params },
  });
  return res.data;
}

// Fetches ALL company-wide pending POs/Bills (not just Jatin's own),
// since we specifically want to catch anything new regardless of who
// it's currently awaiting approval from, matching "any new PBP that's
// come up" as stated. PMOs use the existing custom-module pending list.
async function getCurrentPendingIds() {
  const [poData, billData] = await Promise.all([
    zohoGET('/purchaseorders', { filter_by: 'Status.PendingApproval', per_page: 200 }),
    zohoGET('/bills', { filter_by: 'Status.PendingApproval', per_page: 200 }),
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

async function sendEmail(text, subject) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const to   = process.env.JATIN_EMAIL_TO;
  if (!user || !pass || !to) {
    console.log('Email not sent - missing Gmail env vars');
    return null;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });

  // Real threading: a fresh thread starts each new day (IST); every
  // notification within the same day replies to that day's first email,
  // using nodemailer's dedicated inReplyTo/references properties.
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
  let thread = await storeGet(EMAIL_THREAD_KEY).catch(() => null);
  const isNewDay = !thread || thread.day !== todayIST;

  const mailOptions = {
    from: user,
    to,
    subject: isNewDay ? `Finance Dashboard - Daily Update (${todayIST})` : thread.subject,
    text,
  };
  if (!isNewDay && thread.messageId) {
    mailOptions.inReplyTo = thread.messageId;
    mailOptions.references = thread.messageId;
  }

  const info = await transporter.sendMail(mailOptions);

  if (isNewDay) {
    // This is the FIRST email of a new day - store its Message-ID as the
    // thread root that every later notification today will reply to.
    await storeSet(EMAIL_THREAD_KEY, { day: todayIST, messageId: info.messageId, subject: mailOptions.subject });
  }
  return info;
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
    await Promise.all([
      sendWhatsApp(messageText).catch(e => console.log('WhatsApp send failed:', e.message)),
      sendEmail(messageText).catch(e => console.log('Email send failed:', e.message)),
    ]);

    return res.status(200).json({ sent: true, message: messageText, ...result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
