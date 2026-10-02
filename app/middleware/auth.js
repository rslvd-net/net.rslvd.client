const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = (header && header.startsWith('Bearer ')) ? header.slice(7) : req.query.token;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    if (!result.rows[0]) return res.status(401).json({ error: 'User not found' });
    const user = result.rows[0];

    if (user.subscription_status === 'cancelling' && user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
      await pool.query(
        `UPDATE users SET subscription_status = 'inactive', plan = 'free',
         max_hosts = 2, max_tunnels = 2, subscription_id = NULL, plan_expires_at = NULL, updated_at = NOW()
         WHERE id = $1`,
        [user.id]
      );
      user.subscription_status = 'inactive';
      user.plan = 'free';
      user.max_hosts = 2;
      user.max_tunnels = 2;
      user.subscription_id = null;
      user.plan_expires_at = null;
    }

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
