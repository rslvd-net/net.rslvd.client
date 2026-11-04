/**
 * rslvd Multi-Protocol Tunnel Proxy
 *
 * Supports TCP, UDP, and raw remote-access (SSH/ADB) tunnels
 *
 * TCP Tunnels (ports 7000/7001):
 *   Control port 7000: tunnel clients connect, send "HELLO <token>\n"
 *   Data port 7001: for each inbound public connection, client opens data connection
 *   Public traffic port 8080: HTTP/WebSocket proxy routed by Host header
 *
 * UDP Tunnels (ports 7100/7101):
 *   Control port 7100: UDP registration with "HELLO <token>\n"
 *   Data port 7101: UDP packet relay between public and client
 *   Public UDP port 8081: receives UDP packets, routes by source address
 *
 * Remote Access Tunnels (premium — SSH, ADB):
 *   The tunnel's public TCP port (tunnel_port, 20000-29999) is bound directly
 *   on the server. Inbound bytes are piped to the client over the same
 *   7000/7001 control+data channel used by TCP tunnels, so binary protocols
 *   like SSH (port 22) and ADB (port 5555) work end-to-end.
 */

const net  = require('net');
const dgram = require('dgram');
const pool = require('../db/pool');
const { hasRemoteAccess } = require('./plans');

// TCP Tunnel ports
const TCP_CONTROL_PORT = 7000;
const TCP_DATA_PORT    = 7001;
const TCP_PUBLIC_PORT  = 8080;

// UDP Tunnel ports
const UDP_CONTROL_PORT = 7100;
const UDP_DATA_PORT    = 7101;

// Remote-access (raw port) tunnels
const RAW_PROTOCOLS = new Set(['ssh', 'adb', 'raw']);
const PORT_MIN = 20000;
const PORT_MAX = 29999;

// fqdn → { token, protocol, controlConn, pendingDataConns: [], udpClientAddr }
const clients = new Map();
// token → fqdn (reverse index)
const tokenToFqdn = new Map();
// fqdn → net.Server bound on the tunnel's public port (remote-access tunnels only)
const rawListeners = new Map();

function isRawProtocol(protocol) {
  return RAW_PROTOCOLS.has(String(protocol || '').toLowerCase());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEVICE_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

// Device-lock enforcement (trust-on-first-use).
// Returns { ok: true } or { ok: false, error }. Binds the device on first
// connect; afterwards only the bound device may use the token.
async function checkDeviceBinding(row, deviceId, deviceName) {
  if (!row.device_lock) return { ok: true };
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    return { ok: false, error: 'device lock enabled — update your rslvd-tunnel client' };
  }
  if (!row.bound_device) {
    const r = await pool.query(
      `UPDATE tunnels SET bound_device = $1, bound_device_name = $2, bound_at = NOW()
       WHERE id = $3 AND bound_device IS NULL RETURNING bound_device`,
      [deviceId, (deviceName || '').slice(0, 100) || null, row.id]
    );
    if (r.rows[0]) {
      log(`Device bound to tunnel ${row.fqdn}: ${deviceId}`);
      return { ok: true };
    }
    const fresh = await pool.query('SELECT bound_device FROM tunnels WHERE id = $1', [row.id]);
    row = { ...row, bound_device: fresh.rows[0] && fresh.rows[0].bound_device };
  }
  if (row.bound_device === deviceId) return { ok: true };
  return { ok: false, error: 'device not authorized for this tunnel (device lock)' };
}

function log(...args) {
  console.log(`[tunnel-proxy]`, ...args);
}

function sendLine(socket, line) {
  try { socket.write(line + '\n'); } catch (_) {}
}

function readLineRaw(socket, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      reject(new Error('handshake timeout'));
    }, timeoutMs);

    function finish(line, leftover) {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      resolve({ line: line.toString('utf8').replace(/\r$/, ''), leftover });
    }

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        const leftover = buf.slice(nl + 1);
        finish(line, leftover);
      }
    }
    function onError(err) {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      reject(err);
    }
    function onClose() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      reject(new Error('socket closed'));
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

// ── TCP Control Server (port 7000) ──────────────────────────────────────────────

