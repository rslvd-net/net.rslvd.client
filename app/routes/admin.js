const router = require('express').Router();
const { spawn } = require('child_process');
const pool = require('../db/pool');
const { requireAdmin, requireSiteOwner } = require('../middleware/auth');

// All admin routes require at least admin role (site_owner also passes)
router.use(requireAdmin);

// ── Live System Logs Stream ───────────────────────────────────────────────────
router.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const lines = parseInt(req.query.lines) || 100;
  const proc = spawn('journalctl', ['-u', 'rslvd', '-n', String(lines), '-f', '--no-pager']);

  proc.stdout.on('data', (chunk) => {
    const logLines = chunk.toString('utf8').split('\n');
    for (const line of logLines) {
      if (line.trim()) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const errLines = chunk.toString('utf8').split('\n');
    for (const line of errLines) {
      if (line.trim()) {
        res.write(`data: ${JSON.stringify('[STDERR] ' + line)}\n\n`);
      }
    }
  });

  proc.on('error', (err) => {
    res.write(`data: ${JSON.stringify('[ERROR] ' + err.message)}\n\n`);
  });

  req.on('close', () => {
    try { proc.kill('SIGTERM'); } catch (_) {}
  });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [users, hosts, tunnels, active, byPlan, recentUsers] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM hosts'),
      pool.query('SELECT COUNT(*) FROM tunnels WHERE active = TRUE'),
      pool.query("SELECT COUNT(*) FROM users WHERE subscription_status = 'active'"),
      pool.query("SELECT plan, COUNT(*) FROM users GROUP BY plan ORDER BY COUNT(*) DESC"),
      pool.query("SELECT id, email, plan, subscription_status, created_at FROM users ORDER BY created_at DESC LIMIT 5"),
    ]);
    res.json({
      totalUsers: parseInt(users.rows[0].count),
      totalHosts: parseInt(hosts.rows[0].count),
      totalTunnels: parseInt(tunnels.rows[0].count),
      activeSubscribers: parseInt(active.rows[0].count),
      byPlan: byPlan.rows,
      recentUsers: recentUsers.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, plan, subscription_status, max_hosts, max_tunnels,
              is_admin, is_site_owner, plan_expires_at, created_at
       FROM users ORDER BY created_at DESC LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const [user, hosts, tunnels] = await Promise.all([
      pool.query('SELECT id, email, plan, subscription_status, max_hosts, max_tunnels, is_admin, is_site_owner, plan_expires_at, created_at FROM users WHERE id = $1', [req.params.id]),
      pool.query('SELECT id, fqdn, ip_address, last_updated, active FROM hosts WHERE user_id = $1', [req.params.id]),
      pool.query('SELECT id, name, fqdn, tunnel_port, status, active, created_at FROM tunnels WHERE user_id = $1', [req.params.id]),
    ]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ ...user.rows[0], hosts: hosts.rows, tunnels: tunnels.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const isSiteOwner = req.user.is_site_owner;
    const { plan, maxHosts, maxTunnels, subscriptionStatus, isAdmin, isSiteOwnerFlag } = req.body;
    const fields = [];
    const vals = [];
    let i = 1;
    if (plan !== undefined) { fields.push(`plan = $${i++}`); vals.push(plan); }
    if (maxHosts !== undefined) { fields.push(`max_hosts = $${i++}`); vals.push(maxHosts); }
    if (maxTunnels !== undefined) { fields.push(`max_tunnels = $${i++}`); vals.push(maxTunnels); }
    if (subscriptionStatus !== undefined) { fields.push(`subscription_status = $${i++}`); vals.push(subscriptionStatus); }
    // Only site_owner can grant/revoke admin or site_owner
    if (isAdmin !== undefined && isSiteOwner) { fields.push(`is_admin = $${i++}`); vals.push(isAdmin); }
    if (isSiteOwnerFlag !== undefined && isSiteOwner) { fields.push(`is_site_owner = $${i++}`); vals.push(isSiteOwnerFlag); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    await pool.query(`UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i}`, vals);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
  }
});

router.delete('/users/:id', requireSiteOwner, async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ── Hosts ─────────────────────────────────────────────────────────────────────
router.get('/hosts', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT h.id, h.fqdn, h.ip_address, h.last_updated, h.active, h.created_at, u.email
       FROM hosts h JOIN users u ON h.user_id = u.id
       ORDER BY h.created_at DESC LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch hosts' });
  }
});

