// Donation-only model. There are no subscriptions. Any donation grants donor
// access for a flat term of DONOR_DAYS (3 months).
const DONATION = {
  minCents: 100,
  maxCents: 20000,
  goalCents: 2250,
  donorDays: 90,
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

/** Days of donor access granted by any donation: a flat 3 months (90 days). */
function donationDays() {
  return DONATION.donorDays;
}

module.exports = {
  DONATION, FREE_LIMITS, UNLIMITED,
  REMOTE_PROTOCOLS, isRemoteProtocol,
  isOwner, isDonor, hasRemoteAccess, canNest, limitsFor, donationDays,
};
