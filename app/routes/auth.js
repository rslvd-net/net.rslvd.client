const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const validator = require('validator');
const speakeasy = require('speakeasy');
const pool = require('../db/pool');
const activity = require('../lib/activity');
const { sendMail } = require('../lib/mailer');
const { activeBonus } = require('../lib/plans');

const CURRENT_LEGAL_VERSION = '2026-05-31';

router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (!validator.isEmail(email)) return res.status(400).json({ error: 'Invalid email' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows[0]) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);

    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, plan, max_hosts, max_tunnels, subscription_status,
       email_verification_token, email_verification_expires, tos_version_accepted)
       VALUES ($1, $2, 'free', 2, 2, 'free', $3, $4, $5)
       RETURNING id, email, subscription_status, plan, max_hosts, max_tunnels, email_verified, tos_version_accepted`,
      [email.toLowerCase(), hash, verifyToken, verifyExpires, CURRENT_LEGAL_VERSION]
    );

    const user = result.rows[0];

    // Send verification email
    const verifyUrl = `${process.env.APP_URL}/verify-email?token=${verifyToken}`;
    try {
      await sendMail({
        to: user.email,
        subject: 'Verify your rslvd.privatedns.org email',
        text: `Welcome to rslvd.privatedns.org!\n\nPlease verify your email address by clicking the link below (expires in 24 hours):\n\n${verifyUrl}\n\nIf you didn't create this account, ignore this email.`,
        html: `<p>Welcome to rslvd.privatedns.org!</p><p>Please verify your email address:</p><p><a href="${verifyUrl}" style="font-size:16px;font-weight:bold">Verify my email →</a></p><p style="color:#888;font-size:13px">This link expires in 24 hours. If you didn't create this account, ignore this email.</p>`,
      });
    } catch (mailErr) {
      console.error('Verification email failed:', mailErr.message);
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

    activity.log('user.register', { userId: user.id, detail: user.email, req });
    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        plan: user.plan,
        maxHosts: user.max_hosts,
        maxTunnels: user.max_tunnels,
        status: user.subscription_status,
        role: 'user',
        emailVerified: user.email_verified || false,
        tosAccepted: user.tos_version_accepted === CURRENT_LEGAL_VERSION,
        currentLegalVersion: CURRENT_LEGAL_VERSION,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // TOTP check
    if (user.totp_enabled && user.totp_secret) {
      const { totp_code } = req.body;
      if (!totp_code) return res.status(200).json({ requireTotp: true });
      const ok = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: totp_code, window: 2 });
      if (!ok) return res.status(401).json({ error: 'Invalid authenticator code' });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    activity.log('user.login', { userId: user.id, detail: user.email, req });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        plan: user.plan,
        maxHosts: user.max_hosts,
        maxTunnels: user.max_tunnels,
        status: user.subscription_status,
        isAdmin: user.is_admin,
        isSiteOwner: user.is_site_owner,
        totpEnabled: user.totp_enabled,
        role: user.is_site_owner ? 'site_owner' : user.is_admin ? 'admin' : 'user',
        emailVerified: user.email_verified || false,
        tosAccepted: user.tos_version_accepted === CURRENT_LEGAL_VERSION,
        currentLegalVersion: CURRENT_LEGAL_VERSION,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const bonus = activeBonus(u);
    res.json({
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      plan: u.plan,
      maxHosts: (u.max_hosts || 0) + bonus.hosts,
      maxTunnels: (u.max_tunnels || 0) + bonus.tunnels,
      bonusHosts: bonus.hosts,
      bonusTunnels: bonus.tunnels,
      bonusExpiresAt: bonus.expiresAt,
      supporter: (u.donated_total_cents || 0) > 0,
      status: u.subscription_status,
      planExpiresAt: u.plan_expires_at,
      isAdmin: u.is_admin,
      isSiteOwner: u.is_site_owner,
      totpEnabled: u.totp_enabled || false,
      role: u.is_site_owner ? 'site_owner' : u.is_admin ? 'admin' : 'user',
      emailVerified: u.email_verified || false,
      tosAccepted: u.tos_version_accepted === CURRENT_LEGAL_VERSION,
      currentLegalVersion: CURRENT_LEGAL_VERSION,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ── Update profile (display name) ──────────────────────────────────────────────
router.patch('/profile', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const { displayName } = req.body;
    const clean = (displayName || '').trim().slice(0, 100);
    await pool.query('UPDATE users SET display_name = $1, updated_at = NOW() WHERE id = $2', [clean || null, req.user.id]);
    activity.log('user.profile_update', { userId: req.user.id, detail: 'display_name', req });
    res.json({ success: true, displayName: clean || null });
  } catch (err) {
    res.status(500).json({ error: 'Profile update failed' });
  }
});

// ── 2FA: begin setup ──────────────────────────────────────────────────────────────
router.post('/2fa/setup', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({ name: `rslvd.privatedns.org (${req.user.email})`, issuer: 'rslvd.privatedns.org', length: 20 });
    await pool.query('UPDATE users SET totp_pending_secret = $1 WHERE id = $2', [secret.base32, req.user.id]);
    res.json({
      secret: secret.base32,
      otpauth_url: secret.otpauth_url,
    });
  } catch (err) {
    res.status(500).json({ error: '2FA setup failed' });
  }
});

