const crypto = require('crypto');
const router = require('express').Router();
const pool = require('../db/pool');
const square = require('../lib/square');
const { DONATION } = require('../lib/plans');
const { requireAuth } = require('../middleware/auth');
const payments = require('../lib/payments');
const activity = require('../lib/activity');

function requireGateway(req, res, next) {
  if (!square.configured) return res.status(503).json({ error: 'Billing is not configured' });
  next();
}

function squareErrorMessage(err, fallback) {
  const first = err && err.errors && err.errors[0];
  return (first && (first.detail || first.code)) || fallback;
}

// Monthly donation goal shown on the landing page (public, no auth).
router.get('/goal', async (req, res) => {
  try {
    const raisedCents = await payments.monthlyDonationCents();
    const goalCents = DONATION.goalCents;
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      goalCents,
      raisedCents,
      percent: Math.min(100, Math.round((raisedCents / goalCents) * 100)),
      resetsAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString(),
    });
  } catch (err) {
    console.error('Goal fetch error:', err);
    res.status(500).json({ error: 'Failed to load goal' });
  }
});

// Config for the Square Web Payments SDK on the frontend
router.get('/config', requireAuth, requireGateway, (req, res) => {
  res.json({
    applicationId: square.applicationId,
    locationId: square.locationId,
    environment: square.environment,
  });
});

async function ensureCustomer(user) {
  if (user.square_customer_id) return user.square_customer_id;
  const { customer } = await square.client.customers.create({
    emailAddress: user.email,
    referenceId: user.id,
  });
  await pool.query('UPDATE users SET square_customer_id = $1 WHERE id = $2', [customer.id, user.id]);
  return customer.id;
}

async function storeCard(user, customerId, sourceId) {
  const { card } = await square.client.cards.create({
    idempotencyKey: crypto.randomUUID(),
    sourceId,
    card: { customerId },
  });
  if (user.square_card_id && user.square_card_id !== card.id) {
    try { await square.client.cards.disable({ cardId: user.square_card_id }); }
    catch (e) { console.error('Failed to disable old card:', e.message); }
  }
  await pool.query('UPDATE users SET square_card_id = $1 WHERE id = $2', [card.id, user.id]);
  return card;
}

// Pay-what-you-want donation. Any donation (minimum $1) grants 3 months of
// donor access. Donating extends an active donor window.
router.post('/donate', requireAuth, requireGateway, async (req, res) => {
  try {
    const { amountCents, sourceId } = req.body;
    const cents = Math.floor(Number(amountCents));
    if (!Number.isFinite(cents) || cents < DONATION.minCents || cents > DONATION.maxCents) {
      return res.status(400).json({ error: `Donation must be between $${(DONATION.minCents / 100).toFixed(2)} and $${(DONATION.maxCents / 100).toFixed(2)}` });
    }
    if (!sourceId) return res.status(400).json({ error: 'Payment method required' });

    const user = req.user;
    const customerId = await ensureCustomer(user);
    const card = await storeCard(user, customerId, sourceId);

    const intent = await payments.createIntent({
      userId: user.id, plan: 'donation', kind: 'donation', amountCents: cents,
      customerId, cardId: card.id,
    });
    const payment = await payments.executeIntent(intent, 'rslvd.net donation');
    const bonus = await payments.applyDonation(intent, payment);

    activity.log('user.donation', { userId: user.id, detail: `$${(cents / 100).toFixed(2)}`, req });
    res.json({ success: true, donorExpiresAt: bonus.expires });
  } catch (err) {
    console.error('Donation error:', err);
    res.status(400).json({ error: squareErrorMessage(err, 'Donation failed') });
  }
});

router.post('/update-payment', requireAuth, requireGateway, async (req, res) => {
  try {
    const { sourceId } = req.body;
    if (!sourceId) return res.status(400).json({ error: 'Payment method required' });

    const user = req.user;
    if (!user.square_customer_id) return res.status(400).json({ error: 'No billing account' });

    await storeCard(user, user.square_customer_id, sourceId);
    res.json({ success: true });
  } catch (err) {
    console.error('Update payment error:', err);
    res.status(400).json({ error: squareErrorMessage(err, 'Failed to update payment method') });
  }
});

module.exports = router;
