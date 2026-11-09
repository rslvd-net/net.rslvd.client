const nodemailer = require('nodemailer');

const host = process.env.SMTP_HOST;
const port = parseInt(process.env.SMTP_PORT || '587');
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;

const transporter = host
  ? nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      // Only attach auth when a username is configured; many relays accept
      // unauthenticated submission from trusted hosts.
      auth: user ? { user, pass } : undefined,
    })
  : null;

async function sendMail({ to, subject, text, html }) {
  if (!transporter) {
    console.warn('[mailer] SMTP_HOST not configured — skipping email:', subject);
    return;
  }
  return transporter.sendMail({
    from: process.env.SMTP_FROM || `"rslvd.net" <${user || 'noreply@rslvd.net'}>`,
    to,
    subject,
    text,
    html,
  });
}

module.exports = { sendMail };
