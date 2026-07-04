// pages/api/login.js
// Checks hardcoded credentials (Jatin / 2025) and sets the cookie that
// proxy.js looks for. Simple by design — internal tool, not a public-
// facing product.
//
// SECURITY FIX: this cookie used to last 30 days (Max-Age below was
// 60*60*24*30) — meaning once logged in, the browser would never be asked
// again for a full month, regardless of reloads or new sessions. That's
// the actual reason re-login "stopped happening so often." Set to a real
// 20 minutes now: the browser itself stops sending the cookie once it
// expires, so proxy.js naturally redirects back to login with zero extra
// logic needed.

const VALID_USER = 'Jatin';
const VALID_PASS = '2025';
const COOKIE_NAME  = 'fd_auth';
const COOKIE_VALUE = 'jatin_2025_ok';
const SESSION_MAX_AGE_SECONDS = 20 * 60; // 20 minutes, as requested

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, password } = req.body;

  if (userId === VALID_USER && password === VALID_PASS) {
    res.setHeader('Set-Cookie', [
      `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`
    ]);
    return res.status(200).json({ success: true });
  }

  return res.status(401).json({ success: false, error: 'Invalid User-ID or Password' });
}
