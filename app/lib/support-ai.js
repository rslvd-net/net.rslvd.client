const pool = require('../db/pool');
const { notifyAdmin } = require('./notify');

// AI-first support: a self-hosted Ollama model answers tickets, and the ticket
// escalates to the site owner when the AI can't help, fails, or the user asks.

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.SUPPORT_AI_MODEL || 'llama3.2:1b';
const ENABLED = process.env.SUPPORT_AI !== 'false';
const TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = `You are the support assistant for rslvd.privatedns.org, a Dynamic DNS (DDNS) and tunneling service.

Facts about rslvd.privatedns.org:
- Users get permanent subdomains like yourname.rslvd.privatedns.org that point at their home IP (DDNS), and reverse tunnels that expose local services even behind CGNAT (no port forwarding needed).
- Plans: Free (2 hostnames, 2 tunnels), Monthly $0.99 (4/4), Quarterly $1.99 (12/12), 6 Months $4.99 (24/24), Annual $8.99 (unlimited + nested subdomains like api.yourname.rslvd.privatedns.org).
- Donations: every $0.50 donated grants +1 bonus hostname and +1 bonus tunnel slot for 30 days.
- DDNS updates use the standard DynDNS protocol: GET https://rslvd.privatedns.org/api/update?key=UPDATE_KEY&ip=1.2.3.4 (responses: good, nochg, badauth). Works with ddclient, routers (DD-WRT/OpenWrt), and the rslvd apps.
- Each hostname has an Update Key (shown on the host card, can be regenerated). Each tunnel has a connect token.
- Tunnels: run "rslvd-tunnel TOKEN LOCAL_PORT" (download at rslvd.privatedns.org/downloads), or use the Android app's built-in tunnel client. Protocols: TCP (default), UDP (-udp), DNS2TCP (-dns).
- HTTP tunnels/hosts get free automatic Let's Encrypt HTTPS certificates. HTTPS can be toggled per host/tunnel.
- Apps: Android app (Play Store / rslvd.privatedns.org/downloads) with DDNS auto-update, tunnel client, and a shell tab. There is also a web dashboard at rslvd.privatedns.org/dashboard.
- Login supports optional 2FA (TOTP). If 2FA codes are rejected, the user's device clock is usually wrong - set Date & Time to automatic.
- Payments are processed by Square. Users can cancel anytime; plans stay active until the end of the billing period.

Rules:
- Be concise, friendly, and practical. Give step-by-step instructions when helpful.
- Only answer questions about rslvd.privatedns.org. For anything else, politely say it's out of scope.
- Never invent features, prices, or promises. Never ask for passwords, update keys, tokens, or payment details.
- If you are not confident you can solve the problem (billing disputes, refunds, account recovery, deleting data, bugs, outages), say so and tell the user to press the "Escalate to a human" button so the site owner can help.
- Always end with a short note that they can press "Escalate to a human" if your answer didn't solve it.`;

function configured() { return ENABLED; }

async function chat(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        options: { num_predict: 400, temperature: 0.3 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    const reply = data.message && data.message.content && data.message.content.trim();
    if (!reply) throw new Error('Empty AI reply');
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

async function escalate(ticketId, reason) {
  const { rows: [ticket] } = await pool.query(
    `UPDATE support_tickets SET status = 'escalated', updated_at = NOW()
     WHERE id = $1 AND status != 'closed' RETURNING *`,
    [ticketId]
  );
  if (!ticket) return null;
  const { rows: [u] } = await pool.query('SELECT email FROM users WHERE id = $1', [ticket.user_id]);
  notifyAdmin(
    `Support ticket #${ticket.id} needs you: ${ticket.subject}`,
    `From ${u ? u.email : 'unknown user'} — ${reason}\n\nReply at https://rslvd.privatedns.org/support`
  ).catch((e) => console.error('[support-ai] escalation notify failed:', e.message));
  return ticket;
}

/**
 * Generate and store an AI reply for the latest user message on a ticket.
 * Runs async (fire-and-forget from the route). Escalates on failure.
 */
async function respond(ticketId) {
  try {
    const { rows: [ticket] } = await pool.query('SELECT * FROM support_tickets WHERE id = $1', [ticketId]);
    if (!ticket || ticket.status === 'closed' || ticket.status === 'escalated') return;

    const { rows: msgs } = await pool.query(
      'SELECT is_staff, is_ai, body FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC',
      [ticketId]
    );
    const history = msgs.map((m) => ({
      role: m.is_staff || m.is_ai ? 'assistant' : 'user',
      content: m.body,
    }));
    history.unshift({ role: 'user', content: `Ticket subject: ${ticket.subject}` });

    const reply = await chat(history);
    await pool.query(
      `INSERT INTO ticket_messages (ticket_id, user_id, is_staff, is_ai, body) VALUES ($1, NULL, FALSE, TRUE, $2)`,
      [ticketId, reply]
    );
    await pool.query(
      `UPDATE support_tickets SET status = 'answered', updated_at = NOW() WHERE id = $1 AND status = 'open'`,
      [ticketId]
    );
  } catch (e) {
    console.error(`[support-ai] reply failed for ticket ${ticketId}:`, e.message);
    await escalate(ticketId, 'The AI assistant was unavailable or failed to answer.').catch(() => {});
  }
}

module.exports = { configured, respond, escalate };
