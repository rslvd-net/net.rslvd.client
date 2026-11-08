/**
 * Rate limiters for the credential endpoints.
 *
 * Where it matters there are two keys: the client IP, so one noisy client cannot
 * spend everybody's allowance, and the account being attacked, so a botnet
 * cannot spread its guesses over many addresses. server.js trusts exactly one
 * proxy hop, so req.ip is the real client rather than 127.0.0.1.
 *
 * The store is the in-process default. The app runs as a single systemd service,
 * so per-process counters are the whole picture; if it is ever scaled out this
 * needs a shared store (Redis is already a dependency).
 */
const rateLimit = require('express-rate-limit');

const { ipKeyGenerator } = rateLimit;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Real client IP, with IPv6 shortened to the /56 that headers are grouped by. */
const byIp = (req) => ipKeyGenerator(req.ip);

/** The email being tried, lowercased; falls back to the IP when it is missing. */
const byEmail = (req) => String(req.body?.email || '').trim().toLowerCase() || byIp(req);

/** The signed-in account, for endpoints that sit behind requireAuth. */
const byUser = (req) => (req.user?.id ? `user:${req.user.id}` : byIp(req));

function limiter({ windowMs, limit, keyGenerator, message, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7', // RateLimit-* plus Retry-After
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message }),
  });
}

// Sign-in: guesses cost a bcrypt compare, so both the address and the account
// get a budget. Successful sign-ins are refunded so normal use never runs out.
const loginByIp = limiter({
  windowMs: 15 * MINUTE,
  limit: 20,
  keyGenerator: byIp,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts from this address. Wait a few minutes and try again.',
});

const loginByEmail = limiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  keyGenerator: byEmail,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts for this account. Wait a few minutes and try again.',
});

// Sign-up sends a verification mail and hashes a password: keep it slow.
const registerByIp = limiter({
  windowMs: HOUR,
  limit: 5,
  keyGenerator: byIp,
  message: 'Too many sign-up attempts. Try again later.',
});

// Calm, even respond 200 to unknown emails, but each hit can send mail.
const forgotByIp = limiter({
  windowMs: HOUR,
  limit: 10,
  keyGenerator: byIp,
  message: 'Too many reset requests from this address. Try again later.',
});

const forgotByEmail = limiter({
  windowMs: HOUR,
  limit: 3,
  keyGenerator: byEmail,
  message: 'Too many reset emails for this account. Try again later.',
});

// Token guessing is infeasible, but each attempt runs bcrypt.
const resetByIp = limiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  keyGenerator: byIp,
  message: 'Too many password resets from this address. Wait a few minutes and try again.',
});

// Signed-in actions that check a password or a 6-digit code.
const accountAction = limiter({
  windowMs: 15 * MINUTE,
  limit: 10,
  keyGenerator: byUser,
  message: 'Too many attempts on this account. Wait a few minutes and try again.',
});

const resendVerificationByUser = limiter({
  windowMs: HOUR,
  limit: 3,
  keyGenerator: byUser,
  message: 'Too many verification emails. Try again later.',
});

module.exports = {
  loginByIp,
  loginByEmail,
  registerByIp,
  forgotByIp,
  forgotByEmail,
  resetByIp,
  accountAction,
  resendVerificationByUser,
};