const tcpControlServer = net.createServer(async (conn) => {
  conn.setKeepAlive(true, 30000);
  const remote = `${conn.remoteAddress}:${conn.remotePort}`;
  log(`TCP Control connect from ${remote}`);

  let helloLine;
  try {
    const { line } = await readLineRaw(conn);
    helloLine = line.trim();
  } catch (e) {
    conn.destroy();
    return;
  }

  if (!helloLine.startsWith('HELLO ')) {
    sendLine(conn, 'ERR expected HELLO');
    conn.destroy();
    return;
  }

  const helloParts = helloLine.slice(6).trim().split(/\s+/);
  const token = helloParts[0];
  const deviceId = helloParts[1] || null;
  const deviceName = helloParts.slice(2).join(' ') || null;

  let row;
  try {
    const result = await pool.query(
      `SELECT t.id, t.fqdn, t.protocol, t.status, t.device_lock, t.bound_device, t.tunnel_port,
              u.bonus_expires_at, u.is_site_owner, u.is_admin
       FROM tunnels t LEFT JOIN users u ON t.user_id = u.id
       WHERE t.token = $1 AND t.active = TRUE`,
      [token]
    );
    row = result.rows[0];
  } catch (e) {
    sendLine(conn, 'ERR database error');
    conn.destroy();
    return;
  }

  if (!row) {
    sendLine(conn, 'ERR invalid token');
    conn.destroy();
    return;
  }

  const isRemoteAccess = isRawProtocol(row.protocol);

  // Remote-access tunnels (SSH/ADB) are donor-only
  if (isRemoteAccess && !hasRemoteAccess(row)) {
    sendLine(conn, 'ERR remote access (SSH/ADB) requires a donation — see rslvd.net/donate');
    conn.destroy();
    return;
  }

  // Claim a public port for remote tunnels that don't have one yet
  let remotePort = row.tunnel_port;
  if (isRemoteAccess) {
    if (!remotePort) {
      remotePort = await allocateRemotePort();
      if (!remotePort) {
        sendLine(conn, 'ERR no free public ports on server');
        conn.destroy();
        return;
      }
      try {
        await pool.query('UPDATE tunnels SET tunnel_port = $1 WHERE id = $2', [remotePort, row.id]);
      } catch (e) {
        console.error('[tunnel-proxy] port assignment failed:', e.message);
      }
    }
    log(`Remote ${row.protocol} tunnel: ${row.fqdn} on public port ${remotePort}`);
  }

  try {
    const bind = await checkDeviceBinding(row, deviceId, deviceName);
    if (!bind.ok) {
      sendLine(conn, `ERR ${bind.error}`);
      conn.destroy();
      return;
    }
  } catch (e) {
    sendLine(conn, 'ERR database error');
    conn.destroy();
    return;
  }

  const fqdn = row.fqdn;
  const protocol = row.protocol || 'tcp';

  // Kick existing client for same fqdn
  if (clients.has(fqdn)) {
    const existing = clients.get(fqdn);
    try { existing.controlConn.destroy(); } catch (_) {}
    tokenToFqdn.delete(existing.token);
  }

  const entry = { token, protocol, controlConn: conn, pendingDataConns: [], udpClientAddr: null };
  clients.set(fqdn, entry);
  tokenToFqdn.set(token, fqdn);

  if (isRemoteAccess) startRawListener(fqdn, entry, remotePort);

  pool.query('UPDATE tunnels SET status = $1 WHERE token = $2', ['active', token]).catch(() => {});
  sendLine(conn, isRemoteAccess ? `OK ${remotePort}` : 'OK');
  log(`TCP Tunnel registered: ${fqdn} (${protocol}${isRemoteAccess ? `, public port ${remotePort}` : ''})`);

  // Keepalive
  let pingBuf = Buffer.alloc(0);
  conn.on('data', (chunk) => {
    pingBuf = Buffer.concat([pingBuf, chunk]);
    let nl;
    while ((nl = pingBuf.indexOf(0x0a)) !== -1) {
      const msg = pingBuf.slice(0, nl).toString('utf8').trim();
      pingBuf = pingBuf.slice(nl + 1);
      if (msg === 'PING') sendLine(conn, 'PONG');
    }
  });

  conn.on('close', () => {
    log(`TCP Control disconnect: ${fqdn}`);
    const live = clients.get(fqdn);
    if (live && live.controlConn === conn) {
      for (const pc of live.pendingDataConns) { try { pc.destroy(); } catch (_) {} }
      clients.delete(fqdn);
      tokenToFqdn.delete(token);
      if (isRemoteAccess) stopRawListener(fqdn);
      pool.query('UPDATE tunnels SET status = $1 WHERE token = $2', ['inactive', token]).catch(() => {});
    }
  });

  conn.on('error', (err) => log(`TCP Control error ${fqdn}: ${err.message}`));
});

