const router = require('express').Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const ionos = require('../lib/ionos');
const activity = require('../lib/activity');
const dnsAudit = require('../lib/dns-audit');
const tunnelCert = require('../lib/tunnel-cert');
const { activeBonus } = require('../lib/plans');
const tunnelProxy = require('../lib/tunnel-proxy');

const PORT_MIN = 20000;
const PORT_MAX = 29999;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const CAN_NEST  = (user) => user.plan === 'annual' || user.is_site_owner;

// ── Public: token lookup for rslvd-tunnel client (no auth) ──────────────────
router.get('/connect/:token', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, tunnel_port, fqdn, target_port, target_host, status
       FROM tunnels WHERE token = $1 AND active = TRUE`,
      [req.params.token]
    );
    const t = result.rows[0];
    if (!t) return res.status(404).json({ error: 'Tunnel not found or invalid token' });
    res.json(t);
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

router.use(requireAuth);

// ── List tunnels ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, tunnel_port, target_host, target_port, protocol,
            status, fqdn, token, active, created_at, parent_tunnel_id, force_https,
            device_lock, bound_device_name, bound_at
     FROM tunnels WHERE user_id = $1 ORDER BY parent_tunnel_id NULLS FIRST, created_at DESC`,
    [req.user.id]
  );
  res.json(result.rows.map((t) => ({ ...t, connected: tunnelProxy.isConnected(t.fqdn) })));
});

