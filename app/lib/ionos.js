const axios = require('axios');

const BASE_URL = 'https://api.hosting.ionos.com/dns/v1';
const API_KEY = process.env.IONOS_API_KEY;

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

async function getZones() {
  const res = await client.get('/zones');
  return res.data;
}

async function getZone(zoneId) {
  const res = await client.get(`/zones/${zoneId}`);
  return res.data;
}

async function findZoneForDomain(domain) {
  const zones = await getZones();
  // Find zone matching rslvd.net
  return zones.find(z => domain.endsWith(z.name) || z.name === process.env.BASE_DOMAIN);
}

async function createRecord(zoneId, name, type, content, ttl = 60) {
  const res = await client.post(`/zones/${zoneId}/records`, [{
    name,
    type,
    content,
    ttl,
    prio: 0,
    disabled: false,
  }]);
  return res.data[0];
}

async function updateRecord(zoneId, recordId, name, type, content, ttl = 60) {
  const res = await client.put(`/zones/${zoneId}/records/${recordId}`, {
    name,
    type,
    content,
    ttl,
    prio: 0,
    disabled: false,
  });
  return res.data;
}

async function deleteRecord(zoneId, recordId) {
  await client.delete(`/zones/${zoneId}/records/${recordId}`);
}

async function upsertRecord(hostname, type, ip) {
  const zones = await getZones();
  const zone = zones.find(z => z.name === process.env.BASE_DOMAIN);
  if (!zone) throw new Error(`Zone ${process.env.BASE_DOMAIN} not found in IONOS`);

  const zoneDetail = await getZone(zone.id);
  const existing = (zoneDetail.records || []).find(
    r => r.name === hostname && r.type === type
  );

  if (existing) {
    if (existing.content !== ip) {
      await updateRecord(zone.id, existing.id, hostname, type, ip);
    }
    return { action: existing.content !== ip ? 'updated' : 'unchanged', recordId: existing.id };
  } else {
    const rec = await createRecord(zone.id, hostname, type, ip);
    return { action: 'created', recordId: rec.id };
  }
}

async function removeRecord(recordId) {
  const zones = await getZones();
  const zone = zones.find(z => z.name === process.env.BASE_DOMAIN);
  if (!zone) return;
  await deleteRecord(zone.id, recordId);
}

module.exports = { getZones, getZone, upsertRecord, removeRecord, findZoneForDomain };
