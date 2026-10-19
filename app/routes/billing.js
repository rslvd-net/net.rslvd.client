const crypto = require('crypto');
const router = require('express').Router();
const pool = require('../db/pool');
const square = require('../lib/square');
const { PLANS, DONATION } = require('../lib/plans');
const { requireAuth } = require('../middleware/auth');
const payments = require('../lib/payments');
const activity = require('../lib/activity');

router.get('/plans', (req, res) => {
  res.json(Object.entries(PLANS).map(([key, val]) => ({
    key, label: val.label, amount: val.amount, maxHosts: val.maxHosts, maxTunnels: val.maxTunnels,
  })));
});

function requireGateway(req, res, next) {
  if (!square.configured) return res.status(503).json({ error: 'Billing is not configured' });
  next();
}

function squareErrorMessage(err, fallback) {
  const first = err && err.errors && err.errors[0];
  return (first && (first.detail || first.code)) || fallback;
}

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

router.post('/subscribe', requireAuth, requireGateway, async (req, res) => {
  try {
    const { plan, sourceId } = req.body;
    const planInfo = PLANS[plan];
    if (!planInfo) return res.status(400).json({ error: 'Invalid plan' });
    if (!sourceId) return res.status(400).json({ error: 'Payment method required' });

    const user = req.user;
    if (user.subscription_status === 'active' && user.plan !== 'free') {
      return res.status(400).json({ error: 'You already have an active subscription. Cancel it first or contact support.' });
    }

    const customerId = await ensureCustomer(user);
    const card = await storeCard(user, customerId, sourceId);

    // Intent row + Square idempotency key make the charge crash-safe: if the
    // process dies after the charge, reconciliation applies the paid plan.
    const intent = await payments.createIntent({
      userId: user.id, plan, kind: 'subscribe', amountCents: planInfo.amountCents,
      customerId, cardId: card.id,
    });
    const payment = await payments.executeIntent(intent, `rslvd.privatedns.org ${planInfo.label} plan (${plan})`);
    const expires = await payments.applyIntent(intent, payment);

    res.json({ success: true, subscription: { id: payment.id, status: 'active', plan, paidThroughDate: expires } });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(400).json({ error: squareErrorMessage(err, 'Subscription failed') });
  }
});

// Pay-what-you-want donation: every 50¢ grants +1 bonus hostname and +1 bonus
// tunnel slot for 30 days (stacks with any plan, extends an active bonus).
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
    const payment = await payments.executeIntent(intent, 'rslvd.privatedns.org donation');
    const bonus = await payments.applyDonation(intent, payment);

    activity.log('user.donation', { userId: user.id, detail: `$${(cents / 100).toFixed(2)}`, req });
    res.json({
      success: true,
      bonusHosts: bonus.hosts,
      bonusTunnels: bonus.tunnels,
      bonusExpiresAt: bonus.expires,
    });
  } catch (err) {
    console.error('Donation error:', err);
    res.status(400).json({ error: squareErrorMessage(err, 'Donation failed') });
  }
});

router.get('/subscription', requireAuth, requireGateway, async (req, res) => {
  try {
    const user = req.user;
    if (user.plan === 'free' || user.subscription_status === 'inactive') return res.json({ status: 'none' });

    let paymentMethod = null;
    if (user.square_card_id) {
      try {
        const { card } = await square.client.cards.get({ cardId: user.square_card_id });
        paymentMethod = { type: card.cardBrand || 'Card', last4: card.last4, expirationMonth: Number(card.expMonth), expirationYear: Number(card.expYear) };
      } catch (_) {}
    }

    res.json({
      status: user.subscription_status,
      plan: user.plan,
      paidThroughDate: user.plan_expires_at,
      nextBillingDate: user.subscription_status === 'active' ? user.plan_expires_at : null,
      paymentMethod,
    });
  } catch (err) {
    console.error('Subscription fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

router.post('/cancel', requireAuth, requireGateway, async (req, res) => {
  try {
    const user = req.user;
    if (user.subscription_status !== 'active' || user.plan === 'free') {
      return res.status(400).json({ error: 'No active subscription' });
    }

    await pool.query(
      `UPDATE users SET subscription_status = 'cancelling', updated_at = NOW() WHERE id = $1`,
      [user.id]
    );

    res.json({ success: true, message: 'Subscription will remain active until the end of your billing period' });
  } catch (err) {
    console.error('Cancel error:', err);
    res.status(500).json({ error: 'Cancellation failed' });
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
