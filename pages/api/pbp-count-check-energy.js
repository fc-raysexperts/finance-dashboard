// pages/api/pbp-count-check-energy.js
//
// Answers "how many POs/Bills has this subsidiary EVER had" (and
// specifically "since 2025-01-01") in a small, fixed number of API
// calls — deliberately NOT the same cost as the real backfill.
//
// The real backfill needs one Zoho call PER DOCUMENT (to fetch its full
// line-item detail). This endpoint only ever calls the cheap LIST
// endpoints (/purchaseorders, /bills) at the maximum page size (200),
// and simply counts how many pages exist — it never fetches a single
// document's full detail. So counting even several thousand documents
// costs only a handful of calls total (ceil(count / 200) per range), not
// one per document.
//
// Mirrors the same "check volume before committing to a full backfill"
// decision step already used for Rays, before deciding how far back to
// actually run the real backfill for Energy.
//
//   https://your-site.vercel.app/api/pbp-count-check-energy?key=check123

const axios = require('axios');
const { getAccessToken } = require('../../lib/zohoToken');
const { getOrgId } = require('../../lib/subsidiaries');

const ORG_KEY = 'energy';

async function zohoGET(path, params = {}) {
  let token = await getAccessToken();
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get(`https://www.zohoapis.in/books/v3${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: getOrgId(ORG_KEY), ...params },
      });
      return res.data;
    } catch (err) {
      if (err.response?.status === 401 && attempt < 2) {
        token = await getAccessToken({ forceRefresh: true });
        continue;
      }
      if (err.response?.status === 429 && attempt < 2) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}

// Counts real documents in a date range using ONLY the cheap list
// endpoint — no per-document detail calls at all. Also captures the
// single oldest and newest real document dates seen, so the response
// can show genuine first/last transaction dates, not just a raw count.
async function countInRange(endpoint, listKey, startDate, endDate, apiCallCounter) {
  let page = 1;
  let total = 0;
  let oldestDate = null;
  let newestDate = null;

  while (true) {
    const params = { per_page: 200, page };
    if (startDate) params.date_start = startDate;
    if (endDate) params.date_end = endDate;
    const data = await zohoGET(endpoint, params);
    apiCallCounter.count++;

    const records = data[listKey] || [];
    total += records.length;
    for (const rec of records) {
      const d = rec.date;
      if (d && (!oldestDate || d < oldestDate)) oldestDate = d;
      if (d && (!newestDate || d > newestDate)) newestDate = d;
    }

    if (!data.page_context?.has_more_page) break;
    page++;
    await new Promise(r => setTimeout(r, 150));
  }

  return { total, oldestDate, newestDate, pagesChecked: page };
}

export default async function handler(req, res) {
  if (req.query.key !== 'check123') {
    return res.status(403).json({ error: 'Add ?key=check123 to the URL' });
  }

  try {
    const apiCallCounter = { count: 0 };

    // "Ever" — a very early floor date so nothing real gets excluded,
    // without assuming any specific real inception date.
    const EARLY_FLOOR = '2000-01-01';

    const [posEver, billsEver, posSince2025, billsSince2025] = await Promise.all([
      countInRange('/purchaseorders', 'purchaseorders', EARLY_FLOOR, null, apiCallCounter),
      countInRange('/bills', 'bills', EARLY_FLOOR, null, apiCallCounter),
      countInRange('/purchaseorders', 'purchaseorders', '2025-01-01', null, apiCallCounter),
      countInRange('/bills', 'bills', '2025-01-01', null, apiCallCounter),
    ]);

    return res.status(200).json({
      org: ORG_KEY,
      totalZohoAPICallsUsedForThisCheck: apiCallCounter.count,
      ever: {
        purchaseOrders: posEver.total,
        bills: billsEver.total,
        combined: posEver.total + billsEver.total,
        oldestDocumentDate: [posEver.oldestDate, billsEver.oldestDate].filter(Boolean).sort()[0] || null,
        newestDocumentDate: [posEver.newestDate, billsEver.newestDate].filter(Boolean).sort().pop() || null,
      },
      since2025_01_01: {
        purchaseOrders: posSince2025.total,
        bills: billsSince2025.total,
        combined: posSince2025.total + billsSince2025.total,
      },
      note: 'This only counted documents via the cheap list endpoint — no per-document detail was fetched, so this check cost far less than the real backfill would for the same number of documents. Use these numbers to decide how far back the actual backfill should run.',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
