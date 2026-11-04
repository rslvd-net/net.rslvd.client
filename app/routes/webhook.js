const crypto = require('crypto');
const router = require('express').Router();
const pool = require('../db/pool');
const { notifyAdmin } = require('../lib/notify');

async function userByPayment(paymentId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email FROM payment_intents p JOIN users u ON u.id = p.user_id
     WHERE p.square_payment_id = $1`,
    [paymentId]
  );
  return rows[0] || null;
}

// Events worth an admin alert even without a dedicated handler. Everything
// else (order.*, customer.*, card.created, ...) fires on every normal sale
// and is only logged.
const NOTABLE_EVENTS = new Set([
  'payout.failed',
  'card.disabled',
  'card.forgotten',
  'invoice.scheduled_charge_failed',
  'dispute.state.changed',
  'dispute.state.updated',
  'dispute.evidence.added',
  'dispute.evidence.deleted',
  'dispute.evidence.removed',
  'bank_account.disabled',
]);

function money(m) {
  return m && m.amount != null ? `$${(Number(m.amount) / 100).toFixed(2)}` : '?';
}

// Square webhook notifications. Renewals are managed by the in-process
// billing-renewal job; this handler reacts to out-of-band events (refunds,
// disputes, failed payments). Donor access is time-based, so events only notify.
router.post('/', async (req, res) => {
  try {
    const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    const notificationUrl = process.env.SQUARE_WEBHOOK_URL || `${process.env.APP_URL}/api/webhook`;

    if (!signatureKey) return res.status(503).json({ error: 'Webhooks not configured' });

    const signature = req.get('x-square-hmacsha256-signature');
    if (!signature || !req.rawBody) {
      return res.status(400).json({ error: 'Missing webhook signature' });
    }

    const expected = crypto.createHmac('sha256', signatureKey)
      .update(notificationUrl + req.rawBody.toString('utf8'))
      .digest('base64');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.error('Webhook: invalid Square signature');
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }

    const event = req.body;
    const type = event && event.type;

    switch (type) {
      case 'refund.created':
      case 'refund.updated': {
        const refund = event.data && event.data.object && event.data.object.refund;
        if (!refund || !refund.payment_id) break;
        const user = await userByPayment(refund.payment_id);
        notifyAdmin(
          `Refund ${refund.status}`,
          `${money(refund.amount_money)} refund for ${user ? user.email : `payment ${refund.payment_id}`}` +
          ''
        );
        break;
      }

      case 'payment.created': {
        const payment = event.data && event.data.object && event.data.object.payment;
        if (!payment) break;
        const user = await userByPayment(payment.id);
        notifyAdmin(
          `Payment ${payment.status || 'created'}`,
          `${money(payment.amount_money)} charge${user ? ` from ${user.email}` : ''} (${payment.id})`
        );
        break;
      }

      case 'payment.updated': {
        const payment = event.data && event.data.object && event.data.object.payment;
        if (!payment) break;
        if (payment.status === 'FAILED' || payment.status === 'CANCELED') {
          const user = await userByPayment(payment.id);
          notifyAdmin(
            `Payment ${payment.status}`,
            `${money(payment.amount_money)} payment ${payment.status.toLowerCase()}${user ? ` for ${user.email}` : ''}`
          );
        }
        break;
      }

      case 'dispute.created':
      case 'dispute.updated': {
        const dispute = event.data && event.data.object && event.data.object.dispute;
        const paymentId = dispute && dispute.disputed_payment && dispute.disputed_payment.payment_id;
        let user = null;
        if (paymentId) {
          user = await userByPayment(paymentId);
        }
        notifyAdmin(
          `Dispute ${dispute ? dispute.state || dispute.status || '' : ''}`.trim(),
          `${dispute ? money(dispute.amount_money) : '?'} dispute${user ? ` on ${user.email}` : ''}` +
          `${dispute && dispute.reason ? ` — ${dispute.reason}` : ''}` +
          `${dispute && dispute.due_at ? ` (respond by ${dispute.due_at})` : ''}`
        );
        break;
      }

      case 'dispute.evidence.created': {
        notifyAdmin('Dispute evidence added', 'Evidence was submitted on a dispute — check the Square dashboard');
        break;
      }

      case 'oauth.authorization.revoked': {
        notifyAdmin('Square authorization revoked', 'The Square access token was revoked — billing will stop working until reauthorized');
        break;
      }

      default:
        if (type && NOTABLE_EVENTS.has(type)) {
          notifyAdmin(`Square event: ${type}`, `Event received (id ${event.event_id || '?'}) — check the Square dashboard`);
        } else if (type) {
          console.log(`Webhook: ${type} (id ${event.event_id || '?'})`);
        }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
