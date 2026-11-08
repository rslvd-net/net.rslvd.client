const pool = require('../db/pool');

// Site-owner activity is excluded from the log by default (set
// ACTIVITY_LOG_SITE_OWNER=true to include it). Owner ids are cached briefly
// to avoid a lookup on every logged event.
let siteOwnerIds = null;
let siteOwnerCacheAt = 0;
const SITE_OWNER_CACHE_MS = 60_000;

async function isSiteOwner(userId) {
  if (!userId) return false;
  const now = Date.now();
  if (!siteOwnerIds || now - siteOwnerCacheAt > SITE_OWNER_CACHE_MS) {
    const r = await pool.query('SELECT id FROM users WHERE is_site_owner = TRUE');
    siteOwnerIds = new Set(r.rows.map((row) => row.id));
    siteOwnerCacheAt = now;
  }
  return siteOwnerIds.has(userId);
}

async function log(event, { userId = null, detail = null, req = null } = {}) {
  try {
    if (process.env.ACTIVITY_LOG_SITE_OWNER !== 'true' && (await isSiteOwner(userId))) return;
  } catch (e) {
    console.error('activity owner check error:', e.message);
  }
  try {
    // req.ip is resolved against the trusted proxy hop (server.js), so the
    // recorded address is the real client and not a header the client chose.
    const ip = req ? String(req.ip || '').replace(/^::ffff:/, '') || null : null;
    const ua = req ? (req.headers['user-agent'] || null) : null;
    await pool.query(
      `INSERT INTO activity_logs (user_id, event, detail, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId || null, event, detail || null, ip, ua]
    );
  } catch (e) {
    // Never crash the request over a log failure
    console.error('activity log error:', e.message);
  }
  pushToNtfy(event, detail).catch((e) => console.error('activity ntfy error:', e.message));
}

// Mirror activity events to the admin's ntfy feed at default priority.
// Push-only: no email fallback, so routine site activity never spams the inbox.
async function pushToNtfy(event, detail) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
  const headers = { Title: `rslvd activity: ${event}`, Priority: 'default', Tags: 'page_facing_up' };
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
  await fetch(`${server}/${topic}`, { method: 'POST', headers, body: detail || event });
}

module.exports = { log };
