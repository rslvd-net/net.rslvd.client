// Donation-only model. There are no subscriptions. Donating grants donor access
// for a period proportional to the amount: GOAL_CENTS pays for MONTH_DAYS.
const DONATION = {
  minCents: 50,
  maxCents: 20000,
  goalCents: 2250,
  monthDays: 30,
};

const FREE_LIMITS = { maxHosts: 2, maxTunnels: 2 };
const UNLIMITED = 999999;

// ── Remote access (donor) ────────────────────────────────────────────────────
// Raw-port tunnels (SSH, ADB, …) publish a real TCP port on the server so
// binary protocols work end-to-end. Donors and the site owner only.
const REMOTE_PROTOCOLS = ['ssh', 'adb'];

/** Is this tunnel protocol a donor-only raw-port (SSH/ADB) tunnel? */
function isRemoteProtocol(protocol) {
  return REMOTE_PROTOCOLS.includes(String(protocol || '').toLowerCase());
}

/** Is this user the site owner or an admin? Owners get donor privileges free. */
function isOwner(user) {
  return !!(user && (user.is_site_owner || user.is_admin || user.role === 'site_owner' || user.role === 'admin'));
}

/** Does the user have an active donation window? */
function isDonor(user) {
  return !!(user && user.bonus_expires_at && new Date(user.bonus_expires_at) > new Date());
}

/** Does this user have remote access (SSH/ADB over a public port)? */
function hasRemoteAccess(user) {
  return isOwner(user) || isDonor(user);
}

/** Can this user nest tunnels/subdomains under others? Same as remote access. */
function canNest(user) {
  return hasRemoteAccess(user);
}

/** Hostname and tunnel limits for a user row. Donors and owners are unlimited. */
function limitsFor(user) {
  if (hasRemoteAccess(user)) return { hosts: UNLIMITED, tunnels: UNLIMITED };
  return { hosts: FREE_LIMITS.maxHosts, tunnels: FREE_LIMITS.maxTunnels };
}

/**
 * Days of donor access granted by a donation of `cents`:
 * $22.50 = 30 days, pro-rated. Always at least one day.
 */
function donationDays(cents) {
  return Math.max(1, Math.round((cents / DONATION.goalCents) * DONATION.monthDays));
}

module.exports = {
  DONATION, FREE_LIMITS, UNLIMITED,
  REMOTE_PROTOCOLS, isRemoteProtocol,
  isOwner, isDonor, hasRemoteAccess, canNest, limitsFor, donationDays,
};