// ── TCP Data Server (port 7001) ─────────────────────────────────────────────────

const tcpDataServer = net.createServer(async (dataConn) => {
  dataConn.setKeepAlive(true, 10000);

  let dataLine, leftover;
  try {
    ({ line: dataLine, leftover } = await readLineRaw(dataConn, 10000));
    dataLine = dataLine.trim();
  } catch (e) {
    dataConn.destroy();
    return;
  }

  if (!dataLine.startsWith('DATA ')) {
    dataConn.destroy();
    return;
  }

  const token = dataLine.slice(5).trim();
  const fqdn  = tokenToFqdn.get(token);
  const entry = fqdn && clients.get(fqdn);
  if (!entry || entry.pendingDataConns.length === 0) {
    dataConn.destroy();
    return;
  }

  const { publicConn, headBytes } = entry.pendingDataConns.shift();

  sendLine(dataConn, 'GO');
  publicConn.resume();

  if (headBytes && headBytes.length > 0) dataConn.write(headBytes);
  if (leftover  && leftover.length  > 0) publicConn.write(leftover);

  dataConn.pipe(publicConn);
  publicConn.pipe(dataConn);

  publicConn.on('close', () => { try { dataConn.destroy();   } catch (_) {} });
  dataConn.on('close',   () => { try { publicConn.destroy(); } catch (_) {} });
  publicConn.on('error', () => { try { dataConn.destroy();   } catch (_) {} });
  dataConn.on('error',   () => { try { publicConn.destroy(); } catch (_) {} });
});

// ── Remote-Access Tunnels (SSH / ADB) ─────────────────────────────────────────
// Premium tunnels own a real public TCP port on this host. Each inbound
// connection is handed to the client through the normal CONNECT/DATA dance.

/** First free public port in the remote-access range, or null when exhausted. */
async function allocateRemotePort() {
  const usedPorts = new Set();
  try {
    const used = await pool.query('SELECT tunnel_port FROM tunnels WHERE tunnel_port IS NOT NULL');
    for (const r of used.rows) usedPorts.add(r.tunnel_port);
  } catch (e) {
    log(`Port lookup failed: ${e.message}`);
  }
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!usedPorts.has(p)) return p;
  }
  return null;
}

/** Bind the public port for a remote tunnel; each connection → CONNECT + data channel. */
function startRawListener(fqdn, entry, port) {
  stopRawListener(fqdn);

  const server = net.createServer((publicConn) => {
    const live = clients.get(fqdn);
    if (!live || live.controlConn !== entry.controlConn) {
      publicConn.destroy();
      return;
    }

    publicConn.setKeepAlive(true, 30000);
    publicConn.pause();
    sendLine(live.controlConn, 'CONNECT');
    live.pendingDataConns.push({ publicConn, headBytes: null });

    setTimeout(() => {
      const idx = live.pendingDataConns.findIndex((p) => p.publicConn === publicConn);
      if (idx !== -1) {
        live.pendingDataConns.splice(idx, 1);
        try { publicConn.destroy(); } catch (_) {}
      }
    }, 10000);
  });

  server.on('error', (err) => log(`Remote listener ${fqdn}:${port} error: ${err.message}`));
  server.listen(port, '0.0.0.0', () => {
    log(`Remote ${entry.protocol.toUpperCase()} tunnel ready: ${fqdn} → rslvd.net:${port}`);
  });
  rawListeners.set(fqdn, server);
}

function stopRawListener(fqdn) {
  const server = rawListeners.get(fqdn);
  if (!server) return;
  rawListeners.delete(fqdn);
  try { server.close(); } catch (_) {}
}

// ── TCP Public HTTP/WS Proxy (port 8080) ──────────────────────────────────────

