// CineHall worker local test harness (Termux: wrangler dev impossible — workerd has no Android build).
// Mocks caches + env + ctx, imports worker.js directly, runs real endpoint tests over the network.
// Usage: node test-node.mjs [filter]
import { readFileSync, existsSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = join(HERE, '..', 'public');
// worker.js is plain ESM but package.json has no "type":"module" — load a .mjs copy
const TMP = mkdtempSync(join(tmpdir(), 'cine-'));
const WJS = join(TMP, 'worker.mjs');
copyFileSync(join(HERE, 'worker.js'), WJS);

// ---------- mock caches (Cache API) ----------
const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      const k = req.url;
      const e = cacheStore.get(k);
      if (!e) return null;
      return new Response(e.body, { status: 200, headers: e.headers });
    },
    async put(req, res) {
      const k = req.url;
      cacheStore.set(k, { body: await res.clone().text(), headers: Object.fromEntries(res.headers) });
    },
  },
};

// ---------- mock env / ctx ----------
class MockKV {
  constructor() { this.m = new Map(); }
  async get(k, type) {
    if (!this.m.has(k)) return null;
    const v = this.m.get(k);
    return type === 'json' ? (typeof v === 'string' ? JSON.parse(v) : v) : v;
  }
  async put(k, v) { this.m.set(k, v); }
}
const env = {
  KV: new MockKV(),
  WARM_KEY: 'test-key',
  ASSETS: {
    async fetch(req) {
      const u = new URL(req.url);
      let rel = u.pathname.replace(/^\//, '');
      if (!rel) rel = 'index.html'; // dir request → index
      const p = join(PUB, rel);
      if (!existsSync(p) || !p.startsWith(PUB)) return new Response('not found', { status: 404 });
      const ct = rel.endsWith('.html') ? 'text/html' : rel.endsWith('.css') ? 'text/css' : 'application/javascript';
      return new Response(readFileSync(p), { status: 200, headers: { 'Content-Type': ct } });
    },
  },
};
const ctx = { waitUntil: (p) => { ctx._t = ctx._t || []; ctx._t.push(p); }, _t: [] };

const worker = (await import(WJS + '?t=' + Date.now())).default;

let pass = 0, fail = 0;
const filter = process.argv[2] || '';
async function test(name, fn) {
  if (!name.includes(filter)) return;
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${e.message}`);
  }
}
function json(r) { return r.json(); }
function get(path, headers = {}) { return worker.fetch(new Request('https://cine.test' + path, { headers }), env, ctx); }

const started = Date.now();
console.log(`── CineHall worker tests (${new Date().toISOString()}) ──`);

await test('health', async () => {
  const r = await get('/api/health');
  const d = await json(r);
  if (r.status !== 200 || d.ok !== true) throw new Error(`status ${r.status} ${JSON.stringify(d)}`);
});

await test('home', async () => {
  // cold start: warm first (as the deploy doc says), then home rows must have data
  const w = await get('/api/warm?quick=1', { 'x-warm-key': 'test-key' });
  if (w.status !== 200) throw new Error('warm failed before home');
  await Promise.all(ctx._t); ctx._t = [];
  const r = await get('/api/home');
  const d = await json(r);
  if (!d.rows || !Array.isArray(d.rows)) throw new Error('rows missing');
  const withItems = d.rows.filter((row) => row.items && row.items.length);
  if (!withItems.length) throw new Error('all rows empty: ' + JSON.stringify(d.rows).slice(0, 200));
});

await test('search q=inception', async () => {
  const r = await get('/api/search?q=inception');
  const d = await json(r);
  if (!d.ok || !Array.isArray(d.items)) throw new Error('not {ok,items}');
  if (!d.items.length) throw new Error('empty results');
  const it = d.items[0];
  if (!it.id || !it.title || !it.type || !it.poster) throw new Error('item shape ' + JSON.stringify(it));
});

await test('browse movies', async () => {
  const r = await get('/api/browse?section=movies&page=1');
  const d = await json(r);
  if (!Array.isArray(d.items) || !d.items.length) throw new Error('items missing/empty');
  if (d.page !== 1) throw new Error('page mismatch');
});

await test('guard auth (no key → 403)', async () => {
  const r = await get('/api/guard');
  if (r.status !== 403) throw new Error('expected 403, got ' + r.status);
});
await test('guard auth (bad key → 403)', async () => {
  const r = await get('/api/guard', { 'x-guard-key': 'wrong' });
  if (r.status !== 403) throw new Error('expected 403, got ' + r.status);
});
await test('guard auth (good key → 200)', async () => {
  const r = await get('/api/guard', { 'x-guard-key': 'test-key' });
  if (r.status !== 200) throw new Error('expected 200, got ' + r.status);
});

await test('warm quick (auth)', async () => {
  const r = await get('/api/warm?quick=1', { 'x-warm-key': 'test-key' });
  const d = await json(r);
  if (r.status !== 200 || d.ok !== true) throw new Error(JSON.stringify(d).slice(0, 200));
  await Promise.all(ctx._t); ctx._t = [];
});

await test('assets / serves index.html', async () => {
  const r = await get('/');
  const t = await r.text();
  if (r.status !== 200 || !t.includes('<') || !t.includes('cinehall') && !t.includes('CineHall')) throw new Error('index miss');
});

await test('/watch/ serves watch.html', async () => {
  const r = await get('/watch/123');
  const t = await r.text();
  if (r.status !== 200 || !t.includes('watch')) throw new Error('watch.html miss');
});

async function pickMovieId() {
  const home = await json(await get('/api/home'));
  const row = (home.rows || []).find((x) => x.key === 'movies');
  return (row && row.items[0] && row.items[0].id) || 629;
}

await test('detail movie (live scrape)', async () => {
  const movId = await pickMovieId();
  const r = await get(`/api/detail/movie/${movId}`);
  const d = await json(r);
  if (!d.title) throw new Error('no title');
  if (!Array.isArray(d.genres)) throw new Error('genres miss');
});

await test('stream movie (live resolve)', async () => {
  const movId = await pickMovieId();
  const r = await get(`/api/stream/movie/${movId}`);
  const d = await json(r);
  if (!d.ok || !d.stream) throw new Error('no stream: ' + JSON.stringify(d).slice(0, 200));
  const src = (d.servers && d.servers[0] && d.servers[0].src) || d.src;
  if (!src) throw new Error('no src: ' + JSON.stringify(d).slice(0, 200));
  const su = new URL(src, 'https://cine.test');
  if (su.pathname !== '/api/hls' || !su.searchParams.get('url')) throw new Error('src not hls proxy: ' + src.slice(0, 150));
});

await test('404 for unknown api', async () => {
  const r = await get('/api/nope');
  if (r.status !== 404) throw new Error('expected 404, got ' + r.status);
});

console.log(`\n── ${pass} passed / ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)}s) ──`);
process.exit(fail ? 1 : 0);