// ── Tunnels ───────────────────────────────────────────────────────────────────
router.get('/tunnels', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.name, t.fqdn, t.tunnel_port, t.target_port, t.status, t.active, t.created_at, u.email
       FROM tunnels t JOIN users u ON t.user_id = u.id
       ORDER BY t.created_at DESC LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tunnels' });
  }
});

// ── Activity Log ──────────────────────────────────────────────────────────────
router.get('/activity', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const event = req.query.event || null;
    const result = await pool.query(
      `SELECT a.id, a.event, a.detail, a.ip_address, a.user_agent, a.created_at, u.email
       FROM activity_logs a LEFT JOIN users u ON a.user_id = u.id
       ${event ? 'WHERE a.event = $2' : ''}
       ORDER BY a.created_at DESC LIMIT $1`,
      event ? [limit, event] : [limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// ── Reserved Subdomains (site_owner only) ─────────────────────────────────────
router.get('/reserved', requireSiteOwner, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.subdomain, r.reason, r.created_at, u.email AS created_by_email
       FROM reserved_subdomains r LEFT JOIN users u ON r.created_by = u.id
       ORDER BY r.subdomain ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reserved subdomains' });
  }
});

router.post('/reserved', requireSiteOwner, async (req, res) => {
  try {
    const { subdomain, reason } = req.body;
    if (!subdomain) return res.status(400).json({ error: 'subdomain required' });
    const clean = subdomain.toLowerCase().trim();
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(clean)) {
      return res.status(400).json({ error: 'Invalid subdomain format' });
    }
    const result = await pool.query(
      `INSERT INTO reserved_subdomains (subdomain, reason, created_by)
       VALUES ($1, $2, $3) RETURNING id, subdomain, reason, created_at`,
      [clean, reason || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already reserved' });
    res.status(500).json({ error: 'Failed to reserve subdomain' });
  }
});

router.delete('/reserved/:id', requireSiteOwner, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM reserved_subdomains WHERE id = $1 RETURNING subdomain', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, removed: result.rows[0].subdomain });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove reserved subdomain' });
  }
});

