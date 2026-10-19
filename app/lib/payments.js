const pool = require('../db/pool');
const square = require('./square');
const { PLANS, DONATION } = require('./plans');

// Payment intents make charges crash-safe. An intent row is written before the
// Square charge, and the intent id doubles as the Square idempotency key — so
// replaying the charge (e.g. during reconciliation after a crash) returns the
// original payment instead of charging the card twice.
//
// Intent lifecycle: pending -> charged -> applied, or -> failed / abandoned.

const RECONCILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function createIntent({ userId, plan, kind, amountCents, customerId, cardId }) {
  const { rows } = await pool.query(
    `INSERT INTO payment_intents (user_id, plan, kind, amount_cents, square_customer_id, square_card_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, plan, kind, amountCents, customerId, cardId]
  );
  return rows[0];
}

async function setIntentStatus(intentId, status, paymentId) {
  await pool.query(
    `UPDATE payment_intents SET status = $1, square_payment_id = COALESCE($2, square_payment_id), updated_at = NOW()
     WHERE id = $3`,
    [status, paymentId || null, intentId]
  );
}

/** Charge the card for an intent. Idempotent: replays return the original payment. */
async function executeIntent(intent, note) {
  const { payment } = await square.client.payments.create({
    idempotencyKey: intent.id,
    sourceId: intent.square_card_id,
    customerId: intent.square_customer_id,
    locationId: square.locationId,
    amountMoney: { amount: BigInt(intent.amount_cents), currency: 'USD' },
    note,
  });
  if (payment.status !== 'COMPLETED' && payment.status !== 'APPROVED') {
    await setIntentStatus(intent.id, 'failed', payment.id);
    throw new Error(`Payment ${payment.status}`);
  }
  await setIntentStatus(intent.id, 'charged', payment.id);
  return payment;
}

/** Apply a paid donation intent: grant bonus slots and record the total. */
async function applyDonation(intent, payment) {
  const slots = Math.min(
    Math.floor(intent.amount_cents / DONATION.centsPerSlot),
    DONATION.maxBonusSlots
  );
  const { rows } = await pool.query(
    'SELECT bonus_hosts, bonus_tunnels, bonus_expires_at FROM users WHERE id = $1',
    [intent.user_id]
  );
  if (!rows.length) throw new Error('User no longer exists');

  const u = rows[0];
  const now = new Date();
  const bonusActive = u.bonus_expires_at && new Date(u.bonus_expires_at) > now;
  const base = bonusActive ? new Date(u.bonus_expires_at) : now;
  const expires = new Date(base.getTime() + DONATION.periodDays * 86400000);
  const hosts = Math.min((bonusActive ? u.bonus_hosts || 0 : 0) + slots, DONATION.maxBonusSlots);
  const tunnels = Math.min((bonusActive ? u.bonus_tunnels || 0 : 0) + slots, DONATION.maxBonusSlots);

  await pool.query(
    `UPDATE users SET bonus_hosts = $1, bonus_tunnels = $2, bonus_expires_at = $3,
     donated_total_cents = COALESCE(donated_total_cents, 0) + $4, updated_at = NOW()
     WHERE id = $5`,
    [hosts, tunnels, expires, intent.amount_cents, intent.user_id]
  );
  await setIntentStatus(intent.id, 'applied', payment.id);
  return { hosts, tunnels, expires };
}

/** Apply a paid intent to the user's account and mark it applied. */
async function applyIntent(intent, payment) {
  const planInfo = PLANS[intent.plan];
  if (!planInfo) throw new Error(`Unknown plan ${intent.plan}`);

  const { rows } = await pool.query('SELECT plan_expires_at FROM users WHERE id = $1', [intent.user_id]);
  if (!rows.length) throw new Error('User no longer exists');

  const paidAt = new Date(intent.created_at);
  const current = rows[0].plan_expires_at ? new Date(rows[0].plan_expires_at) : null;
  const base = intent.kind === 'renewal' && current && current > paidAt ? current : paidAt;
  const expires = new Date(base.getTime() + planInfo.periodDays * 86400000);

  await pool.query(
    `UPDATE users SET subscription_id = $1, subscription_status = 'active',
     plan = $2, max_hosts = $3, max_tunnels = $4, plan_expires_at = $5, updated_at = NOW()
     WHERE id = $6`,
    [payment.id, intent.plan, planInfo.maxHosts, planInfo.maxTunnels, expires, intent.user_id]
  );
  await setIntentStatus(intent.id, 'applied', payment.id);
  return expires;
}

/**
 * Recover intents that were interrupted mid-flight (crash/restart between the
 * Square charge and the account update). Replays the charge idempotently and
 * applies any payment that completed but never reached the user's account.
 */
async function reconcilePending() {
  if (!square.configured) return;
  const { rows } = await pool.query(
    `SELECT * FROM payment_intents
     WHERE status IN ('pending', 'charged') AND created_at < NOW() - INTERVAL '2 minutes'
     ORDER BY created_at`
  );
  for (const intent of rows) {
    try {
      if (Date.now() - new Date(intent.created_at).getTime() > RECONCILE_MAX_AGE_MS) {
        await setIntentStatus(intent.id, 'abandoned');
        console.warn(`Billing: abandoned stale payment intent ${intent.id}`);
        continue;
      }
      if (!intent.user_id) {
        await setIntentStatus(intent.id, 'abandoned');
        continue;
      }
      if (intent.kind === 'donation') {
        const payment = await executeIntent(intent, 'rslvd.privatedns.org donation (reconciled)');
        const bonus = await applyDonation(intent, payment);
        console.log(`Billing: reconciled donation intent ${intent.id} — bonus applied through ${bonus.expires.toISOString()}`);
        continue;
      }
      const planInfo = PLANS[intent.plan];
      const payment = await executeIntent(intent, `rslvd.privatedns.org ${planInfo ? planInfo.label : intent.plan} plan (reconciled)`);
      const expires = await applyIntent(intent, payment);
      console.log(`Billing: reconciled payment intent ${intent.id} — plan ${intent.plan} applied through ${expires.toISOString()}`);
    } catch (err) {
      if (err && err.errors) await setIntentStatus(intent.id, 'failed').catch(() => {});
      console.error(`Billing: reconciliation failed for intent ${intent.id}:`, err.message);
    }
  }
}

module.exports = { createIntent, executeIntent, applyIntent, applyDonation, reconcilePending, setIntentStatus };
