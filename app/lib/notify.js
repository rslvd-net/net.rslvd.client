const { sendMail } = require('./mailer');

// Admin notifications for billing/webhook events. Routes, in order of preference:
//  - ntfy push: NTFY_TOPIC (and optionally NTFY_SERVER, NTFY_TOKEN)
//  - Twilio SMS: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, ADMIN_PHONE
//  - Carrier email-to-SMS gateway: ADMIN_SMS_EMAIL (e.g. 5551234567@vtext.com)
//  - Plain email fallback: ADMIN_EMAIL

async function sendTwilioSms(body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const to = process.env.ADMIN_PHONE;
  if (!sid || !token || !from || !to) return false;

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
  return true;
}

async function sendNtfyPush(subject, message) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return false;
  const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
  const headers = { Title: `rslvd.net: ${subject}`, Priority: 'high', Tags: 'bell' };
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
  const res = await fetch(`${server}/${topic}`, { method: 'POST', headers, body: message });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`);
  return true;
}

async function notifyAdmin(subject, message) {
  const text = `[rslvd.net] ${subject}\n${message}`;
  try {
    if (await sendNtfyPush(subject, message)) return;
  } catch (err) {
    console.error('[notify] ntfy push failed:', err.message);
  }
  try {
    if (await sendTwilioSms(text)) return;
  } catch (err) {
    console.error('[notify] Twilio SMS failed:', err.message);
  }
  try {
    if (process.env.ADMIN_SMS_EMAIL) {
      // Carrier gateways truncate long messages; keep it short and plain
      await sendMail({ to: process.env.ADMIN_SMS_EMAIL, subject: `rslvd: ${subject}`, text: message.slice(0, 300) });
      return;
    }
    if (process.env.ADMIN_EMAIL) {
      await sendMail({ to: process.env.ADMIN_EMAIL, subject: `[rslvd.net] ${subject}`, text: message });
      return;
    }
    console.warn('[notify] No admin notification route configured:', subject);
  } catch (err) {
    console.error('[notify] Admin notification failed:', err.message);
  }
}

module.exports = { notifyAdmin };
