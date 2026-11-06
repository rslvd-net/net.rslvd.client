// Donation-only model. There are no subscriptions. Any donation grants donor
// access for a flat term of DONOR_DAYS (3 months).
const DONATION = {
  minCents: 100,
  maxCents: 20000,
  goalCents: 2250,
  donorDays: 90,
};

// Free accounts get FREE_LIMITS.maxHosts hostnames and FREE_LIMITS.maxTunnels
// general (tcp/udp) tunnels, plus one raw-port tunnel per protocol in
// FREE_LIMITS.remote — currently one SSH and one ADB. The remote ones are
// counted separately, so a free account can hold 2 + 1 + 1 = 4 tunnels.
const FREE_LIMITS = {
  maxHosts: 2,
  maxTunnels: 2,
  remote: { ssh: 1, adb: 1 },
};

const UNLIMITED = 999999;

// ── Remote access (SSH, ADB, …) ──────────────────────────────────────────────
// Raw-port tunnels publish a real TCP port on the server so binary protocols
// work end-to-end: one SSH and one ADB tunnel on free accounts, unlimited for
// donors and the site owner.
const REMOTE_PROTOCOLS = ['ssh', 'adb'];

/** Is this tunnel protocol a raw-port (SSH/ADB) tunnel? */
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

/** Does this user have unlimited remote access (SSH/ADB over a public port)? */
function hasRemoteAccess(user) {
  return isOwner(user) || isDonor(user);
}

/** Can this user nest tunnels/subdomains under others? Donors and owners only. */
function canNest(user) {
  return hasRemoteAccess(user);
}

/** Free allowance of raw-port tunnels for one protocol (0 if it has none). */
function freeRemoteQuota(protocol) {
  return FREE_LIMITS.remote[String(protocol || '').toLowerCase()] || 0;
}

/** How many raw-port tunnels of this protocol may the user hold? */
function remoteQuotaFor(user, protocol) {
  if (hasRemoteAccess(user)) return UNLIMITED;
  return freeRemoteQuota(protocol);
}

/**
 * May the user hold a raw-port tunnel of this protocol? `currentCount` is the
 * number of that user's active tunnels already using it (excluding the one
 * being created), so a free account accepts the first SSH and rejects the next.
 */
function canUseRemoteProtocol(user, protocol, currentCount = 0) {
  return Number(currentCount) < remoteQuotaFor(user, protocol);
}

/** Hostname and tunnel limits for a user row. Donors and owners are unlimited. */
function limitsFor(user) {
  if (hasRemoteAccess(user)) {
    return {
      hosts: UNLIMITED,
      tunnels: UNLIMITED,
      remote: { ssh: UNLIMITED, adb: UNLIMITED },
    };
  }
  return {
    hosts: FREE_LIMITS.maxHosts,
    tunnels: FREE_LIMITS.maxTunnels,
    remote: { ...FREE_LIMITS.remote },
  };
}

/** How many tunnels of this protocol may the user hold? */
function tunnelLimitFor(user, protocol) {
  if (isRemoteProtocol(protocol)) return remoteQuotaFor(user, protocol);
  return limitsFor(user).tunnels;
}

/** Days of donor access granted by any donation: a flat 3 months (90 days). */
function donationDays() {
  return DONATION.donorDays;
}

module.exports = {
  DONATION, FREE_LIMITS, UNLIMITED,
  REMOTE_PROTOCOLS, isRemoteProtocol,
  isOwner, isDonor, hasRemoteAccess, canNest, limitsFor,
  freeRemoteQuota, remoteQuotaFor, canUseRemoteProtocol, tunnelLimitFor,
  donationDays,
};