router.patch('/reserved/:id', requireSiteOwner, async (req, res) => {
  try {
    const { reason } = req.body;
    await pool.query('UPDATE reserved_subdomains SET reason = $1 WHERE id = $2', [reason, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

// ── Server config (site_owner only) ──────────────────────────────────────────
router.get('/config', requireSiteOwner, async (req, res) => {
  res.json({
    base_domain: process.env.BASE_DOMAIN,
    app_url: process.env.APP_URL,
    server_ip: process.env.SERVER_IP || '129.146.61.187',
    node_env: process.env.NODE_ENV,
    square_configured: !!process.env.SQUARE_ACCESS_TOKEN,
    ionos_configured: !!process.env.IONOS_API_KEY,
  });
});

// ── Backup / Restore (site_owner only) ───────────────────────────────────────
router.get('/backup', requireSiteOwner, async (req, res) => {
  try {
    const [users, hosts, tunnels, reserved, activity] = await Promise.all([
      pool.query(`SELECT id, email, password_hash, square_customer_id, square_card_id, subscription_id,
                         subscription_status, plan, plan_expires_at, max_hosts, max_tunnels,
                         is_admin, is_site_owner, display_name, totp_secret, totp_enabled,
                         created_at, updated_at FROM users ORDER BY created_at`),
      pool.query(`SELECT id, user_id, hostname, parent_host_id, fqdn, ip_address, ipv6_address,
                         ionos_record_id_v4, ionos_record_id_v6, last_updated, update_key, active,
                         force_https, created_at FROM hosts ORDER BY created_at`),
      pool.query(`SELECT id, user_id, name, tunnel_port, target_host, target_port, protocol,
                         wg_public_key, wg_preshared_key, wg_client_ip, wg_server_port, status,
                         fqdn, ionos_record_id, token, active, force_https, parent_tunnel_id,
                         created_at FROM tunnels ORDER BY created_at`),
      pool.query(`SELECT id, subdomain, reason, created_by, created_at FROM reserved_subdomains ORDER BY subdomain`),
      pool.query(`SELECT id, user_id, event, detail, ip_address, user_agent, created_at
                  FROM activity_logs ORDER BY created_at DESC LIMIT 10000`),
    ]);
    const backup = {
      version: 1,
      created_at: new Date().toISOString(),
      data: {
        users: users.rows,
        hosts: hosts.rows,
        tunnels: tunnels.rows,
        reserved_subdomains: reserved.rows,
        activity_logs: activity.rows,
      },
    };
    res.setHeader('Content-Disposition', `attachment; filename="rslvd-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: 'Failed to create backup' });
  }
});

router.post('/restore', requireSiteOwner, async (req, res) => {
  const client = await pool.connect();
  try {
    const { data } = req.body;
    if (!data || !data.users || !data.hosts || !data.tunnels) {
      return res.status(400).json({ error: 'Invalid backup format' });
    }

    await client.query('BEGIN');

    // Track results
    const results = { users: 0, hosts: 0, tunnels: 0, reserved: 0, skipped: 0 };

    // Restore users (upsert by email)
    for (const u of data.users) {
      const exists = await client.query('SELECT id FROM users WHERE email = $1', [u.email]);
      if (exists.rows.length === 0) {
        await client.query(
          `INSERT INTO users (id, email, password_hash, square_customer_id, square_card_id, subscription_id,
                              subscription_status, plan, plan_expires_at, max_hosts, max_tunnels,
                              is_admin, is_site_owner, display_name, totp_secret, totp_enabled,
                              created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           ON CONFLICT (id) DO NOTHING`,
          [u.id, u.email, u.password_hash, u.square_customer_id, u.square_card_id, u.subscription_id,
           u.subscription_status, u.plan, u.plan_expires_at, u.max_hosts, u.max_tunnels,
           u.is_admin, u.is_site_owner, u.display_name, u.totp_secret, u.totp_enabled || false,
           u.created_at, u.updated_at]
        );
        results.users++;
      } else {
        results.skipped++;
      }
    }

    // Restore hosts
    for (const h of data.hosts) {
      const hRes = await client.query(
        `INSERT INTO hosts (id, user_id, hostname, parent_host_id, fqdn, ip_address, ipv6_address,
                            ionos_record_id_v4, ionos_record_id_v6, last_updated, update_key, active,
                            force_https, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [h.id, h.user_id, h.hostname, h.parent_host_id, h.fqdn, h.ip_address, h.ipv6_address,
         h.ionos_record_id_v4, h.ionos_record_id_v6, h.last_updated, h.update_key, h.active,
         h.force_https !== false, h.created_at]
      );
      if (hRes.rows.length > 0) results.hosts++;
      else results.skipped++;
    }

    // Restore tunnels
    for (const t of data.tunnels) {
      const tRes = await client.query(
        `INSERT INTO tunnels (id, user_id, name, tunnel_port, target_host, target_port, protocol,
                              wg_public_key, wg_preshared_key, wg_client_ip, wg_server_port, status,
                              fqdn, ionos_record_id, token, active, force_https, parent_tunnel_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [t.id, t.user_id, t.name, t.tunnel_port, t.target_host, t.target_port, t.protocol,
         t.wg_public_key, t.wg_preshared_key, t.wg_client_ip, t.wg_server_port, t.status,
         t.fqdn, t.ionos_record_id, t.token, t.active, t.force_https !== false,
         t.parent_tunnel_id, t.created_at]
      );
      if (tRes.rows.length > 0) results.tunnels++;
      else results.skipped++;
    }

    // Restore reserved subdomains
    if (data.reserved_subdomains) {
      for (const r of data.reserved_subdomains) {
        const rRes = await client.query(
          `INSERT INTO reserved_subdomains (subdomain, reason, created_by, created_at)
           VALUES ($1, $2, $3, $4) ON CONFLICT (subdomain) DO NOTHING RETURNING subdomain`,
          [r.subdomain, r.reason, r.created_by, r.created_at]
        );
        if (rRes.rows.length > 0) results.reserved++;
        else results.skipped++;
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, results });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Restore error:', err);
    res.status(500).json({ error: 'Restore failed: ' + err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
