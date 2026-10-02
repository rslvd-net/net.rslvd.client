const router = require('express').Router();
const pool = require('../db/pool');
const ionos = require('../lib/ionos');
const dnsAudit = require('../lib/dns-audit');
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  validate: { xForwardedForHeader: false, ip: false, trustProxy: false, default: false },
  keyGenerator: (req) => req.query.key || req.ip,
  message: 'Too many update requests',
});

router.use(limiter);

// DynDNS-compatible update endpoint
// GET /api/update?key=<update_key>&ip=<ipv4>&ipv6=<ipv6>
// Also supports: /api/update?hostname=<fqdn>&myip=<ip>&key=<key>
router.get('/', async (req, res) => {
  try {
    const key = req.query.key;
    const ipv4 = req.query.ip || req.query.myip || getClientIP(req);
    const ipv6 = req.query.ipv6 || null;

    if (!key) return res.status(400).send('badauth');

    const result = await pool.query(
      `SELECT h.*, u.subscription_status, u.plan_expires_at
       FROM hosts h JOIN users u ON h.user_id = u.id
       WHERE h.update_key = $1 AND h.active = TRUE`,
      [key]
    );

    const host = result.rows[0];
    if (!host) return res.status(401).send('badauth');

    // Check subscription
    if (host.subscription_status !== 'active' && host.subscription_status !== 'cancelling' && host.subscription_status !== 'free' && host.subscription_status !== 'inactive') return res.status(403).send('notdonator');
    if (host.subscription_status !== 'free' && host.subscription_status !== 'inactive' && host.plan_expires_at && new Date(host.plan_expires_at) < new Date()) {
      return res.status(403).send('notdonator');
    }

    // Validate IPs
    if (ipv4 && !isValidIPv4(ipv4)) return res.status(400).send('dnserr');

    let changed = false;
    let v4RecordId = host.ionos_record_id_v4;
    let v6RecordId = host.ionos_record_id_v6;

    if (ipv4) {
      const r = await ionos.upsertRecord(host.fqdn, 'A', ipv4);
      if (r.action !== 'unchanged') {
        changed = true;
        dnsAudit.record({ userId: host.user_id, hostId: host.id, fqdn: host.fqdn, recordType: 'A', change: r.action === 'created' ? 'record_created' : 'ip_updated', oldValue: host.ip_address, newValue: ipv4, source: 'ddns_api', req });
      }
      if (r.action === 'created') v4RecordId = r.recordId;
    }

    if (ipv6 && isValidIPv6(ipv6)) {
      const r = await ionos.upsertRecord(host.fqdn, 'AAAA', ipv6);
      if (r.action !== 'unchanged') {
        changed = true;
        dnsAudit.record({ userId: host.user_id, hostId: host.id, fqdn: host.fqdn, recordType: 'AAAA', change: r.action === 'created' ? 'record_created' : 'ip_updated', oldValue: host.ipv6_address, newValue: ipv6, source: 'ddns_api', req });
      }
      if (r.action === 'created') v6RecordId = r.recordId;
    }

    await pool.query(
      `UPDATE hosts SET ip_address = $1, ipv6_address = $2, last_updated = NOW(),
       ionos_record_id_v4 = $3, ionos_record_id_v6 = $4 WHERE id = $5`,
      [ipv4 || host.ip_address, ipv6 || host.ipv6_address, v4RecordId, v6RecordId, host.id]
    );

    await pool.query(
      'INSERT INTO update_logs (host_id, ip_address, user_agent) VALUES ($1, $2, $3)',
      [host.id, ipv4, req.headers['user-agent'] || '']
    );

    res.send(changed ? `good ${ipv4}` : `nochg ${ipv4}`);
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).send('dnserr');
  }
});

// Also handle POST for some clients
router.post('/', async (req, res) => {
  req.query = { ...req.query, ...req.body };
  return router.handle(req, res);
});

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

function isValidIPv4(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(n => parseInt(n) <= 255);
}

function isValidIPv6(ip) {
  return /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/.test(ip);
}

module.exports = router;