// ── Create tunnel ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, target_port, target_host = 'localhost', protocol = 'tcp', parent_id, force_https = true } = req.body;
    if (!name || !target_port) return res.status(400).json({ error: 'name and target_port required' });

    const user = req.user;
    const BASE = process.env.BASE_DOMAIN;

    // ── Nested tunnel path ───────────────────────────────────────────────────
    if (parent_id) {
      if (!CAN_NEST(user)) {
        return res.status(403).json({ error: 'Nested subdomain tunnels require an Annual plan.' });
      }
      if (!LABEL_RE.test(name)) {
        return res.status(400).json({ error: 'Invalid label. Lowercase letters, numbers, hyphens only.' });
      }

      // Verify parent tunnel belongs to this user and is top-level
      const parentResult = await pool.query(
        'SELECT id, fqdn, name FROM tunnels WHERE id = $1 AND user_id = $2 AND active = TRUE',
        [parent_id, user.id]
      );
      const parent = parentResult.rows[0];
      if (!parent) return res.status(404).json({ error: 'Parent tunnel not found or not yours.' });

      const parentNested = await pool.query(
        'SELECT id FROM tunnels WHERE id = $1 AND parent_tunnel_id IS NOT NULL', [parent_id]
      );
      if (parentNested.rows[0]) {
        return res.status(400).json({ error: 'Cannot nest more than 1 level deep.' });
      }

      const fqdn = `${name}.${parent.fqdn}`;

      const existing = await pool.query('SELECT id FROM tunnels WHERE fqdn = $1', [fqdn]);
      if (existing.rows[0]) return res.status(409).json({ error: 'That subdomain is already taken.' });

      if (user.plan !== 'free' && user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
        return res.status(403).json({ error: 'Subscription expired' });
      }
      const countResult = await pool.query(
        'SELECT COUNT(*) FROM tunnels WHERE user_id = $1 AND active = TRUE', [user.id]
      );
      const limit = (user.max_tunnels || 1) + activeBonus(user).tunnels;
      if (parseInt(countResult.rows[0].count) >= limit) {
        return res.status(403).json({ error: `Tunnel limit reached (${limit}). Upgrade to add more.` });
      }

      const token = crypto.randomBytes(32).toString('hex');

      const wantHttps = force_https !== false;
      const result = await pool.query(
        `INSERT INTO tunnels (user_id, name, target_host, target_port, protocol,
                              status, fqdn, token, parent_tunnel_id, force_https)
         VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9)
         RETURNING id, name, target_host, target_port, protocol,
                   status, fqdn, token, active, created_at, parent_tunnel_id, force_https`,
        [user.id, name, target_host, target_port, protocol, fqdn, token, parent_id, wantHttps]
      );

      try {
        const serverIP = process.env.SERVER_IP || '129.146.61.187';
        const r = await ionos.upsertRecord(fqdn, 'A', serverIP);
        await pool.query('UPDATE tunnels SET ionos_record_id=$1, status=$2 WHERE id=$3',
          [r.recordId, 'active', result.rows[0].id]);
        result.rows[0].status = 'active';
      } catch (e) { console.error('DNS for nested tunnel failed:', e.message); }

      // Auto-provision SSL cert for nested subdomain (only when HTTPS enabled)
      if (wantHttps) {
        tunnelCert.provisionCert(fqdn);
      } else {
        tunnelCert.enableHttpFallback(fqdn);
      }

      activity.log('tunnel.create', { userId: user.id, detail: fqdn, req });
      dnsAudit.record({ userId: user.id, tunnelId: result.rows[0].id, fqdn, change: 'tunnel_created', req });
      return res.status(201).json({ ...result.rows[0], parent_fqdn: parent.fqdn });
    }

    // ── Top-level tunnel path ────────────────────────────────────────────────
    if (!LABEL_RE.test(name)) {
      return res.status(400).json({ error: 'Invalid name. Lowercase letters, numbers, hyphens only.' });
    }

    const limit = (user.max_tunnels || 1) + activeBonus(user).tunnels;
    if (user.plan !== 'free' && user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
      return res.status(403).json({ error: 'Subscription expired' });
    }
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM tunnels WHERE user_id = $1 AND active = TRUE', [user.id]
    );
    if (parseInt(countResult.rows[0].count) >= limit) {
      return res.status(403).json({ error: `Tunnel limit reached (${limit} for your plan). Upgrade to add more.` });
    }

    // Block reserved subdomains
    if (!user.is_site_owner) {
      const reserved = await pool.query('SELECT subdomain FROM reserved_subdomains WHERE subdomain = $1', [name]);
      if (reserved.rows[0]) return res.status(409).json({ error: `"${name}" is a reserved name.` });
    }

    const fqdn = `${name}.${BASE}`;
    const existing = await pool.query('SELECT id FROM tunnels WHERE fqdn = $1', [fqdn]);
    if (existing.rows[0]) return res.status(409).json({ error: 'Tunnel name already taken' });

    // Also check hosts table — can't claim a subdomain already used as a host
    const hostConflict = await pool.query('SELECT id FROM hosts WHERE fqdn = $1', [fqdn]);
    if (hostConflict.rows[0]) return res.status(409).json({ error: 'That subdomain is already used by a hostname.' });

    const token = crypto.randomBytes(32).toString('hex');

    const wantHttps = force_https !== false;
    const result = await pool.query(
      `INSERT INTO tunnels (user_id, name, target_host, target_port, protocol,
                            status, fqdn, token, force_https)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)
       RETURNING id, name, target_host, target_port, protocol,
                 status, fqdn, token, active, created_at, parent_tunnel_id, force_https`,
      [user.id, name, target_host, target_port, protocol, fqdn, token, wantHttps]
    );

    try {
      const serverIP = process.env.SERVER_IP || '129.146.61.187';
      const r = await ionos.upsertRecord(fqdn, 'A', serverIP);
      await pool.query('UPDATE tunnels SET ionos_record_id=$1, status=$2 WHERE id=$3',
        [r.recordId, 'active', result.rows[0].id]);
      result.rows[0].status = 'active';
    } catch (e) { console.error('DNS for tunnel failed:', e.message); }

    if (!wantHttps) tunnelCert.enableHttpFallback(fqdn);

    activity.log('tunnel.create', { userId: user.id, detail: fqdn, req });
    dnsAudit.record({ userId: user.id, tunnelId: result.rows[0].id, fqdn, change: 'tunnel_created', req });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create tunnel' });
  }
});