const tcpPublicServer = net.createServer(async (publicConn) => {
  publicConn.pause();

  let buf = Buffer.alloc(0);
  let fqdn = null;
  const TIMEOUT = 10000;

  const timer = setTimeout(() => {
    if (!fqdn) { publicConn.destroy(); }
  }, TIMEOUT);

  function tryRoute() {
    const text = buf.toString('ascii');
    const m = text.match(/^Host:\s*([^\r\n:]+)/im);
    if (!m) {
      if (buf.length > 8192) {
        clearTimeout(timer);
        publicConn.destroy();
      }
      return;
    }

    clearTimeout(timer);
    publicConn.removeListener('data', onData);
    publicConn.removeListener('error', onError);

    fqdn = m[1].trim().toLowerCase();

    const entry = clients.get(fqdn);
    // SSH/ADB tunnels own a raw public port — they are not reachable over HTTP
    if (!entry || entry.protocol !== 'tcp') {
      publicConn.resume();
      const why = entry
        ? `${fqdn} is a ${entry.protocol.toUpperCase()} (remote access) tunnel — connect to the port shown in your dashboard instead of HTTP.\n`
        : `No tunnel is connected for ${fqdn}\n`;
      publicConn.write(
        'HTTP/1.1 502 No Tunnel\r\n' +
        'Content-Type: text/plain\r\n' +
        'Connection: close\r\n\r\n' +
        why
      );
      publicConn.end();
      return;
    }

    sendLine(entry.controlConn, 'CONNECT');
    entry.pendingDataConns.push({ publicConn, headBytes: buf });

    setTimeout(() => {
      const idx = entry.pendingDataConns.findIndex(p => p.publicConn === publicConn);
      if (idx !== -1) {
        entry.pendingDataConns.splice(idx, 1);
        publicConn.destroy();
      }
    }, 10000);
  }

  function onData(chunk) {
    buf = Buffer.concat([buf, chunk]);
    tryRoute();
  }
  function onError() { clearTimeout(timer); }

  publicConn.on('data', onData);
  publicConn.on('error', onError);
  publicConn.resume();
});

// ── UDP Control Server (port 7100) ──────────────────────────────────────────────

const udpControlSocket = dgram.createSocket('udp4');

// Per-tunnel public UDP listeners: fqdn -> { socket, publicSenders: Map<senderKey, rinfo> }
const udpPublicListeners = new Map();

udpControlSocket.on('message', async (msg, rinfo) => {
  const msgStr = msg.toString('utf8').trim();

  if (msgStr === 'PING') {
    udpControlSocket.send('PONG\n', rinfo.port, rinfo.address);
    return;
  }

  if (!msgStr.startsWith('HELLO ')) return;

  const udpParts = msgStr.slice(6).trim().split(/\s+/);
  const token = udpParts[0];
  const udpDeviceId = udpParts[1] || null;
  const udpDeviceName = udpParts.slice(2).join(' ') || null;

  let row;
  try {
    const result = await pool.query(
      'SELECT id, fqdn, protocol, tunnel_port, device_lock, bound_device FROM tunnels WHERE token = $1 AND active = TRUE',
      [token]
    );
    row = result.rows[0];
  } catch (e) {
    udpControlSocket.send('ERR database\n', rinfo.port, rinfo.address);
    return;
  }

  if (!row) {
    udpControlSocket.send('ERR invalid token\n', rinfo.port, rinfo.address);
    return;
  }

  try {
    const bind = await checkDeviceBinding(row, udpDeviceId, udpDeviceName);
    if (!bind.ok) {
      udpControlSocket.send(`ERR ${bind.error}\n`, rinfo.port, rinfo.address);
      return;
    }
  } catch (e) {
    udpControlSocket.send('ERR database\n', rinfo.port, rinfo.address);
    return;
  }

  const fqdn = row.fqdn;
  const tunnelPort = row.tunnel_port;

  // Kick existing client for same fqdn
  const existing = clients.get(fqdn);
  if (existing && existing.protocol === 'udp') {
    // Close the old public listener
    const oldListener = udpPublicListeners.get(fqdn);
    if (oldListener) {
      try { oldListener.socket.close(); } catch (_) {}
      udpPublicListeners.delete(fqdn);
    }
  }

  // Store client entry
  clients.set(fqdn, {
    token,
    protocol: 'udp',
    controlConn: null,
    udpClientAddr: null,       // Set when client registers on data port
    udpControlAddr: { address: rinfo.address, port: rinfo.port },
    tunnelPort,
    pendingDataConns: []
  });
  tokenToFqdn.set(token, fqdn);

  pool.query('UPDATE tunnels SET status = $1 WHERE token = $2', ['active', token]).catch(() => {});
  udpControlSocket.send(`OK ${tunnelPort}\n`, rinfo.port, rinfo.address);
  log(`UDP Tunnel registered: ${fqdn} on port ${tunnelPort}`);
});

udpControlSocket.on('error', (err) => log(`UDP Control error: ${err.message}`));

// ── UDP Data Server (port 7101) ─────────────────────────────────────────────────
// Client authenticates with "DATA <token>\n" then all subsequent packets are relayed

const udpDataSocket = dgram.createSocket('udp4');
// clientDataAddr -> { fqdn, token }
const udpDataSessions = new Map();

