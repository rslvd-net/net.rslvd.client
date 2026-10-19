const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../lib/mailer');
const supportAi = require('../lib/support-ai');
const { notifyAdmin } = require('../lib/notify');

const isStaff = (user) => user.is_admin || user.is_site_owner;

// ── List tickets (user sees own; staff sees all) ──────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const { rows } = isStaff(u)
      ? await pool.query(
          `SELECT t.*, u.email as user_email,
            (SELECT COUNT(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
           FROM support_tickets t JOIN users u ON u.id = t.user_id
           ORDER BY t.updated_at DESC`)
      : await pool.query(
          `SELECT t.*,
            (SELECT COUNT(*)::int FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
           FROM support_tickets t WHERE t.user_id = $1 ORDER BY t.updated_at DESC`,
          [u.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create ticket ─────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { subject, body } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Subject is required' });
    if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });
    if (subject.length > 200) return res.status(400).json({ error: 'Subject too long' });
    if (body.length > 10000) return res.status(400).json({ error: 'Message too long' });

    const { rows: [ticket] } = await pool.query(
      `INSERT INTO support_tickets (user_id, subject) VALUES ($1, $2) RETURNING *`,
      [req.user.id, subject.trim()]
    );
    await pool.query(
      `INSERT INTO ticket_messages (ticket_id, user_id, is_staff, body) VALUES ($1, $2, FALSE, $3)`,
      [ticket.id, req.user.id, body.trim()]
    );

    // AI answers first; the owner is only notified on escalation.
    if (supportAi.configured()) {
      supportAi.respond(ticket.id);
      return res.status(201).json(ticket);
    }

    // Notify site owner
    const notifyTo = process.env.NOTIFY_EMAIL;
    if (notifyTo) {
      sendMail({
        to: notifyTo,
        subject: `[rslvd.privatedns.org] New support ticket #${ticket.id}: ${subject.trim()}`,
        text: `New support ticket from ${req.user.email}\n\nSubject: ${subject.trim()}\n\n${body.trim()}\n\nView: https://rslvd.privatedns.org/admin`,
        html: `<p><strong>New support ticket from ${req.user.email}</strong></p><p><strong>Subject:</strong> ${subject.trim()}</p><hr><p style="white-space:pre-wrap">${body.trim()}</p><p><a href="https://rslvd.privatedns.org/admin">View in admin panel →</a></p>`,
      }).catch(e => console.error('[support] notify email failed:', e.message));
    }

    res.status(201).json(ticket);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Get single ticket + messages ──────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const { rows: [ticket] } = await pool.query(
      `SELECT t.*, u.email as user_email FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!isStaff(u) && ticket.user_id !== u.id) return res.status(403).json({ error: 'Forbidden' });

    const { rows: messages } = await pool.query(
      `SELECT m.*, u.email as sender_email FROM ticket_messages m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.ticket_id = $1 ORDER BY m.created_at ASC`,
      [ticket.id]
    );
    res.json({ ...ticket, messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Reply to ticket ───────────────────────────────────────────────────────────
router.post('/:id/reply', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Reply body is required' });
    if (body.length > 10000) return res.status(400).json({ error: 'Message too long' });

    const { rows: [ticket] } = await pool.query(
      `SELECT * FROM support_tickets WHERE id = $1`, [req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!isStaff(u) && ticket.user_id !== u.id) return res.status(403).json({ error: 'Forbidden' });
    if (ticket.status === 'closed' && !isStaff(u)) return res.status(400).json({ error: 'Ticket is closed' });

    const { rows: [msg] } = await pool.query(
      `INSERT INTO ticket_messages (ticket_id, user_id, is_staff, body) VALUES ($1, $2, $3, $4) RETURNING *`,
      [ticket.id, u.id, isStaff(u), body.trim()]
    );
    const newStatus = isStaff(u) ? 'answered'
      : ticket.status === 'escalated' ? 'escalated'
      : 'open';
    await pool.query(
      `UPDATE support_tickets SET updated_at = NOW(), status = $1 WHERE id = $2`,
      [newStatus, ticket.id]
    );
    if (!isStaff(u) && ticket.status !== 'escalated' && supportAi.configured()) {
      supportAi.respond(ticket.id);
    } else if (!isStaff(u) && ticket.status === 'escalated') {
      notifyAdmin(
        `Support ticket #${ticket.id}: new reply`,
        `${u.email} replied on an escalated ticket.\n\n${body.trim().slice(0, 500)}\n\nhttps://rslvd.privatedns.org/support`
      ).catch(e => console.error('[support] notify failed:', e.message));
    }
    res.status(201).json(msg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Escalate to a human (ticket owner or staff) ──────────────────────────
router.post('/:id/escalate', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const { rows: [ticket] } = await pool.query('SELECT * FROM support_tickets WHERE id = $1', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!isStaff(u) && ticket.user_id !== u.id) return res.status(403).json({ error: 'Forbidden' });
    if (ticket.status === 'closed') return res.status(400).json({ error: 'Ticket is closed' });
    if (ticket.status === 'escalated') return res.json(ticket);

    const updated = await supportAi.escalate(ticket.id, 'The user asked for a human.');
    res.json(updated || ticket);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update ticket status (staff only) ────────────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    if (!isStaff(req.user)) return res.status(403).json({ error: 'Staff only' });
    const { status, priority } = req.body;
    const allowed_status = ['open', 'answered', 'escalated', 'closed'];
    const allowed_priority = ['low', 'normal', 'high', 'urgent'];
    if (status && !allowed_status.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    if (priority && !allowed_priority.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });

    const { rows: [ticket] } = await pool.query(
      `UPDATE support_tickets SET
        status = COALESCE($1, status),
        priority = COALESCE($2, priority),
        updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [status || null, priority || null, req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json(ticket);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
