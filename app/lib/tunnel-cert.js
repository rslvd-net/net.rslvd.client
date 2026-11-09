const { spawn } = require('child_process');

const PROVISION_SCRIPT = '/opt/rslvd/scripts/provision-tunnel-cert.sh';
const DEPROVISION_SCRIPT = '/opt/rslvd/scripts/deprovision-tunnel-cert.sh';
const ENABLE_HTTP_SCRIPT = '/opt/rslvd/scripts/enable-http-fallback.sh';
const DISABLE_HTTP_SCRIPT = '/opt/rslvd/scripts/disable-http-fallback.sh';

// A nested tunnel FQDN has more labels than "<single-level>.<base>".
// e.g. base = rslvd.net (2 labels). Single-level = name.rslvd.net (3 labels,
// covered by the *.rslvd.net wildcard cert). Nested = sub.name.rslvd.net (4+),
// which is NOT covered by the wildcard and needs its own cert.
function isNested(fqdn) {
  const base = process.env.BASE_DOMAIN || 'rslvd.net';
  const baseLabels = base.split('.').length;
  return fqdn.split('.').length > baseLabels + 1;
}

// Fire-and-forget: cert issuance via DNS-01 takes ~30-60s, so we never block
// the HTTP response. Progress is logged to /var/log/tunnel-cert.log on the host.
function provisionCert(fqdn) {
  if (!isNested(fqdn)) return; // single-level is covered by the wildcard cert
  try {
    const child = spawn('sudo', [PROVISION_SCRIPT, fqdn], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (e) => console.error(`[tunnel-cert] provision spawn failed for ${fqdn}:`, e.message));
    child.unref();
    console.log(`[tunnel-cert] provisioning started for ${fqdn}`);
  } catch (e) {
    console.error(`[tunnel-cert] provision error for ${fqdn}:`, e.message);
  }
}

function deprovisionCert(fqdn) {
  if (!isNested(fqdn)) return;
  try {
    const child = spawn('sudo', [DEPROVISION_SCRIPT, fqdn], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (e) => console.error(`[tunnel-cert] deprovision spawn failed for ${fqdn}:`, e.message));
    child.unref();
    console.log(`[tunnel-cert] deprovisioning started for ${fqdn}`);
  } catch (e) {
    console.error(`[tunnel-cert] deprovision error for ${fqdn}:`, e.message);
  }
}

function enableHttpFallback(fqdn) {
  try {
    const child = spawn('sudo', [ENABLE_HTTP_SCRIPT, fqdn], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (e) => console.error(`[http-fallback] enable spawn failed for ${fqdn}:`, e.message));
    child.unref();
    console.log(`[http-fallback] enabling HTTP for ${fqdn}`);
  } catch (e) {
    console.error(`[http-fallback] enable error for ${fqdn}:`, e.message);
  }
}

function disableHttpFallback(fqdn) {
  try {
    const child = spawn('sudo', [DISABLE_HTTP_SCRIPT, fqdn], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (e) => console.error(`[http-fallback] disable spawn failed for ${fqdn}:`, e.message));
    child.unref();
    console.log(`[http-fallback] disabling HTTP fallback for ${fqdn}`);
  } catch (e) {
    console.error(`[http-fallback] disable error for ${fqdn}:`, e.message);
  }
}

module.exports = { provisionCert, deprovisionCert, isNested, enableHttpFallback, disableHttpFallback };
