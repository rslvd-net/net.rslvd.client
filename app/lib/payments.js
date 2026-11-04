const pool = require('../db/pool');
const square = require('./square');
const { DONATION, donationDays } = require('./plans');

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

/**
 * Apply a paid donation intent: extend the donor window by a flat 3 months
 * (any amount) and record the lifetime total.
 */
async function applyDonation(intent, payment) {
  const { rows } = await pool.query('SELECT bonus_expires_at FROM users WHERE id = $1', [intent.user_id]);
  if (!rows.length) throw new Error('User no longer exists');

  const now = new Date();
  const current = rows[0].bonus_expires_at ? new Date(rows[0].bonus_expires_at) : null;
  const base = current && current > now ? current : now;
  const expires = new Date(base.getTime() + donationDays() * 86400000);

  await pool.query(
    `UPDATE users SET bonus_expires_at = $1,
     donated_total_cents = COALESCE(donated_total_cents, 0) + $2, updated_at = NOW()
     WHERE id = $3`,
    [expires, intent.amount_cents, intent.user_id]
  );
  await setIntentStatus(intent.id, 'applied', payment.id);
  return { expires };
}

/**
 * Total donated this calendar month, in cents, for the landing-page goal bar.
 * Counts applied donation intents only.
 */
async function monthlyDonationCents() {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS total FROM payment_intents
     WHERE kind = 'donation' AND status = 'applied'
       AND created_at >= date_trunc('month', NOW())`
  );
  return rows[0].total;
}

/**
 * Recover donation intents interrupted mid-flight (crash/restart between the
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
      if (!intent.user_id || intent.kind !== 'donation') {
        await setIntentStatus(intent.id, 'abandoned');
        continue;
      }
      const payment = await executeIntent(intent, 'rslvd.privatedns.org donation (reconciled)');
      const bonus = await applyDonation(intent, payment);
      console.log(`Billing: reconciled donation intent ${intent.id} — donor access through ${bonus.expires.toISOString()}`);
    } catch (err) {
      if (err && err.errors) await setIntentStatus(intent.id, 'failed').catch(() => {});
      console.error(`Billing: reconciliation failed for intent ${intent.id}:`, err.message);
    }
  }
}

module.exports = { createIntent, executeIntent, applyDonation, monthlyDonationCents, reconcilePending, setIntentStatus, DONATION };
