// pages/api/debug-kv-sizes.js
// TEMPORARY diagnostic — lists every key currently in the KV database and
// how large each one's value actually is. Built specifically to find out
// what's hitting the 10MB Upstash request-size warning, since 5 pending
// POs + 21 pending Bills should produce a cache nowhere near that size.
//
// Visit (on your LIVE site, not locally — this needs the real KV env
// vars): https://your-site.vercel.app/api/debug-kv-sizes?key=check123
//
// DELETE THIS FILE once we've found the answer — it's a debug tool, not
// something that should stay in the deployed app long-term.

const { kv } = require('@vercel/kv');

export default async function handler(req, res) {
  if (req.query.key !== 'check123') {
    return res.status(403).json({ error: 'Add ?key=check123 to the URL' });
  }

  try {
    const keys = await kv.keys('*');
    const results = [];

    for (const key of keys) {
      try {
        const val = await kv.get(key);
        const json = JSON.stringify(val);
        const sizeBytes = json ? json.length : 0;
        results.push({
          key,
          sizeKB: (sizeBytes / 1024).toFixed(1),
          sizeMB: (sizeBytes / 1024 / 1024).toFixed(2),
          preview: json ? json.slice(0, 150) : null,
        });
      } catch (e) {
        // If even reading it fails, that itself is a huge clue —
        // report the error message directly rather than crashing.
        results.push({ key, error: e.message });
      }
    }

    results.sort((a, b) => (parseFloat(b.sizeKB) || 0) - (parseFloat(a.sizeKB) || 0));

    return res.status(200).json({
      totalKeys: keys.length,
      results,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