udpDataSocket.on('message', (msg, rinfo) => {
  const senderKey = `${rinfo.address}:${rinfo.port}`;

  // Check if this is an already-authenticated data session
  const session = udpDataSessions.get(senderKey);

  if (session) {
    // Data from tunnel client → forward to the original public sender
    session.lastSeen = Date.now();
    const listener = udpPublicListeners.get(session.fqdn);
    if (!listener) return;

    // The first 6 bytes are the sender key (4 bytes IP + 2 bytes port) for routing
    if (msg.length < 7) return;
    const ipBytes = msg.slice(0, 4);
    const portNum = msg.readUInt16BE(4);
    const payload = msg.slice(6);
    const destAddr = `${ipBytes[0]}.${ipBytes[1]}.${ipBytes[2]}.${ipBytes[3]}`;
    listener.socket.send(payload, portNum, destAddr);
    return;
  }

  // New data connection — expect "DATA <token>\n"
  const msgStr = msg.toString('utf8').trim();
  if (!msgStr.startsWith('DATA ')) return;

  const token = msgStr.slice(5).trim();
  const fqdn = tokenToFqdn.get(token);
  const entry = fqdn && clients.get(fqdn);
  if (!entry || entry.protocol !== 'udp') return;

  // Register client's data address
  entry.udpClientAddr = { address: rinfo.address, port: rinfo.port };
  udpDataSessions.set(senderKey, { fqdn, token, lastSeen: Date.now() });

  // Now start the public-facing UDP listener on the tunnel's assigned port
  if (!udpPublicListeners.has(fqdn)) {
    const pubSocket = dgram.createSocket('udp4');
    const publicSenders = new Map();
    udpPublicListeners.set(fqdn, { socket: pubSocket, publicSenders });

    pubSocket.on('message', (pubMsg, pubRinfo) => {
      // Forward public packet to tunnel client with sender info header
      // Header: 4 bytes sender IP + 2 bytes sender port
      const ipParts = pubRinfo.address.split('.').map(Number);
      const header = Buffer.alloc(6);
      header[0] = ipParts[0]; header[1] = ipParts[1];
      header[2] = ipParts[2]; header[3] = ipParts[3];
      header.writeUInt16BE(pubRinfo.port, 4);

      const framed = Buffer.concat([header, pubMsg]);
      udpDataSocket.send(framed, entry.udpClientAddr.port, entry.udpClientAddr.address);
    });

    pubSocket.on('error', (err) => {
      log(`UDP public listener error (${fqdn}): ${err.message}`);
    });

    pubSocket.bind(entry.tunnelPort, '0.0.0.0', () => {
      log(`UDP public listener started on :${entry.tunnelPort} for ${fqdn}`);
    });
  }

  udpDataSocket.send('GO\n', rinfo.port, rinfo.address);
  log(`UDP Data session: ${fqdn} client at ${senderKey}`);
});

udpDataSocket.on('error', (err) => log(`UDP Data error: ${err.message}`));

// ── Start ─────────────────────────────────────────────────────────────────────

function startTunnelProxy() {
  // TCP servers
  tcpControlServer.listen(TCP_CONTROL_PORT, '0.0.0.0', () => {
    log(`TCP Control server listening on :${TCP_CONTROL_PORT}`);
  });
  tcpDataServer.listen(TCP_DATA_PORT, '0.0.0.0', () => {
    log(`TCP Data server listening on :${TCP_DATA_PORT}`);
  });
  tcpPublicServer.listen(TCP_PUBLIC_PORT, '127.0.0.1', () => {
    log(`TCP Public proxy listening on :${TCP_PUBLIC_PORT}`);
  });
  
  // UDP servers
  udpControlSocket.bind(UDP_CONTROL_PORT, '0.0.0.0', () => {
    log(`UDP Control server listening on :${UDP_CONTROL_PORT}`);
  });
  udpDataSocket.bind(UDP_DATA_PORT, '0.0.0.0', () => {
    log(`UDP Data server listening on :${UDP_DATA_PORT}`);
  });
  
  
  // Error handlers
  tcpControlServer.on('error', (e) => log(`TCP Control server error: ${e.message}`));
  tcpDataServer.on('error',    (e) => log(`TCP Data server error: ${e.message}`));
  tcpPublicServer.on('error',  (e) => log(`TCP Public server error: ${e.message}`));
}

// Live check: is a tunnel agent currently attached for this fqdn?
function isConnected(fqdn) {
  return clients.has(fqdn);
}

module.exports = { startTunnelProxy, isConnected };
