const pool = require('../db/pool');

// Audit trail of DNS-affecting changes (record create/delete, IP updates,
// HTTPS toggles). Fire-and-forget: never blocks or fails the calling request.
function record({ userId = null, hostId = null, tunnelId = null, fqdn, recordType = null, change, oldValue = null, newValue = null, source = 'dashboard', req = null }) {
  const ip = req ? ((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress) : null;
  const ua = req ? (req.headers['user-agent'] || '').slice(0, 500) : null;
  pool
    .query(
      `INSERT INTO dns_changes (user_id, host_id, tunnel_id, fqdn, record_type, change, old_value, new_value, source, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [userId, hostId, tunnelId, fqdn, recordType, change, oldValue, newValue, source, ip, ua]
    )
    .catch((e) => console.error('dns audit error:', e.message));
}

module.exports = { record };
