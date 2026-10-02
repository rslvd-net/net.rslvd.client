const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

const BASE_QUERY = `
  SELECT id, host_id, tunnel_id, fqdn, record_type, change, old_value, new_value, source, ip_address, created_at
  FROM dns_changes WHERE user_id = $1`;

function buildFilters(req) {
  const params = [req.user.id];
  let where = '';
  if (req.query.host_id) {
    params.push(req.query.host_id);
    where += ` AND host_id = $${params.length}`;
  }
  if (req.query.tunnel_id) {
    params.push(req.query.tunnel_id);
    where += ` AND tunnel_id = $${params.length}`;
  }
  if (req.query.fqdn) {
    params.push(req.query.fqdn);
    where += ` AND fqdn = $${params.length}`;
  }
  return { params, where };
}

// List DNS change history (newest first)
router.get('/', async (req, res) => {
  try {
    const { params, where } = buildFilters(req);
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    params.push(limit);
    const result = await pool.query(
      `${BASE_QUERY}${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load DNS history' });
  }
});

// CSV export of the full history
router.get('/export', async (req, res) => {
  try {
    const { params, where } = buildFilters(req);
    const result = await pool.query(`${BASE_QUERY}${where} ORDER BY created_at DESC LIMIT 10000`, params);
    const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
    const header = 'timestamp,fqdn,record_type,change,old_value,new_value,source,client_ip';
    const lines = result.rows.map((r) =>
      [r.created_at.toISOString(), r.fqdn, r.record_type, r.change, r.old_value, r.new_value, r.source, r.ip_address].map(esc).join(',')
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="rslvd-dns-changes-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send([header, ...lines].join('\n'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to export DNS history' });
  }
});

module.exports = router;