// ── Get tunnel ───────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, u.email FROM tunnels t JOIN users u ON t.user_id = u.id
       WHERE t.id = $1 AND t.user_id = $2`,
      [req.params.id, req.user.id]
    );
    const t = result.rows[0];
    if (!t) return res.status(404).json({ error: 'Tunnel not found' });
    res.json(t);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get tunnel' });
  }
});

// ── Delete tunnel ─────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tunnels WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]
    );
    const t = result.rows[0];
    if (!t) return res.status(404).json({ error: 'Tunnel not found' });

    try {
      if (t.ionos_record_id) await ionos.removeRecord(t.ionos_record_id);
    } catch (e) { console.error('DNS remove failed:', e.message); }

    // Remove SSL cert and HTTP fallback config
    tunnelCert.deprovisionCert(t.fqdn);
    tunnelCert.disableHttpFallback(t.fqdn);

    activity.log('tunnel.delete', { userId: req.user.id, detail: t.fqdn, req });
    dnsAudit.record({ userId: req.user.id, fqdn: t.fqdn, change: 'tunnel_deleted', req });
    await pool.query('DELETE FROM tunnels WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete tunnel' });
  }
});

// ── Toggle HTTPS ──────────────────────────────────────────────────────────────
router.patch('/:id/https', async (req, res) => {
  try {
    const { force_https } = req.body;
    if (typeof force_https !== 'boolean') return res.status(400).json({ error: 'force_https must be a boolean' });

    const result = await pool.query('SELECT * FROM tunnels WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const t = result.rows[0];
    if (!t) return res.status(404).json({ error: 'Tunnel not found' });

    await pool.query('UPDATE tunnels SET force_https = $1 WHERE id = $2', [force_https, t.id]);

    if (force_https) {
      if (tunnelCert.isNested(t.fqdn)) tunnelCert.provisionCert(t.fqdn);
      tunnelCert.disableHttpFallback(t.fqdn);
    } else {
      if (tunnelCert.isNested(t.fqdn)) tunnelCert.deprovisionCert(t.fqdn);
      tunnelCert.enableHttpFallback(t.fqdn);
    }

    activity.log('tunnel.https_toggle', { userId: req.user.id, detail: `${t.fqdn} \u2192 ${force_https ? 'on' : 'off'}`, req });
    dnsAudit.record({ userId: req.user.id, tunnelId: t.id, fqdn: t.fqdn, change: force_https ? 'https_enabled' : 'https_disabled', req });
    res.json({ force_https });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to toggle HTTPS' });
  }
});

// ── Toggle device lock ──────────────────────────────────────────────────
router.patch('/:id/device-lock', async (req, res) => {
  try {
    const { device_lock } = req.body;
    if (typeof device_lock !== 'boolean') return res.status(400).json({ error: 'device_lock must be a boolean' });

    const result = await pool.query('SELECT id, fqdn FROM tunnels WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const t = result.rows[0];
    if (!t) return res.status(404).json({ error: 'Tunnel not found' });

    if (device_lock) {
      await pool.query('UPDATE tunnels SET device_lock = TRUE WHERE id = $1', [t.id]);
    } else {
      await pool.query(
        'UPDATE tunnels SET device_lock = FALSE, bound_device = NULL, bound_device_name = NULL, bound_at = NULL WHERE id = $1',
        [t.id]
      );
    }

    activity.log('tunnel.device_lock', { userId: req.user.id, detail: `${t.fqdn} \u2192 ${device_lock ? 'on' : 'off'}`, req });
    res.json({ device_lock });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to toggle device lock' });
  }
});

// ── Reset device binding (keeps lock enabled; next device to connect binds) ──
router.post('/:id/reset-device', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, fqdn FROM tunnels WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const t = result.rows[0];
    if (!t) return res.status(404).json({ error: 'Tunnel not found' });

    await pool.query('UPDATE tunnels SET bound_device = NULL, bound_device_name = NULL, bound_at = NULL WHERE id = $1', [t.id]);
    activity.log('tunnel.device_reset', { userId: req.user.id, detail: t.fqdn, req });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset device binding' });
  }
});

// ── Regenerate token ──────────────────────────────────────────────────────────
router.post('/:id/regenerate-token', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id FROM tunnels WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Tunnel not found' });
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('UPDATE tunnels SET token = $1 WHERE id = $2', [token, req.params.id]);
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Failed to regenerate token' });
  }
});

// ── Helper: allocate next free port ──────────────────────────────────────────
async function allocatePort() {
  const usedPorts = await pool.query('SELECT tunnel_port FROM tunnels WHERE active = TRUE');
  const used = new Set(usedPorts.rows.map(r => r.tunnel_port));
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!used.has(p)) return p;
  }
  return null;
}

module.exports = router;
