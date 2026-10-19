// rslvd.privatedns.org Service Worker — offline shell + DDNS background sync

const CACHE_NAME = 'rslvd-v1';
const SHELL_ASSETS = [
  '/',
  '/app2.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── Install: cache app shell ────────────────────────────────────────────────

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clear old caches ──────────────────────────────────────────────

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API, cache-first for shell ─────────────────────

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API requests: always network
  if (url.pathname.startsWith('/api/')) return;

  // App shell: cache-first, fallback to network
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// ── Periodic Background Sync: DDNS auto-update ─────────────────────────────

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'ddns-update') {
    e.waitUntil(performDDNSUpdate());
  }
});

async function performDDNSUpdate() {
  try {
    // Read saved DDNS config from IndexedDB
    const config = await getFromIDB('ddns-config');
    if (!config || !config.hosts || config.hosts.length === 0) return;

    // Detect current public IP
    const ipRes = await fetch('/api/ip');
    if (!ipRes.ok) return;
    const { ip } = await ipRes.json();
    if (!ip) return;

    // Update each enabled host
    for (const host of config.hosts) {
      if (!host.updateKey || !host.enabled) continue;

      // Skip if IP hasn't changed
      if (host.lastIp === ip) continue;

      const updateRes = await fetch(`/api/update?key=${encodeURIComponent(host.updateKey)}&ip=${encodeURIComponent(ip)}`);
      if (updateRes.ok) {
        host.lastIp = ip;
        host.lastUpdate = Date.now();
      }
    }

    // Save updated config (with lastIp)
    await putToIDB('ddns-config', config);

    // Notify user if IP changed
    const clients = await self.clients.matchAll();
    if (clients.length > 0) {
      clients.forEach(client => client.postMessage({ type: 'ddns-updated', ip }));
    }
  } catch (err) {
    // Silent fail — will retry on next sync
  }
}

// ── IndexedDB helpers for persistent config ─────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rslvd-sw', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getFromIDB(key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function putToIDB(key, value) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
