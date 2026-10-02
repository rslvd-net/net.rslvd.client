require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

const app = express();

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
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  res.json({ ip });
});

// Serve React frontend
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`rslvd.net DDNS server running on port ${PORT}`);
  await require('./db/migrate').run();
  require('./lib/tunnel-proxy').startTunnelProxy();
  require('./lib/billing-renewal').startRenewalJob();
});
