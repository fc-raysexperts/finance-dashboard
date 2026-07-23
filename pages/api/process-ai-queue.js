// pages/api/process-ai-queue.js
//
// Pre-warms the AI compliance cache — called by the hourly cron so that,
// most of the time, by the time anyone actually loads a tab, there's
// nothing new left to process and the tab's own (synchronous, blocking)
// AI step passes through near-instantly. Reuses the exact same batch
// processors the tabs themselves call, so behavior can never drift
// between "pre-warm via cron" and "catch up live on page load".
// Supports tab=po and tab=bill.

import { getPendingPOs, getPendingBills, getCachedPODetail } from '../../lib/zoho';
import { processAIQueueForPOs, processAIQueueForBills, processAIQueueForPMOs } from '../../lib/aiComplianceEngine';

export default async function handler(req, res) {
  const tabType = (req.query.tab || 'po').toLowerCase();
  const forceRefresh = req.query.refresh === '1';

  try {
    if (tabType === 'po') {
      const pos = await getPendingPOs(forceRefresh);
      const result = await processAIQueueForPOs(pos, { timeBudgetMs: 260000 });
      return res.status(200).json({ success: true, ...result });
    }

    if (tabType === 'bill') {
      const bills = await getPendingBills(forceRefresh);
      // Light linked-PO context for the prompt (best-effort, mirrors bills.js)
      const linkedPOMap = {};
      for (const bill of bills) {
        try {
          const ref = (bill.purchaseorders || [])[0];
          if (ref?.purchaseorder_id) linkedPOMap[bill.bill_id] = await getCachedPODetail(ref.purchaseorder_id).catch(() => null);
        } catch { /* best-effort only */ }
      }
      const result = await processAIQueueForBills(bills, linkedPOMap, { timeBudgetMs: 260000 });
      return res.status(200).json({ success: true, ...result });
    }

    if (tabType === 'pmo') {
      // PMOs are fetched via a live call to /api/pmos itself (mirroring
      // how send-notifications.js already does this), since PMO fetching
      // logic lives entirely inside that route, not in lib/zoho.js.
      const siteUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://finance-dashboard-liard-three.vercel.app';
      const axios = require('axios');
      const pmoRes = await axios.get(`${siteUrl}/api/pmos?refresh=${forceRefresh ? '1' : '0'}`);
      // /api/pmos already runs the AI batch internally as part of
      // building its response — so simply calling it IS the pre-warm.
      return res.status(200).json({ success: true, ...(pmoRes.data.aiQueue || {}) });
    }

    return res.status(400).json({ error: `AI queue processing for tab="${tabType}" not implemented — only "po", "bill", "pmo".` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}


