/**
 * Operator-tunable settings, editable from the site-owner panel.
 *
 * Every entry is an integer, and booleans are stored as 0 or 1. Free text is
 * deliberately absent: credentials, domain names, URLs and secrets stay in the
 * environment file, where only someone with server access can change them.
 *
 * Values are cached in memory and read synchronously by the rest of the app, so
 * a change made in the panel takes effect on the next request without a
 * restart. A missing row means "use the default", which keeps this safe to add
 * to an existing database.
 */
const pool = require('../db/pool');

const DEFINITIONS = {
  // ── Donations ──────────────────────────────────────────────────────────────
  donation_goal_cents: {
    group: 'Donations', label: 'Monthly donation goal (cents)', default: 2250,
    min: 100, max: 1000000,
    help: 'The goal bar on the landing page. 2250 = $22.50.',
  },
  donation_min_cents: {
    group: 'Donations', label: 'Minimum donation (cents)', default: 100,
    min: 100, max: 100000,
    help: 'Smallest donation that grants donor access. 100 = $1.00.',
  },
  donation_max_cents: {
    group: 'Donations', label: 'Maximum donation (cents)', default: 20000,
    min: 100, max: 1000000,
    help: 'Largest single donation the checkout accepts. 20000 = $200.00.',
  },
  donation_donor_days: {
    group: 'Donations', label: 'Donor access per donation (days)', default: 90,
    min: 1, max: 3650,
    help: 'Flat term granted by any donation. 90 days = 3 months.',
  },

  // ── Free plan ──────────────────────────────────────────────────────────────
  free_max_hosts: {
    group: 'Free plan', label: 'Free hostnames', default: 2,
    min: 1, max: 999999,
    help: 'Hostnames a free account can hold.',
  },
  free_max_tunnels: {
    group: 'Free plan', label: 'Free general tunnels', default: 2,
    min: 1, max: 999999,
    help: 'TCP/UDP tunnels a free account can hold. SSH/ADB are counted separately.',
  },
  free_ssh_tunnels: {
    group: 'Free plan', label: 'Free SSH tunnels', default: 1,
    min: 0, max: 999999,
    help: 'Raw SSH tunnels a free account can hold. 0 turns the feature off for free users.',
  },
  free_adb_tunnels: {
    group: 'Free plan', label: 'Free ADB tunnels', default: 1,
    min: 0, max: 999999,
    help: 'Raw ADB tunnels a free account can hold. 0 turns the feature off for free users.',
  },

  // ── Rate limits ────────────────────────────────────────────────────────────
  rl_login_ip: {
    group: 'Rate limits', label: 'Sign-in attempts per address / 15 min', default: 20,
    min: 1, max: 100000, help: 'Successful sign-ins are refunded, so normal use never hits this.',
  },
  rl_login_email: {
    group: 'Rate limits', label: 'Sign-in attempts per account / 15 min', default: 10,
    min: 1, max: 100000, help: 'Stops a botnet spreading guesses over many addresses.',
  },
  rl_register_ip: {
    group: 'Rate limits', label: 'Sign-ups per address / hour', default: 5,
    min: 1, max: 100000,
  },
  rl_forgot_ip: {
    group: 'Rate limits', label: 'Password resets requested per address / hour', default: 10,
    min: 1, max: 100000,
  },
  rl_forgot_email: {
    group: 'Rate limits', label: 'Reset emails per account / hour', default: 3,
    min: 1, max: 100000,
  },
  rl_reset_ip: {
    group: 'Rate limits', label: 'Password resets submitted per address / 15 min', default: 10,
    min: 1, max: 100000,
  },
  rl_account_action: {
    group: 'Rate limits', label: '2FA / password checks per account / 15 min', default: 10,
    min: 1, max: 100000,
  },
  rl_resend_verify: {
    group: 'Rate limits', label: 'Verification emails per account / hour', default: 3,
    min: 1, max: 100000,
  },

  // ── Support & beta ─────────────────────────────────────────────────────────
  support_ai_enabled: {
    group: 'Support & beta', label: 'AI support replies (1 = on, 0 = off)', default: 1,
    min: 0, max: 1,
    help: 'The environment variable SUPPORT_AI=false overrides this and turns it off for good.',
  },
  beta_max_testers: {
    group: 'Support & beta', label: 'Android beta tester slots', default: 12,
    min: 0, max: 1000000,
    help: 'How many testers the closed beta form accepts. 0 closes sign-ups.',
  },
};

/** Default for a definition, resolving a function so env vars can seed it. */
const def = (d) => (typeof d.default === 'function' ? d.default() : d.default);

// Cached rows from app_settings. Absent key = still on its default.
const cache = Object.create(null);

/** One setting, always an integer. */
function get(key) {
  const d = DEFINITIONS[key];
  if (!d) throw new Error(`Unknown setting: ${key}`);
  const value = cache[key];
  return Number.isInteger(value) ? value : def(d);
}

/** Every setting with its metadata and current value, in display order. */
function list() {
  return Object.entries(DEFINITIONS).map(([key, d]) => ({
    key,
    group: d.group,
    label: d.label,
    help: d.help || null,
    min: d.min,
    max: d.max,
    default: def(d),
    value: get(key),
  }));
}

/** Read every stored value into the cache (called at boot and after a save). */
async function load() {
  const { rows } = await pool.query('SELECT key, value FROM app_settings');
  for (const key of Object.keys(cache)) delete cache[key];
  for (const row of rows) {
    if (DEFINITIONS[row.key] && Number.isInteger(Number(row.value))) {
      cache[row.key] = Number(row.value);
    }
  }
  return list();
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** Rules that span two settings, checked against the values a save would leave. */
function assertConsistent(next) {
  const min = next.donation_min_cents ?? get('donation_min_cents');
  const max = next.donation_max_cents ?? get('donation_max_cents');
  if (min > max) throw badRequest('Minimum donation cannot be larger than the maximum donation');
}

/**
 * Validate and persist a batch of integer settings, then refresh the cache.
 * Throws with `status = 400` on anything that is not a whole number in range.
 */
async function update(updates, userId = null) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw badRequest('Expected a settings object');
  }

  const clean = [];
  for (const [key, raw] of Object.entries(updates)) {
    const d = DEFINITIONS[key];
    if (!d) throw badRequest(`Unknown setting: ${key}`);
    const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isInteger(value)) throw badRequest(`${d.label} must be a whole number`);
    if (value < d.min || value > d.max) {
      throw badRequest(`${d.label} must be between ${d.min} and ${d.max}`);
    }
    clean.push([key, value]);
  }
  if (clean.length === 0) throw badRequest('No settings to update');

  assertConsistent(Object.fromEntries(clean));

  for (const [key, value] of clean) {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [key, value, userId]
    );
    cache[key] = value;
  }

  return list();
}

/** Format cents for user-facing text: 2250 → "$22.50". */
function money(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

module.exports = { DEFINITIONS, get, list, load, update, money };
