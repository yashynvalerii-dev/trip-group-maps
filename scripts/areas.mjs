// Trip Group offline area maps worker (GitHub Actions).
// Reads area orders from Firestore (top-level collection `areas`), cuts each circle out of the latest Protomaps
// daily build with `pmtiles extract`, puts the file into ./site/areas/<id>.pmtiles (published to gh-pages by the
// workflow) and — after publishing (`--finalize`) — marks the order "ready". Expired/orphaned areas are removed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';

export const PROJECT = 'tripgroup';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const PAGES = 'https://yashynvalerii-dev.github.io/trip-group-maps';
const DAY = 86400000, KEEP_MS = 30 * DAY, MAX_FILE = 95 * 1024 * 1024;
export const LIMITS = { activePerGroup: 5, ordersPerDay: 5, minKm: 2, maxKm: 25 };
const UPDATES = '/tmp/areas-updates.json';

// ---------- pure helpers (tested in check-areas.mjs) ----------
/** GeoJSON polygon approximating a circle (radius in km). */
export function circle(lat, lng, km, n = 64) {
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (i % n) / n * 2 * Math.PI;
    const dLat = km / 110.574 * Math.cos(a);
    const dLng = km / (111.320 * Math.cos(lat * Math.PI / 180)) * Math.sin(a);
    ring.push([+(lng + dLng).toFixed(6), +(lat + dLat).toFixed(6)]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}
/** Decide which requested orders may be built now (limits) → { build: [], reject: [{area, reason}] } */
export function triage(areas, now) {
  const active = a => ['ready', 'building', 'requested'].includes(a.status);
  const build = [], reject = [];
  const reqs = areas.filter(a => a.status === 'requested').sort((a, b) => a.requestedAt - b.requestedAt);
  const counted = areas.filter(a => active(a) && a.status !== 'requested');
  for (const a of reqs) {
    const sameGroup = counted.filter(x => x.gid === a.gid).length;
    const lastDay = [...counted, ...build].filter(x => x.requestedBy === a.requestedBy && now - (x.requestedAt || 0) < DAY).length;
    if (!(a.radiusKm >= LIMITS.minKm && a.radiusKm <= LIMITS.maxKm)) reject.push({ area: a, reason: 'radius' });
    else if (sameGroup >= LIMITS.activePerGroup) reject.push({ area: a, reason: 'limit-group' });
    else if (lastDay >= LIMITS.ordersPerDay) reject.push({ area: a, reason: 'limit-day' });
    else { build.push(a); counted.push(a); }
  }
  return { build, reject };
}
/** Server copy expiry: 30 days after the latest of build time and last use. */
export const expiresAt = a => Math.max(a.builtAt || 0, a.usedAt || 0, a.requestedAt || 0) + KEEP_MS;

// ---------- Firestore REST ----------
const token = () => process.env.FIRESTORE_TOKEN;
const dec = v => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue
  : 'booleanValue' in v ? v.booleanValue : 'timestampValue' in v ? Date.parse(v.timestampValue) : null;
const enc = v => typeof v === 'string' ? { stringValue: v } : Number.isInteger(v) ? { integerValue: String(v) }
  : typeof v === 'number' ? { doubleValue: v } : typeof v === 'boolean' ? { booleanValue: v } : { nullValue: null };
async function fs(method, path, body) {
  const r = await fetch(`${BASE}/${path}`, { method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  if (r.status === 404 && method === 'GET') return null;
  if (!r.ok) throw new Error(`Firestore ${method} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
}
async function listAreas() {
  const out = []; let pageToken = '';
  do {
    const j = await fs('GET', `areas?pageSize=300${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
    for (const d of j?.documents || []) out.push({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)])) });
    pageToken = j?.nextPageToken || '';
  } while (pageToken);
  return out;
}
async function patch(id, fields) {
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  await fs('PATCH', `areas/${id}?${mask}`, { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)])) });
}
const del = id => fs('DELETE', `areas/${id}`);
const groupExists = async gid => !!(await fs('GET', `groups/${encodeURIComponent(gid)}`));

