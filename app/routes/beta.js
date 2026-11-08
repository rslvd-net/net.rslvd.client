const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { notifyAdmin } = require('../lib/notify');
const settings = require('../lib/settings');

// Closed beta signup for the Android app Play Store submission. The cap is an
// admin-panel setting (beta_max_testers) so it can be raised without a deploy.
const maxTesters = () => settings.get('beta_max_testers');

const limiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  validate: { xForwardedForHeader: false, ip: false, trustProxy: false, default: false },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/status', async (req, res) => {
  try {
    const max = maxTesters();
    const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM beta_testers');
    res.json({ max, taken: count, remaining: Math.max(0, max - count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/signup', limiter, async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const name = (req.body.name || '').trim().slice(0, 100);
    if (!EMAIL_RE.test(email) || email.length > 200) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }

    const max = maxTesters();
    const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM beta_testers');
    if (count >= max) {
      return res.status(409).json({ error: 'All beta spots are taken — thanks for your interest!' });
    }

    const { rows: [row] } = await pool.query(
      `INSERT INTO beta_testers (email, name) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING RETURNING *`,
      [email, name || null]
    );
    if (!row) return res.status(409).json({ error: 'This email is already signed up' });

    notifyAdmin(
      `Beta tester #${count + 1}/${max}: ${email}`,
      `${name || 'No name given'} signed up for the Android app beta.`
    ).catch(e => console.error('[beta] notify failed:', e.message));

    res.status(201).json({ success: true, spot: count + 1, max });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
