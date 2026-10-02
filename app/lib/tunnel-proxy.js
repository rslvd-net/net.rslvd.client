/**
 * rslvd Multi-Protocol Tunnel Proxy
 *
 * Supports TCP, UDP, and DNS2TCP tunnels
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
 * DNS2TCP (port 7200):
 *   DNS server on port 7200 (UDP/TCP)
 *   Encodes TCP data in DNS TXT queries/responses
 *   Bypasses captive portals and restrictive firewalls
 */

const net  = require('net');
const dgram = require('dgram');
const pool = require('../db/pool');

// Base32hex (RFC 4648) decoder — matches Go's base32.HexEncoding used by the tunnel client
const B32HEX = '0123456789ABCDEFGHIJKLMNOPQRSTUV';
function decodeBase32Hex(str) {
  str = str.replace(/=+$/, '').toUpperCase();
  const out = [];
  let bits = 0, value = 0;
  for (const ch of str) {
    const idx = B32HEX.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
  }
  return Buffer.from(out);
}

// TCP Tunnel ports
const TCP_CONTROL_PORT = 7000;
const TCP_DATA_PORT    = 7001;
const TCP_PUBLIC_PORT  = 8080;

// UDP Tunnel ports
const UDP_CONTROL_PORT = 7100;
const UDP_DATA_PORT    = 7101;

// DNS2TCP port
const DNS2TCP_PORT = 7200;