// ---------- Protomaps ----------
async function latestBuild() {
  for (let i = 0; i < 10; i++) {
    const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://build.protomaps.com/${d}.pmtiles`;
    const r = await fetch(url, { method: 'HEAD' });
    if (r.ok) return { url, date: d };
  }
  throw new Error('no recent Protomaps build found');
}
function extract(src, out, region, maxzoom) {
  execFileSync('pmtiles', ['extract', src, out, `--region=${region}`, `--maxzoom=${maxzoom}`, '--download-threads=4'], { stdio: 'inherit' });
  return statSync(out).size;
}

// ---------- main ----------
async function run() {
  if (!token()) throw new Error('FIRESTORE_TOKEN missing');
  mkdirSync('site/areas', { recursive: true });
  const now = Date.now();
  let changed = false;
  const updates = [];
  const areas = await listAreas();
  const groups = new Map();
  for (const a of areas) {
    if (!groups.has(a.gid)) groups.set(a.gid, await groupExists(a.gid));
    if (!groups.get(a.gid)) { await del(a.id); a.status = 'gone'; console.log(`area ${a.id}: group gone → deleted`); continue; }
    if (a.status === 'ready' && now > expiresAt(a)) { await patch(a.id, { status: 'expired' }); a.status = 'expired'; console.log(`area ${a.id}: expired`); }
  }
  const live = areas.filter(a => a.status !== 'gone');
  const { build, reject } = triage(live, now);
  for (const { area, reason } of reject) { await patch(area.id, { status: 'error', error: reason }); console.log(`area ${area.id}: rejected (${reason})`); }

  let src = null;
  for (const a of build) {
    try {
      await patch(a.id, { status: 'building' });
      src ??= await latestBuild();
      writeFileSync('/tmp/region.geojson', JSON.stringify(circle(a.lat, a.lng, a.radiusKm)));
      const out = `site/areas/${a.id}.pmtiles`;
      let maxzoom = 15, size = extract(src.url, out, '/tmp/region.geojson', maxzoom);
      while (size > MAX_FILE && maxzoom > 12) { maxzoom--; size = extract(src.url, out, '/tmp/region.geojson', maxzoom); }
      if (size > MAX_FILE) { rmSync(out, { force: true }); throw new Error('too large'); }
      changed = true;
      updates.push({ id: a.id, fields: { status: 'ready', size, maxzoom, build: src.date, builtAt: Date.now(), url: `${PAGES}/areas/${a.id}.pmtiles` } });
      console.log(`area ${a.id}: built ${(size / 1048576).toFixed(1)} MB z≤${maxzoom}`);
    } catch (e) {
      console.error(`area ${a.id}: ${e.message}`);
      await patch(a.id, { status: 'error', error: String(e.message).slice(0, 200) });
    }
  }
  // Keep only files of ready (or just built) areas.
  const keep = new Set([...live.filter(a => a.status === 'ready').map(a => a.id), ...updates.map(u => u.id)]);
  for (const f of readdirSync('site/areas')) {
    if (f.endsWith('.pmtiles') && !keep.has(f.replace(/\.pmtiles$/, ''))) { rmSync(`site/areas/${f}`); changed = true; console.log(`removed ${f}`); }
  }
  if (changed) {
    const files = readdirSync('site/areas').filter(f => f.endsWith('.pmtiles'));
    writeFileSync('site/index.html', `<!doctype html><meta charset="utf-8"><title>Trip Group maps</title><p>Offline area maps for Trip Group: ${files.length} file(s).</p>`
      + `<p>Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> (ODbL), basemap by <a href="https://protomaps.com">Protomaps</a>.</p>`);
    writeFileSync('site/.changed', '1');
  }
  writeFileSync(UPDATES, JSON.stringify(updates));
  console.log(`OK areas=${areas.length} built=${updates.length} rejected=${reject.length} changed=${changed}`);
}

/** After the site is published: mark built areas ready (so phones never see a file that is not online yet). */
async function finalize() {
  const updates = existsSync(UPDATES) ? JSON.parse(readFileSync(UPDATES, 'utf8')) : [];
  for (const u of updates) await patch(u.id, u.fields);
  console.log(`finalized ${updates.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (process.argv.includes('--finalize') ? finalize() : run()).catch(e => { console.error(e.message); process.exit(1); });
}