// ── 2FA: confirm code and activate ─────────────────────────────────────────────────
router.post('/2fa/verify', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });
    const row = await pool.query('SELECT totp_pending_secret FROM users WHERE id = $1', [req.user.id]);
    const pendingSecret = row.rows[0]?.totp_pending_secret;
    if (!pendingSecret) return res.status(400).json({ error: 'No pending 2FA setup. Start setup first.' });
    const ok = speakeasy.totp.verify({ secret: pendingSecret, encoding: 'base32', token: code, window: 2 });
    if (!ok) return res.status(401).json({ error: 'Invalid code — check your authenticator app clock' });
    await pool.query(
      'UPDATE users SET totp_secret = $1, totp_enabled = TRUE, totp_pending_secret = NULL WHERE id = $2',
      [pendingSecret, req.user.id]
    );
    activity.log('user.2fa_enabled', { userId: req.user.id, req });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '2FA verification failed' });
  }
});

// ── 2FA: disable ────────────────────────────────────────────────────────────────────
router.post('/2fa/disable', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required to disable 2FA' });
    const valid = await bcrypt.compare(password, req.user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });
    await pool.query('UPDATE users SET totp_secret = NULL, totp_enabled = FALSE, totp_pending_secret = NULL WHERE id = $1', [req.user.id]);
    activity.log('user.2fa_disabled', { userId: req.user.id, req });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disable 2FA' });
  }
});

// ── My activity log ───────────────────────────────────────────────────────────────────
router.get('/activity', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, event, detail, ip_address, created_at FROM activity_logs
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

router.post('/change-password', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const valid = await bcrypt.compare(currentPassword, req.user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Password change failed' });
  }
});

// ── Forgot password ───────────────────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { rows: [user] } = await pool.query('SELECT id, email FROM users WHERE email = $1', [email.toLowerCase()]);
    // Always respond 200 to avoid email enumeration
    if (!user) return res.json({ ok: true });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
      [user.id, token, expires]
    );

    const resetUrl = `${process.env.APP_URL}/reset-password?token=${token}`;
    await sendMail({
      to: user.email,
      subject: 'Reset your rslvd.privatedns.org password',
      text: `You requested a password reset.\n\nClick the link below to set a new password (expires in 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, ignore this email.`,
      html: `<p>You requested a password reset for your rslvd.privatedns.org account.</p><p><a href="${resetUrl}" style="font-size:16px;font-weight:bold">Reset my password →</a></p><p style="color:#888;font-size:13px">This link expires in 1 hour. If you didn't request this, ignore this email.</p>`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send reset email' });
  }
});

// ── Reset password ────────────────────────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and new password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const { rows: [row] } = await pool.query(
      `SELECT * FROM password_reset_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()`,
      [token]
    );
    if (!row) return res.status(400).json({ error: 'Reset link is invalid or has expired' });

    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, row.user_id]);
    await pool.query('UPDATE password_reset_tokens SET used = TRUE WHERE id = $1', [row.id]);

    activity.log('user.password_reset', { userId: row.user_id, req });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// ── Email verification ────────────────────────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Verification token required' });

    const { rows: [user] } = await pool.query(
      `SELECT id FROM users WHERE email_verification_token = $1 AND email_verification_expires > NOW() AND email_verified = FALSE`,
      [token]
    );
    if (!user) return res.status(400).json({ error: 'Verification link is invalid or has expired' });

    await pool.query(
      `UPDATE users SET email_verified = TRUE, email_verification_token = NULL, email_verification_expires = NULL, updated_at = NOW() WHERE id = $1`,
      [user.id]
    );

    activity.log('user.email_verified', { userId: user.id, req });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Email verification failed' });
  }
});

router.post('/resend-verification', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    const u = req.user;
    if (u.email_verified) return res.json({ ok: true, message: 'Email already verified' });

    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE users SET email_verification_token = $1, email_verification_expires = $2, updated_at = NOW() WHERE id = $3`,
      [verifyToken, verifyExpires, u.id]
    );

    const verifyUrl = `${process.env.APP_URL}/verify-email?token=${verifyToken}`;
    await sendMail({
      to: u.email,
      subject: 'Verify your rslvd.privatedns.org email',
      text: `Please verify your email address by clicking the link below (expires in 24 hours):\n\n${verifyUrl}`,
      html: `<p>Please verify your email address:</p><p><a href="${verifyUrl}" style="font-size:16px;font-weight:bold">Verify my email \u2192</a></p><p style="color:#888;font-size:13px">This link expires in 24 hours.</p>`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// ── TOS / Legal acceptance ────────────────────────────────────────────────────
router.post('/accept-legal', require('../middleware/auth').requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET tos_version_accepted = $1, updated_at = NOW() WHERE id = $2`,
      [CURRENT_LEGAL_VERSION, req.user.id]
    );
    activity.log('user.tos_accepted', { userId: req.user.id, detail: `v${CURRENT_LEGAL_VERSION}`, req });
    res.json({ ok: true, tosAccepted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record legal acceptance' });
  }
});

router.get('/legal-version', (req, res) => {
  res.json({ version: CURRENT_LEGAL_VERSION });
});

module.exports = router;
