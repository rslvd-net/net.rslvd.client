const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = header.slice(7);
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    if (!result.rows[0]) return res.status(401).json({ error: 'User not found' });
    const user = result.rows[0];

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (!req.user.is_admin && !req.user.is_site_owner) return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

async function requireSiteOwner(req, res, next) {
  await requireAuth(req, res, () => {
    if (!req.user.is_site_owner) return res.status(403).json({ error: 'Forbidden: site owner only' });
    next();
  });
}

module.exports = { requireAuth, requireAdmin, requireSiteOwner };
