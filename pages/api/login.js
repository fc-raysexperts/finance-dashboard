// pages/api/login.js
// Checks hardcoded credentials (Jatin / 2025) and sets the cookie that
// middleware.js looks for. Simple by design — internal tool, not a
// public-facing product.

const VALID_USER = 'Jatin';
const VALID_PASS = '2025';
const COOKIE_NAME  = 'fd_auth';
const COOKIE_VALUE = 'jatin_2025_ok';

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, password } = req.body;

  if (userId === VALID_USER && password === VALID_PASS) {
    res.setHeader('Set-Cookie', [
      `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
    ]);
    return res.status(200).json({ success: true });
  }

  return res.status(401).json({ success: false, error: 'Invalid User-ID or Password' });
}
