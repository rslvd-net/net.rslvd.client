require('dotenv').config();
// Installed before anything else logs, so the owner's Logs tab sees boot output
// too. Nothing else changes: console still prints to stdout as usual.
require('./lib/logbus').install();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

const app = express();

// nginx terminates TLS on loopback and appends X-Forwarded-For there, so trust
// exactly that one hop: req.ip becomes the real client address instead of
// 127.0.0.1, and X-Forwarded-For values the client invented are ignored.
app.set('trust proxy', 'loopback');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.APP_URL }));

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/account', require('./routes/account'));
app.use('/api/hosts', require('./routes/hosts'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/webhook', require('./routes/webhook'));
app.use('/api/update', require('./routes/update'));
app.use('/api/tunnels', require('./routes/tunnels'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/support', require('./routes/support'));
app.use('/api/track', require('./routes/track'));
app.use('/api/beta', require('./routes/beta'));
app.use('/api/dns-changes', require('./routes/dns-changes'));

// Public IP detection for PWA DDNS auto-updater
app.get('/api/ip', (req, res) => {
  // req.ip already honours the trusted proxy hop above; strip the IPv4-mapped
  // prefix so the reply is directly usable as a DDNS address.
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  res.json({ ip });
});

// Unmatched /api/* answers JSON, not the app shell, so a mistyped API call fails
// where a client can see it.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve React frontend
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// SPA fallback: only browser navigations get the shell. Unknown paths and missing
// assets answer a real 404 instead of a 200 that crawlers and API clients trust.
app.get('/{*path}', (req, res) => {
  if (!String(req.headers.accept || '').includes('text/html')) {
    return res.status(404).type('txt').send('Not found');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`rslvd.privatedns.org DDNS server running on port ${PORT}`);
  await require('./db/migrate').run();
  try {
    await require('./lib/settings').load();
    console.log('Settings loaded');
  } catch (err) {
    // Defaults stay in place, so the app keeps serving with stock values.
    console.error('Settings load failed, using defaults:', err.message);
  }
  require('./lib/tunnel-proxy').startTunnelProxy();
});
