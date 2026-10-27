// Paid plan definitions. Amounts are in USD cents; period is in days.
const PLANS = {
  monthly:     { label: 'Monthly',   amount: '$0.99/mo',  amountCents: 99,  periodDays: 30,  maxHosts: 4,      maxTunnels: 4 },
  quarterly:   { label: 'Quarterly', amount: '$1.99/3mo', amountCents: 199, periodDays: 91,  maxHosts: 12,     maxTunnels: 12 },
  semi_annual: { label: '6 Months',  amount: '$4.99/6mo', amountCents: 499, periodDays: 182, maxHosts: 24,     maxTunnels: 24 },
  annual:      { label: 'Annual',    amount: '$8.99/yr',  amountCents: 899, periodDays: 365, maxHosts: 999999, maxTunnels: 999999 },
};

// Pay-what-you-want donations. Every DONATION.centsPerSlot grants +1 bonus
// hostname slot and +1 bonus tunnel slot for DONATION.periodDays.
const DONATION = {
  minCents: 50,
  maxCents: 20000,
  centsPerSlot: 50,
  periodDays: 30,
  maxBonusSlots: 100,
};

// ── Remote access (premium) ──────────────────────────────────────────────────
// Raw-port tunnels (SSH, ADB, …) publish a real TCP port on the server so
// binary protocols work end-to-end. Any paid plan unlocks them.
const PAID_PLAN_KEYS = ['monthly', 'quarterly', 'semi_annual', 'annual'];
const REMOTE_PROTOCOLS = ['ssh', 'adb'];

/** Is this tunnel protocol a premium raw-port (SSH/ADB) tunnel? */
function isRemoteProtocol(protocol) {
  return REMOTE_PROTOCOLS.includes(String(protocol || '').toLowerCase());
}

/**
 * Does this user have remote access (SSH/ADB over a public port)?
 * True for any active paid plan and for site owners/admins. Accepts either a
 * request user row or the joined { plan, plan_expires_at, … } shape.
 */
function hasRemoteAccess(user) {
  if (!user) return false;
  if (user.is_site_owner || user.is_admin || user.role === 'site_owner' || user.role === 'admin') return true;
  if (!PAID_PLAN_KEYS.includes(user.plan)) return false;
  if (user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) return false;
  return true;
}

/** Currently-active donation bonus slots for a user row (0 when expired). */
function activeBonus(user) {
  const active = user && user.bonus_expires_at && new Date(user.bonus_expires_at) > new Date();
  return {
    hosts: active ? (user.bonus_hosts || 0) : 0,
    tunnels: active ? (user.bonus_tunnels || 0) : 0,
    expiresAt: active ? user.bonus_expires_at : null,
  };
}

module.exports = {
  PLANS, DONATION, activeBonus,
  PAID_PLAN_KEYS, REMOTE_PROTOCOLS, isRemoteProtocol, hasRemoteAccess,
};