// fqdn → { token, protocol, controlConn, pendingDataConns: [], udpClientAddr }
const clients = new Map();
// token → fqdn (reverse index)
const tokenToFqdn = new Map();

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
      'SELECT id, fqdn, protocol, status, device_lock, bound_device FROM tunnels WHERE token = $1 AND active = TRUE',
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

  clients.set(fqdn, { token, protocol, controlConn: conn, pendingDataConns: [], udpClientAddr: null });
  tokenToFqdn.set(token, fqdn);

  pool.query('UPDATE tunnels SET status = $1 WHERE token = $2', ['active', token]).catch(() => {});
  sendLine(conn, 'OK');
  log(`TCP Tunnel registered: ${fqdn} (${protocol})`);

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
    const entry = clients.get(fqdn);
    if (entry && entry.controlConn === conn) {
      for (const pc of entry.pendingDataConns) { try { pc.destroy(); } catch (_) {} }
      clients.delete(fqdn);
      tokenToFqdn.delete(token);
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
    if (!entry) {
      publicConn.resume();
      publicConn.write(
        'HTTP/1.1 502 No Tunnel\r\n' +
        'Content-Type: text/plain\r\n' +
        'Connection: close\r\n\r\n' +
        `No tunnel is connected for ${fqdn}\n`
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

// ── DNS2TCP Server (port 7200) ─────────────────────────────────────────────────
//
// DNS2TCP is a reverse tunnel that transports data inside DNS queries/responses.
// Useful when the client is behind a firewall that only allows DNS traffic.
//
// Protocol:
//   Client → Server: DNS query with QNAME = <base32data>.<token>.tunnel.rslvd.net
//   Server → Client: Raw response prefixed with type byte:
//     0x00 = NOOP (no pending data)
//     0x01 = DATA follows (rest of packet is TCP data from public connection)
//     0x02 = CONNECT (new public connection arrived)
//     0x03 = CLOSE (public connection closed)
//
// Flow:
//   1. Client sends HELLO query (no data) to register
//   2. Server creates public TCP listener on tunnel_port
//   3. Public connection arrives → server buffers data, signals client on next poll
//   4. Client polls (empty queries) → server responds with buffered data
//   5. Client forwards data to local service, sends response back via DNS query
//   6. Server forwards response to public connection

const dns2tcpSocket = dgram.createSocket('udp4');

// token -> { clientAddr, tunnelPort, fqdn, publicListener, connections: Map<connId, {socket, recvBuf, sendBuf}> }
const dns2tcpSessions = new Map();

// Response type bytes
const DNS_NOOP    = 0x00;
const DNS_DATA    = 0x01;
const DNS_CONNECT = 0x02;
const DNS_CLOSE   = 0x03;

function parseDNSQuery(msg) {
  try {
    if (msg.length < 12) return null;
    // Extract transaction ID for response
    const txId = msg.readUInt16BE(0);

    // Parse QNAME labels
    let offset = 12;
    const labels = [];
    while (offset < msg.length) {
      const len = msg[offset];
      if (len === 0) break;
      if (len > 63) return null;
      labels.push(msg.slice(offset + 1, offset + 1 + len).toString('ascii'));
      offset += 1 + len;
    }

    // Find 'tunnel' marker in labels
    const tunnelIdx = labels.indexOf('tunnel');
    if (tunnelIdx < 1) return null;

    const token = labels[tunnelIdx - 1];
    // Data labels are everything before the token
    let data = null;
    if (tunnelIdx > 1) {
      const dataStr = labels.slice(0, tunnelIdx - 1).join('');
      data = decodeBase32Hex(dataStr);
    }

    return { token, data, txId };
  } catch (e) {
    return null;
  }
}

function buildDNSResponse(txId, typeByte, payload) {
  // Build a minimal response: txId + type byte + payload
  // We use a simplified non-DNS format since the client knows to expect our protocol
  const header = Buffer.alloc(3);
  header.writeUInt16BE(txId, 0);
  header[2] = typeByte;
  if (payload && payload.length > 0) {
    return Buffer.concat([header, payload]);
  }
  return header;
}

dns2tcpSocket.on('message', async (msg, rinfo) => {
  const query = parseDNSQuery(msg);
  if (!query) return;

  const { token, data, txId } = query;
  let session = dns2tcpSessions.get(token);

  if (!session) {
    // New session registration — validate token
    let row;
    try {
      const result = await pool.query(
        'SELECT id, fqdn, tunnel_port, device_lock FROM tunnels WHERE token = $1 AND active = TRUE',
        [token]
      );
      row = result.rows[0];
    } catch (e) {
      return;
    }
    if (!row) return;
    // DNS2TCP queries can't carry a device fingerprint — locked tunnels must use TCP/UDP
    if (row.device_lock) {
      log(`DNS2TCP registration refused for ${row.fqdn}: device lock enabled`);
      return;
    }

    const fqdn = row.fqdn;
    const tunnelPort = row.tunnel_port;

    // Create session
    session = {
      clientAddr: rinfo,
      tunnelPort,
      fqdn,
      publicListener: null,
      connections: new Map(),
      nextConnId: 1,
      outQueue: []  // Queued messages to send to client: { type, connId, data }
    };
    dns2tcpSessions.set(token, session);
    tokenToFqdn.set(token, fqdn);
    clients.set(fqdn, { token, protocol: 'dns2tcp', controlConn: null, pendingDataConns: [] });

    pool.query('UPDATE tunnels SET status = $1 WHERE token = $2', ['active', token]).catch(() => {});
    log(`DNS2TCP Tunnel registered: ${fqdn} on port ${tunnelPort}`);

    // Start public TCP listener on tunnel_port
    const pubServer = net.createServer((pubConn) => {
      const connId = session.nextConnId++;
      session.connections.set(connId, { socket: pubConn, recvBuf: Buffer.alloc(0) });

      // Signal client: new connection
      session.outQueue.push({ type: DNS_CONNECT, connId, data: Buffer.alloc(0) });

      pubConn.on('data', (chunk) => {
        // Queue data for delivery to client on next poll
        session.outQueue.push({ type: DNS_DATA, connId, data: chunk });
      });

      pubConn.on('close', () => {
        session.connections.delete(connId);
        session.outQueue.push({ type: DNS_CLOSE, connId, data: Buffer.alloc(0) });
      });

      pubConn.on('error', () => {
        session.connections.delete(connId);
      });
    });

    pubServer.listen(tunnelPort, '0.0.0.0', () => {
      log(`DNS2TCP public listener on :${tunnelPort} for ${fqdn}`);
    });
    pubServer.on('error', (err) => log(`DNS2TCP public listener error: ${err.message}`));
    session.publicListener = pubServer;
  }

  // Update client address (may change between polls)
  session.clientAddr = rinfo;

  if (data && data.length > 0) {
    // Client is sending data back — first 2 bytes are connId, rest is payload
    if (data.length >= 3) {
      const connId = data.readUInt16BE(0);
      const payload = data.slice(2);
      const conn = session.connections.get(connId);
      if (conn && conn.socket.writable) {
        conn.socket.write(payload);
      }
    }
  }

  // Respond with next queued message (or NOOP if nothing pending)
  if (session.outQueue.length > 0) {
    const item = session.outQueue.shift();
    // Response format: [txId 2B][type 1B][connId 2B][payload...]
    const connIdBuf = Buffer.alloc(2);
    connIdBuf.writeUInt16BE(item.connId, 0);
    const payload = Buffer.concat([connIdBuf, item.data]);
    const response = buildDNSResponse(txId, item.type, payload);
    dns2tcpSocket.send(response, rinfo.port, rinfo.address);
  } else {
    const response = buildDNSResponse(txId, DNS_NOOP, null);
    dns2tcpSocket.send(response, rinfo.port, rinfo.address);
  }
});

dns2tcpSocket.on('error', (err) => log(`DNS2TCP error: ${err.message}`));

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
  
  // DNS2TCP server
  dns2tcpSocket.bind(DNS2TCP_PORT, '0.0.0.0', () => {
    log(`DNS2TCP server listening on :${DNS2TCP_PORT}`);
  });
  
  // Error handlers
  tcpControlServer.on('error', (e) => log(`TCP Control server error: ${e.message}`));
  tcpDataServer.on('error',    (e) => log(`TCP Data server error: ${e.message}`));
  tcpPublicServer.on('error',  (e) => log(`TCP Public server error: ${e.message}`));
}

// Live check: is a tunnel agent currently attached for this fqdn?
function isConnected(fqdn) {
  if (clients.has(fqdn)) return true;
  for (const s of dns2tcpSessions.values()) {
    if (s.fqdn === fqdn) return true;
  }
  return false;
}

module.exports = { startTunnelProxy, isConnected };
