'use strict';
// CineHall streaming server — serves the design frontend + live catalog API
// Data source: 123moviesfree.yachts (SSR pages) → parsed into JSON via scraper.js
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const express = require('express');
const { getList, getSearch, getDetail, getEpisodeStills, sleep, fetch } = require('./scraper');
const { fuzzyMatch } = require('./fuzzy');
const { getStream, curl, text } = require('./stream');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');
const CATALOG_TTL = 6 * 60 * 60 * 1000;        // home rows refresh after 6h
const PAGE_TTL = 8 * 60 * 60 * 1000;           // browse pages cache 8h
const DETAIL_TTL = 7 * 24 * 60 * 60 * 1000;    // detail pages cache 7d

// New Releases crawl directly (never the 8h page cache) — the source site
// orders every listing newest-first, so page 1 IS the freshest upload. A
// short budget means a new movie/series shows up within minutes of upload.
const NEWS_TTL = 15 * 60 * 1000;
// regional uploads so the row isn't Hollywood-only — Bollywood (india +
// pakistan), east-asian (korea, japan) and african (nigeria) get airtime
const REGIONS = ['country/india', 'country/pakistan', 'country/korea', 'country/japan', 'country/france', 'country/nigeria'];

// Anime has no dedicated section on the source site, so the catalog is built
// by searching well-known series names and keeping only titles that match.
const ANIME_TTL = 6 * 60 * 60 * 1000;
const ANIME_QUERIES = [
  // shounen giants
  'naruto', 'one piece', 'attack on titan', 'demon slayer', 'jujutsu kaisen',
  'bleach', 'dragon ball', 'death note', 'fullmetal alchemist', 'chainsaw man',
  'spy x family', 'one punch man', 'tokyo ghoul', 'my hero academia',
  'hunter x hunter', 'berserk', 'frieren', 'solo leveling', 'vinland saga',
  'sword art online', 'black clover', 'tokyo revengers', 'code geass',
  'cowboy bebop', 'steins gate', 'dandadan', 'oshi no ko', 'kaiju no 8',
  'hells paradise', 'fruits basket', 'boruto', 'jojo', 'monster', 'flcl',
  'no game no life', 'parasyte', 'ergo proxy',
  // classics / modern hits
  'classroom of the elite', 'mob psycho', 're zero', 'made in abyss',
  'the promised neverland', 'fire force', 'goblin slayer', 'gintama',
  'horimiya', 'kaguya sama', 'konosuba', 'mushoku tensei', 'overlord',
  'samurai champloo', 'reincarnated as a slime', 'the apothecary diaries',
  'bungo stray dogs', 'eighty six', 'cyberpunk edgerunners',
  'dungeon meshi', 'the eminence in shadow', 'neon genesis evangelion',
  'heavenly delusion', 'initial d', 'rurouni kenshin', 'sailor moon',
  'dorohedoro', 'great teacher onizuka', 'haikyuu', 'kuroko basketball',
  'blue lock', 'your lie in april', 'zom 100', 'pluto', 'delicious in dungeon',
  'baki', 'ascendance of a bookworm', 'undead unluck', 'ranking of kings',
  'summertime rendering', 'tower of god', 'noblesse', 'the god of high school',
  'yu yu hakusho', 'the devil is a part timer', 'world trigger',
  'record of ragnarok', 'another', 'akame ga kill', 'kill la kill',
  'gurren lagann', 'noragami', 'the seven deadly sins', 'food wars',
  'dr stone', 'toradora', 'anohana', 'clannad', 'violet evergarden',
  'beastars', 'the ancient magus bride', 'magi', 'oddtaxi', 'sonny boy',
  'wonder egg priority', 'moriarty the patriot', 'drifters',
  'to your eternity', 'kengan', 'your name', 'a silent voice',
  'weathering with you', 'tokyo godfathers', 'psycho pass',
  'paranoia agent', 'one outs', 'golden kamuy', 'erased',
];

// ---------- tiny disk cache ----------
// Page/detail snapshots are rebuildable, but an unbounded cache dir can fill
// the disk on a small device (we hit ENOSPC while fetching details). Prune
// the OLDEST cache files whenever the dir exceeds CACHE_MAX_FILES.
const CACHE_MAX_FILES = 600;
function pruneCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .map((f) => { const p = path.join(CACHE_DIR, f); return { p, m: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => a.m - b.m);
    for (let i = 0; i < files.length - CACHE_MAX_FILES; i++) fs.unlinkSync(files[i].p);
  } catch { /* best effort */ }
}
function readJSON(file, ttl) {
  try {
    const st = fs.statSync(file);
    if (ttl && Date.now() - st.mtimeMs > ttl) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}
let cacheWrites = 0;
function writeCache(file, data) {
  writeJSON(file, data);
  // occasional prune (every 25 writes) — cheap and keeps the dir bounded
  if (++cacheWrites % 25 === 0) pruneCache();
}
const pageFile = (section, page) => path.join(CACHE_DIR, `page-${section}-${page}.json`);
const detailFile = (type, id) => path.join(CACHE_DIR, `detail-${type}-${id}.json`);

// in-memory catalog + enriched hero items
const catalog = { movies: [], tv: [], top: [], anime: [], animeTs: 0 };
const topDetailed = [];

// ---------- catalog helpers ----------
function enrichItem(item, d) {
  return {
    ...item,
    year: d.year, rating: d.rating, ratingCount: d.ratingCount,
    desc: d.desc, genres: d.genres, imdb: d.imdb, duration: d.duration,
    backdrop: d.thumb || (item.poster || '').replace('/w500/', '/w1280/'),
    posterSm: (item.poster || '').replace('/w500/', '/w342/'),
  };
}
function trimItem(it) {
  const th = topDetailed.find(d => d.id === it.id && d.type === it.type);
  if (th) return th;
  return { ...it, posterSm: (it.poster || '').replace('/w500/', '/w342/') };
}

// searchable pool for typo-tolerant search: everything the app already knows
let fuzzyPoolCache = null;
function fuzzyPool() {
  if (fuzzyPoolCache) return fuzzyPoolCache;
  const seen = new Set();
  fuzzyPoolCache = [];
  for (const list of [catalog.movies, catalog.tv, catalog.anime]) {
    for (const it of list) {
      const k = it.id + ':' + it.type;
      if (!it.title || seen.has(k)) continue;
      seen.add(k);
      fuzzyPoolCache.push(it);
    }
  }
  return fuzzyPoolCache;
}

// ---------- fresh New Releases (15-min crawl, stale-while-revalidate) ----------
let newCat = { ts: 0, regions: [], general: [] };
let newRefreshing = false;

async function refreshNewReleases() {
  if (newRefreshing) return; // one crawl at a time; keep last good pool
  newRefreshing = true;
  try {
    const [m1, t1, ...regions] = await Promise.all([
      getList('movies', 1),
      getList('tv-series', 1),
      ...REGIONS.map((r) => getList(r, 1).catch(() => ({ ok: false, items: [] }))),
    ]);
    const seen = new Set();
    const take = (list) => (it) => {
      if (!it || !it.title || !it.id) return;
      const k = it.id + ':' + it.type;
      if (seen.has(k)) return;
      seen.add(k);
      list.push(it);
    };
    const rItems = [];
    regions.forEach((r) => (r.items || []).forEach(take(rItems)));
    const gItems = [];
    (m1.items || []).forEach(take(gItems));
    (t1.items || []).forEach(take(gItems));
    // new ids join the main catalog at the FRONT (newest-first ordering) so
    // search + browse find them without waiting for the 6h rebuild
    let added = 0;
    for (const it of [...rItems, ...gItems]) {
      const list = catalog[it.type === 'tv' ? 'tv' : 'movies'];
      if (!list.some((x) => x.id === it.id)) { list.unshift(it); added++; }
    }
    if (added) { fuzzyPoolCache = null; saveCatalog(); }
    // rank each pool by fame — famous (in top-imdb list) + good rating first,
    // so the row leads with noteworthy titles instead of random uploads.
    // Unknown-rated items keep crawl order at the tail, so genuinely new
    // arrivals still surface immediately.
    const rRanked = await rankByFame(rItems, 24);
    const gRanked = await rankByFame(gItems, 24);
    newCat = { ts: Date.now(), regions: rRanked, general: gRanked };
    console.log(`new releases: ${rItems.length} regional + ${gItems.length} general (${added} newly added)`);
  } catch (e) { console.error('new releases:', e.message); }
  newRefreshing = false;
}

// ---------- New Releases fame ranking ----------
// Rating comes from cached detail pages (7d cache, instant on re-sweep; first
// sweep fetches). Score = (in top-imdb famous list ? 10 : 0) + rating; ties
// keep crawl order via the index — sort is stable, so this is a pure re-rank.
async function rankByFame(list, limit) {
  const enriched = await enrich(list, Math.min(limit, list.length));
  const top = catalog.top;
  const info = new Map();
  enriched.forEach((e, i) => {
    if (!info.has(e.id + ':' + e.type)) {
      info.set(e.id + ':' + e.type, {
        rating: e.rating || 0,
        famous: top.some((x) => x.id === e.id && x.type === e.type),
      });
    }
  });
  const out = list.map((it, i) => ({ it, i, ...(info.get(it.id + ':' + it.type) || { rating: 0, famous: false }) }));
  out.sort((a, b) => (b.rating + (b.famous ? 10 : 0)) - (a.rating + (a.famous ? 10 : 0)) || a.i - b.i);
  return out.map((x) => x.it);
}

// alternate regional + general items so the row is a mix, not one block
function interleave(a, b, limit) {
  const out = [];
  let i = 0, j = 0;
  while (out.length < limit && (i < a.length || j < b.length)) {
    if (i < a.length) out.push(a[i++]);
    if (out.length < limit && j < b.length) out.push(b[j++]);
  }
  return out;
}

// ---------- poster health ----------
// TMDB posters get deleted/removed over time — silently dead images were the
// "Avengers poster missing" report. Probe every catalog poster in the
// background every 6h; a dead one degrades to null so the frontend's
// gradient fallback (or the IMDb backfill below) takes over.
let lastPosterProbe = 0;
const POSTER_PROBE_TTL = 6 * 60 * 60 * 1000;

function probePosters() {
  if (Date.now() - lastPosterProbe < POSTER_PROBE_TTL) return;
  lastPosterProbe = Date.now();
  const items = [];
  for (const list of [catalog.movies, catalog.tv, catalog.top, catalog.anime]) {
    for (const it of list) if (it.poster) items.push(it);
  }
  if (!items.length) return;
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      await new Promise((resolve) => {
        const req = https.get(it.poster, { timeout: 8000 }, (res) => {
          res.destroy(); // status code is enough — don't download the body
          if (res.statusCode !== 200) it.poster = null;
          resolve();
        });
        req.on('error', () => { it.poster = null; resolve(); });
        req.setTimeout(8000, () => { req.destroy(); it.poster = null; resolve(); });
      });
    }
  };
  Promise.all(Array.from({ length: 4 }, worker)).then(() => {
    const dead = items.filter((it) => !it.poster).length;
    // probe may have ALSO raced the backfill — only save when probes changed things
    if (dead || items.some((it) => !it.poster)) { fuzzyPoolCache = null; saveCatalog(); }
    console.log(`poster probe: ${items.length} checked, ${dead} dead`);
  });
}

// keyless IMDb suggestion API as the last-resort poster source — the site
// genuinely has no image for some titles (stage plays, collections); IMDb
// almost always does. One lookup per title, cached forever, filled into the
// catalog so cards get a real image instead of the gradient block.
const imdbPosterCache = new Map();
async function imdbPoster(title) {
  const key = String(title || '').toLowerCase();
  if (!key) return '';
  if (imdbPosterCache.has(key)) return imdbPosterCache.get(key);
  const q = key.replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '_');
  let url = '';
  try {
    const r = await fetch(`https://v2.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json`, 8000, 1);
    if (r.ok) {
      const hit = (JSON.parse(r.html).d || []).find((x) => /^\/?tt\d+\/?$/.test(x.id || '') && (x.i || {}).imageUrl);
      if (hit) url = hit.i.imageUrl;
    }
  } catch (e) { /* keep '' — next sweep retries */ }
  imdbPosterCache.set(key, url);
  return url;
}

async function backfillPosters() {
  const items = [];
  for (const list of [catalog.movies, catalog.tv, catalog.top, catalog.anime]) {
    for (const it of list) if (it && !it.poster) items.push(it);
  }
  if (!items.length) return;
  let i = 0, filled = 0;
  const worker = async () => {
    while (i < items.length) {
      const it = items[i++];
      const url = await imdbPoster(it.title);
      if (url) { it.poster = url; filled++; }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (filled) { fuzzyPoolCache = null; saveCatalog(); }
  console.log(`poster backfill: ${filled}/${items.length} titles got IMDb posters`);
}

// ensure a single page of a section: disk cache → crawl (up to 3 tries with backoff)
async function ensurePage(section, page) {
  const cached = readJSON(pageFile(section, page), PAGE_TTL);
  if (cached) return cached;
  let items = [];
  const urlSection = { movies: 'movies', tv: 'tv-series', top: 'top-imdb' }[section] || section;
  for (let attempt = 0; attempt < 3 && !items.length; attempt++) {
    const r = await getList(urlSection, page);
    items = r.items || [];
    if (!items.length) await sleep(1000 + attempt * 1000); // 1s, 2s backoff
  }
  if (items.length) writeCache(pageFile(section, page), items);
  await sleep(300);
  return items;
}

// fetch + cache details for the first `limit` items (fills hero data)
async function enrich(items, limit) {
  const out = [];
  const n = Math.min(limit, items.length);
  for (let i = 0; i < n; i++) {
    const it = items[i];
    const cached = readJSON(detailFile(it.type, it.id), DETAIL_TTL);
    if (cached && cached.ok) { out.push(enrichItem(it, cached)); continue; }
    const r = await getDetail(it.type, it.id);
    if (r.ok) { writeCache(detailFile(it.type, it.id), r); out.push(enrichItem(it, r)); }
    else out.push(it);
    await sleep(300);
  }
  return out;
}

function saveCatalog() {
  writeJSON(CATALOG_FILE, {
    ts: Date.now(), movies: catalog.movies, tv: catalog.tv, top: catalog.top,
    anime: catalog.anime, animeTs: catalog.animeTs || 0, topDetailed,
  });
}

// keep a BIG hero pool — the slider shuffles from it on every refresh, so the
// more entries it has, the fresher each page load feels. Runs in the
// background, never blocks boot or first paint.
async function refreshHeroPool() {
  const limit = 18;
  const pool = catalog.top.length ? catalog.top : catalog.movies;
  const seen = new Set();
  const uniq = pool.filter((it) => {
    const k = it.type + ':' + it.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (uniq.length < limit) return;
  const fresh = await enrich(uniq, limit);
  if (!fresh.length) return;
  topDetailed.length = 0;
  topDetailed.push(...fresh);
  saveCatalog();
}

// title must actually match the anime series we searched for — filters out
// unrelated movies/shows that the site search returns alongside the hit
function animeMatch(it, q) {
  const t = (it.title || '').toLowerCase();
  const ql = q.toLowerCase();
  const words = ql.split(/\s+/).filter((w) => w.length > 2);
  // single-word query ("bleach", "baki", "jojo") must appear as a WHOLE word —
  // "bleach" must not match "Bleacher Report", "baki" must not match "Bake Off Brazil"
  if (words.length === 1) {
    return new RegExp(`(^|[^a-z0-9])${words[0]}([^a-z0-9]|$)`).test(t);
  }
  if (t.includes(ql)) return true;
  if (words.length < 2) return false;
  // near-miss fallback ("That Time I Got Reincarnated as a Slime"): every word
  // must appear as a whole word, AND the title can't be much longer than the
  // query — blocks "From Istanbul, Orders to Kill" (for "kill la kill") and
  // "Memphis Slim & Sonny Boy Williamson Live In Europe" (for "sonny boy").
  const titleWords = t.split(/[^a-z0-9]+/).filter(Boolean);
  if (titleWords.length >= words.length * 2 + 1) return false;
  return words.every((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(t));
}

// Fisher–Yates shuffle. Query completion order is random (concurrent batches),
// so the catalog would otherwise clump one franchise at the front (15 Naruto
// titles in a row). Shuffle once at build so the home row reads as a varied mix.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function buildAnime() {
  // Some titles exist twice on the site — one entry with a poster, one dead
  // (no poster, 404 detail page). Dedupe by normalized title and prefer the
  // entry that actually has a poster image.
  const seen = new Map();
  const pick = (it) => {
    const key = (it.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) return;
    const cur = seen.get(key);
    if (!cur) seen.set(key, it);
    else if (!cur.poster && it.poster) seen.set(key, it); // replace dead entry
  };
  // ~90 queries one-by-one would take minutes — run in small concurrent
  // batches with a polite gap
  for (let i = 0; i < ANIME_QUERIES.length; i += 6) {
    await Promise.all(ANIME_QUERIES.slice(i, i + 6).map(async (q) => {
      try {
        const r = await getSearch(q);
        for (const it of (r.items || [])) {
          if (animeMatch(it, q)) pick(it);
        }
      } catch (e) { /* one bad query shouldn't stop the batch */ }
    }));
    if (i + 6 < ANIME_QUERIES.length) await sleep(150);
    // progressive fill: publish whatever matched so far, so the home row keeps
    // filling up during the 2-minute crawl instead of sitting on "Loading…"
    catalog.anime = Array.from(seen.values());
    saveCatalog();
  }
  // GENRE GATE: the site classifies every title on its detail page (Genre: <a>).
  // A title-level regex cannot separate "First Kill" from "Kill la Kill", but the
  // site's own genre list can — anything without an Animation/Anime genre is not
  // anime ("Operation Overlord" = War, "Memphis Slim…" = Music, "Pluto Squad" = Mystery).
  // Detail pages are disk-cached (7d), so repeat builds are near-instant.
  const staged = Array.from(seen.values());
  const kept = [];
  const isAnime = (d) => !d.genres || !d.genres.length || d.genres.some((g) => /anim/i.test(g));
  for (let i = 0; i < staged.length; i += 8) {
    const details = await Promise.all(staged.slice(i, i + 8).map(async (it) => {
      const cached = readJSON(detailFile(it.type, it.id), DETAIL_TTL);
      if (cached && cached.ok) return cached;
      const r = await getDetail(it.type, it.id);
      if (r.ok) writeCache(detailFile(it.type, it.id), r);
      return r;
    }));
    staged.slice(i, i + 8).forEach((it, idx) => {
      const d = details[idx];
      if (d.ok && !isAnime(d)) return; // site says: not animation — drop
      kept.push(d.ok ? enrichItem(it, d) : it);
    });
    catalog.anime = kept; // progressive fill: row updates as the gate runs
    saveCatalog();
    await sleep(150);
  }
  catalog.anime = shuffle(kept);
  catalog.animeTs = Date.now(); // rebuilt catalog is fresh for ANIME_TTL
  saveCatalog();
  const noPoster = catalog.anime.filter((i) => !i.poster).length;
  console.log(`anime catalog: ${catalog.anime.length} titles (${noPoster} no poster)`);
  // freshly built entrance: probe its posters and try IMDb for the missing ones
  probePosters();
  backfillPosters().catch((e) => console.error('poster backfill:', e.message));
}

async function boot() {
  const disk = readJSON(CATALOG_FILE);
  if (disk && Date.now() - disk.ts < CATALOG_TTL) {
    catalog.movies = disk.movies || [];
    catalog.tv = disk.tv || [];
    catalog.top = disk.top || [];
    catalog.anime = shuffle(disk.anime || []); // randomize the front of the row
    catalog.animeTs = disk.animeTs || 0;
    topDetailed.push(...(disk.topDetailed || []));
    scheduleAnimeBuild(disk);
    // expand the hero pool in the background (disk usually has only 6)
    refreshHeroPool().catch((e) => console.error('hero pool:', e.message));
    kickPosterSweeps();
    return;
  }
  // minimal first paint: 3 pages + 6 hero details
  catalog.movies = await ensurePage('movies', 1);
  catalog.tv = await ensurePage('tv', 1);
  catalog.top = await ensurePage('top', 1);
  catalog.anime = (disk && disk.anime) || [];
  catalog.animeTs = (disk && disk.animeTs) || 0;
  const heroPool = catalog.top.length ? catalog.top : catalog.movies;
  topDetailed.push(...(await enrich(heroPool, 6)));
  saveCatalog();
  // background: pad home rows for richer browsing
  backgroundLoad();
  scheduleAnimeBuild(disk);
  kickPosterSweeps();
}

// poster probe + IMDb backfill + the first fresh-crawl (New Releases) all
// run after boot, never blocking first paint. The 6h probe TTLS itself;
// refreshNewReleases is additionally driven by /api/home staleness.
function kickPosterSweeps() {
  setTimeout(probePosters, 2000);
  setTimeout(() => { backfillPosters().catch((e) => console.error('poster backfill:', e.message)); }, 4000);
  setInterval(probePosters, POSTER_PROBE_TTL);
  setTimeout(() => { refreshNewReleases().catch((e) => console.error('new releases boot:', e.message)); }, 1000);
}

// anime catalog is curated via search, so it rebuilds on its own schedule
// (non-blocking — a slow batch must not delay boot or page serve)
function scheduleAnimeBuild(disk) {
  const stale = Date.now() - (catalog.animeTs || 0) > ANIME_TTL;
  if (!catalog.anime.length || stale) {
    setTimeout(() => { buildAnime().catch((e) => console.error('anime build:', e.message)); }, 800);
  }
}

async function backgroundLoad() {
  try {
    const [m2, m3, t2, t3, tp2] = await Promise.all([
      ensurePage('movies', 2).catch(() => []),
      ensurePage('movies', 3).catch(() => []),
      ensurePage('tv', 2).catch(() => []),
      ensurePage('tv', 3).catch(() => []),
      ensurePage('top', 2).catch(() => []),
    ]);
    catalog.movies = catalog.movies.concat(m2, m3);
    catalog.tv = catalog.tv.concat(t2, t3);
    catalog.top = catalog.top.concat(tp2);
    // retry pass: sections that came back empty get one more sequential shot
    if (!catalog.movies.length) { catalog.movies = await ensurePage('movies', 1).catch(() => []); }
    if (!catalog.tv.length) {
      catalog.tv = await ensurePage('tv', 1).catch(() => []);
      if (catalog.tv.length) catalog.tv = catalog.tv.concat(
        (await ensurePage('tv', 2).catch(() => [])),
        (await ensurePage('tv', 3).catch(() => [])));
    }
    if (!catalog.top.length) { catalog.top = await ensurePage('top', 1).catch(() => []); }
    saveCatalog();
    // pad the hero pool AFTER the top row is loaded — bigger pool, fresher slider
    await refreshHeroPool();
  } catch (e) { console.error('bg load:', e.message); }
}

// ---------- app ----------
const app = express();

// Cache headers for static assets (1 year) + HTML (stale-while-revalidate)
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1y',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300, stale-if-error=86400');
    } else if (/\.(css|js|mjs|woff2?|png|jpg|jpeg|webp|avif|svg|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  res.json({ ok: true, booted: booted() });
});

// API cache middleware for GET endpoints
function apiCache(maxAge = 60, swr = 300) {
  return (req, res, next) => {
    res.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=${swr}`);
    next();
  };
}

// Fisher-Yates shuffle on a COPY — catalog arrays stay untouched so the
// cache keeps its full pool for the next refresh
function shuffle(a) {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

app.get('/api/home', apiCache(30, 300), async (req, res) => {
  // New Releases must reflect NEW uploads within minutes — crawl the source's
  // newest pages (never the 8h cache) whenever the 15-min budget lapses.
  // The response serves the last good pool meanwhile (stale-while-revalidate).
  if (Date.now() - newCat.ts > NEWS_TTL) refreshNewReleases().catch(() => {});
  const regions = newCat.regions.length ? newCat.regions : [];
  const general = newCat.general.length ? newCat.general : [...catalog.movies, ...catalog.tv];
  res.json({
    booted: booted(),
    hero: shuffle(topDetailed).slice(0, 12),
    rows: [
      { key: 'top',      title: 'Top Rated', cat: 'top',    items: shuffle(catalog.top).slice(0, 16).map(trimItem) },
      { key: 'new',      title: 'New Releases', cat: 'new', items: interleave(regions, general, 24).map(trimItem) },
      { key: 'anime',    title: 'Anime',     cat: 'anime',  items: shuffle(catalog.anime).slice(0, 22).map(trimItem) },
      { key: 'movies',   title: 'Movies',    cat: 'movies', items: shuffle(catalog.movies).slice(0, 22).map(trimItem) },
      { key: 'tv',       title: 'TV Series', cat: 'tv',     items: shuffle(catalog.tv).slice(0, 22).map(trimItem) },
    ],
  });
});

app.get('/api/browse', apiCache(60, 300), async (req, res) => {
  const section = String(req.query.section || 'movies');
  let page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  if (!['movies', 'tv', 'top', 'anime'].includes(section)) return res.status(400).json({ ok: false });
  // anime is a curated catalog (site has no anime section) — no crawl, but it
  // can be big now, so paginate it in-page like the other sections
  if (section === 'anime') {
    const size = 24;
    const maxPage = Math.max(1, Math.ceil(catalog.anime.length / size));
    page = Math.min(page, maxPage);
    res.json({ ok: true, section, page, maxPage, items: catalog.anime.slice((page - 1) * size, page * size).map(trimItem) });
    return;
  }
  page = Math.min(page, 250);
  try {
    let items;
    if (page === 1) {
      items = catalog[section].slice(0, 22);
      if (!items.length) items = await ensurePage(section, 1); // lazy first load
    } else {
      items = await ensurePage(section, page);
    }
    res.json({ ok: true, section, page, items: items.map(trimItem) });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

app.get('/api/search', apiCache(60, 600), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: false, items: [] });
  try {
    const r = await getSearch(q);
    const fix = (i) => ({ ...i, poster: (i.poster || '').replace('/w500/', '/w342/') });
    const items = r.items.map(fix);
    if (r.ok && items.length) return res.json({ ok: true, source: 'site', items });
    // Upstream found nothing — the query is probably a typo ("spaderman" for
    // "Spider-Man"). Resolve the closest catalog title, retry the site with
    // that corrected title (full result set), else serve catalog matches
    // directly, clearly flagged so the UI can say "did you mean".
    const hits = fuzzyMatch(q, fuzzyPool(), { limit: 10 });
    if (hits.length) {
      const best = hits[0];
      const r2 = await getSearch(best.title);
      if (r2.ok && r2.items.length) {
        const fixed = r2.items.map(fix);
        return res.json({ ok: true, source: 'corrected', didYouMean: best.title, fuzzy: true, items: fixed.slice(0, 16) });
      }
      return res.json({ ok: true, source: 'fuzzy', didYouMean: best.title, fuzzy: true, items: hits.map(fix) });
    }
    return res.json({ ok: false, source: 'none', items: [] });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// Trending Hollywood — shown in the search dropdown when the box is empty.
// Cheap in-memory: the top-IMDb pool (enriched with rating/genres) ranked by
// rating, movies only, so the suggestions read as "Trending Hollywood".
app.get('/api/search/trending', apiCache(300, 600), (req, res) => {
  const seen = new Set();
  const out = [];
  const push = (it) => {
    if (!it || !it.title || !it.id || it.type !== 'movie') return;
    const k = it.type + ':' + it.id;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(it);
  };
  const rated = [...topDetailed].filter((it) => it.type === 'movie')
    .sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
  for (const it of rated) push(it);
  for (const it of (catalog.top || [])) push(trimItem(it)); // pad
  res.json({ ok: true, items: out.slice(0, 12) });
});

// Full search page: every match (typo-corrected) + similar titles from the
// best match's "You May Also Like" (fallback: catalog titles close to the query).
app.get('/api/search/full', apiCache(60, 600), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: false, items: [], similar: [] });
  try {
    const fix = (i) => ({ ...i, poster: (i.poster || '').replace('/w500/', '/w342/') });
    let items = [], didYouMean = null, fuzzy = false;
    const r = await getSearch(q);
    if (r.ok && r.items.length) {
      items = r.items.map(fix).slice(0, 20);
    } else {
      // typo ("spaderman") — resolve the closest catalog title, retry the site
      const hits = fuzzyMatch(q, fuzzyPool(), { limit: 10 });
      if (hits.length) {
        const best = hits[0];
        didYouMean = best.title;
        fuzzy = true;
        const r2 = await getSearch(best.title);
        items = (r2.ok && r2.items.length ? r2.items : hits).map(fix).slice(0, 20);
      }
    }
    // Similar titles: the source site's own "You May Also Like" grid for the
    // top match. Bounded with a race so a slow uncached detail page can never
    // hold up the results page — fall back to fuzzy catalog neighbors.
    let similar = [];
    const best = items[0];
    if (best && best.type && best.id) {
      try {
        const d = await Promise.race([
          getDetail(best.type, best.id),
          new Promise((res) => setTimeout(() => res({ ok: false }), 6000)),
        ]);
        if (d && d.ok && Array.isArray(d.related)) similar = d.related.map(fix).slice(0, 12);
      } catch (e) { /* fall through */ }
    }
    if (!similar.length) {
      const known = new Set(items.map((i) => i.id + ':' + i.type));
      similar = fuzzyMatch(q, fuzzyPool(), { limit: 14 })
        .map(fix).filter((s) => !known.has(s.id + ':' + s.type)).slice(0, 12);
    }
    res.json({ ok: true, q, didYouMean, fuzzy, items, similar });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

app.get('/api/detail/:type/:id', apiCache(300, 600), async (req, res) => {
  const type = req.params.type === 'tv' ? 'tv' : 'movie';
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false });
  let d = readJSON(detailFile(type, id), DETAIL_TTL);
  if (d && d.ok && !d.related) {
    // Cached before the "You May Also Like" parser landed — refetch once so
    // the related grid shows up without waiting for the 7-day cache to age out.
    try {
      const r = await getDetail(type, id);
      if (r.ok && Array.isArray(r.related)) {
        d = r;
        writeCache(detailFile(type, id), r);
      }
    } catch (e) { /* keep stale cache */ }
  }
  if (d && d.ok && type === 'tv' && d.seasons && d.seasons.length && !d.stills) {
    // Cached before the episode-thumbnail scraper landed — backfill episode
    // stills (TMDB season pages) so existing TV shows get images immediately.
    try {
      d.stills = await getEpisodeStills(id, d.seasons);
      if (d.stills && Object.keys(d.stills).length) writeCache(detailFile(type, id), d);
    } catch (e) { /* keep stale cache */ }
  }
  if (!d || !d.ok) {
    try {
      const r = await getDetail(type, id);
      if (!r.ok) return res.status(404).json({ ok: false, id });
      d = r;
      writeCache(detailFile(type, id), r);
    } catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  }
  // scraper's detail payload uses `name` (list items use `title`) — normalize
  // at the API boundary so watch.js can rely on title/poster everywhere.
  // Detail pages only carry the w1280 backdrop — upgrade to the true portrait
  // poster = actual TMDB portrait from the catalog; detail pages carry w1280 backdrop.
  let poster = d.poster || d.thumb;
  if (!d.poster) {
    const catItem = (catalog.movies || []).concat(catalog.tv || [], catalog.anime || [])
      .find((i) => i.type === type && i.id === id);
    if (catItem && catItem.poster) poster = catItem.poster;
  }
  // The source's "You May Also Like" grid only ships a handful of titles —
  // pad from the cached catalog (same type first, then the rest) so the
  // watch-page row always has a full 30 cards to scroll.
  const related = Array.isArray(d.related) ? d.related : [];
  if (related.length < 30) {
    const seen = new Set(related.map((r) => r.id));
    const pool = (catalog.movies || []).concat(catalog.tv || []);
    const same = pool.filter((i) => i.type === type && !seen.has(i.id));
    const other = pool.filter((i) => i.type !== type && !seen.has(i.id));
    for (const i of [...same, ...other]) {
      if (related.length >= 30) break;
      related.push({ id: i.id, slug: i.slug, title: i.title, type: i.type, poster: i.poster });
    }
  }
  res.json({ type, id, ...d, title: d.title || d.name, poster, related });
});

// ---------- HLS proxy ----------
// The browser only talks to localhost: the m3u8 masters live on CDNs that
// (a) block Node's TLS fingerprint (must fetch via curl) and (b) send no CORS
// headers. This endpoint fetches via curl and rewrites every URI in the
// playlists (variants, media segments, EXT-X-KEY/EXT-X-MAP/EXT-X-MEDIA)
// to absolute /api/hls?url=...&ref=... URLs, so playback never leaves the proxy.
const HLS_REF = 'https://play.xpass.top/';
const MIME = { ts: 'video/mp2t', m4s: 'video/mp4', mp4: 'video/mp4', aac: 'audio/aac', m3u8: 'application/vnd.apple.mpegurl', key: 'application/octet-stream' };
function hlsProxyUrl(abs, ref) {
  return `/api/hls?url=${encodeURIComponent(abs)}${ref ? '&ref=' + encodeURIComponent(ref) : ''}`;
}
function rewritePlaylist(body, baseUrl, ref) {
  const proxify = (u) => {
    try { return hlsProxyUrl(new URL(u, baseUrl).toString(), ref); }
    catch { return u; }
  };
  return body.split('\n').map((line) => {
    if (line.startsWith('#')) {
      // attribute-based URIs: #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA / #EXT-X-I-FRAME-STREAM-INF
      if (/URI=/.test(line) && !line.startsWith('#EXT-X-DISCONTINUITY')) {
        return line.replace(/URI="([^"]*)"/g, (_, u) => `URI="${proxify(u)}"`);
      }
      return line;
    }
    if (line.trim().length) return proxify(line); // standalone URI line (variant/segment)
    return line;
  }).join('\n');
}

app.get('/api/hls', apiCache(300, 600), async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\//.test(url)) return res.status(400).end('bad url');
  const ref = String(req.query.ref || HLS_REF);
  try {
    const r = await curl(url, ref);
    if (!r.ok || !r.body.length) {
      res.set('Access-Control-Allow-Origin', '*');
      return res.status(502).json({ ok: false, error: 'upstream ' + (r.err || 'failed') });
    }
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    const body = text(r);
    if (body.startsWith('#EXTM3U')) {
      res.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.send(rewritePlaylist(body, url, ref));
    } else {
      const ext = (url.split('?')[0].match(/\.(\w+)$/) || [])[1];
      res.set('Content-Type', MIME[ext] || 'application/octet-stream');
      res.send(r.body);
    }
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ---------- native stream endpoint (movies) ----------
// Returns every live server that probed OK; the player shows a "Change Server"
// bar (like TV) and auto-fails over when a server errors out.
app.get(['/api/stream/:type/:id/:s/:e', '/api/stream/:type/:id/:s', '/api/stream/:type/:id'], apiCache(60, 300), async (req, res) => {
  const type = req.params.type === 'tv' ? 'tv' : 'movie';
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ ok: false });
  try {
    const st = await getStream(type, id, req.params.s, req.params.e);
    if (!st) {
      // TV: no stable native source (see stream.js header) — client falls back to iframe embeds
      return res.json({ ok: true, stream: false, tv: true });
    }
    const i = parseInt(id, 10) ? parseInt(id, 10) : id;
    const list = (st.servers && st.servers.length ? st.servers : [{ master: st.master, server: st.server || 'VIP 1', label: st.label || 'VIP 1', audio: st.audio || 0 }])
      .map((v) => ({
        src: hlsProxyUrl(v.master, st.referer),
        server: v.server, label: v.label,
        audio: v.audio || 0,   // >1 => player shows language switcher
        langs: v.langs || [],  // audio languages parsed from the master
      }));
    if (!list.length) {
      // every known source died (tokens expire) — client goes straight to the
      // iframe backup instead of booting dead entries
      return res.json({ ok: true, stream: false, reason: 'no live servers' });
    }
    res.json({
      ok: true, stream: true, type, id: i,
      src: list[0].src,
      servers: list,
      server: list[0].server, label: list[0].label,
      audio: Math.max(0, ...list.map((v) => v.audio)),
      probing: Boolean(st.probing), // true => server list still filling; refetch
    });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ---------- external server status (embed sources) ----------
// Probes every iframe embed CineHall offers (2embed, vidsrc family,
// gdriveplayer…) with a short curl check and 15-min cache, so watch pages
// can skip dead servers. Mirrors the lists in public/watch.js (§tvEmbeds).
const EMBED_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
function embedSources(type, id, s, e) {
  // detail cache knows the imdb key (2embed/vidsrc route on imdb, not catalog id)
  const detail = readJSON(detailFile(type, id), null);
  const key = (detail && detail.imdb) || id;
  const ytq = (q, min) => `/api/yt?q=${encodeURIComponent(q)}&min=${min}`;
  if (type === 'tv') {
    return [
      // VidEasy = 7reels.cc default player (4K); carries shows VidRock doesn't
      // (e.g. The Kapil Sharma Show 66465 — vidrock returns all-null via its
      // own /api/tv endpoint). Ranked first so it's the auto-picked source.
      { name: 'VidEasy', url: `https://player.videasy.net/tv/${id}/${s}/${e}?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=true&overlay=true&color=16A085` },
      { name: '2Embed', url: `https://www.2embed.cc/embedtv/${key}-${s}-${e}` },
      { name: 'Vidsrc.hair', url: `https://vidsrc.hair/embed/tv/${key}/${s}/${e}` },
      { name: 'VidAPI', url: `https://vidapi.xyz/embed/tv/${id}/${s}/${e}` },
      { name: 'Vidsrc.pm', url: `https://vidsrc.pm/embed/tv/${key}/${s}/${e}` },
      { name: 'vsembed', url: `https://vsembed.ru/embed/tv/${key}/${s}/${e}` },
      // re-added 2026-08-14 live probe: vidsrc.io / vidsrc.su / vidsrc.to serve player pages
      { name: 'Vidsrc.io', url: `https://vidsrc.io/embed/tv/${key}/${s}/${e}` },
      { name: 'Vidsrc.su', url: `https://vidsrc.su/embed/tv/${key}/${s}/${e}` },
      { name: 'Vidsrc.to', url: `https://vidsrc.to/embed/tv/${key}/${s}/${e}` },
      // cinezo.gd naye servers (catalog id = TMDB id) — mirrors public/watch.js
      { name: 'VidLink', url: `https://vidlink.pro/tv/${id}/${s}/${e}?autoplay=true&title=true` },
      { name: 'VidUp', url: `https://vidup.to/tv/${id}/${s}/${e}?autoPlay=true&theme=16A085&nextButton=true&autoNext=true&sub=en` },
      { name: 'Vidsrc.mov', url: `https://vidsrc.mov/embed/tv/${id}/${s}/${e}` },
      { name: 'Vidsrc.fyi', url: `https://vidsrc.fyi/embed/tv/${id}/${s}/${e}` },
      { name: 'VidRock', url: `https://vidrock.net/tv/${id}/${s}/${e}` },
      { name: 'VidNest', url: `https://vidnest.fun/tv/${id}/${s}/${e}` },
      { name: 'VidKing', url: `https://www.vidking.net/embed/tv/${id}/${s}/${e}` },
      // YouTube: full episodes re-uploaded by mirror channels (official
      // channels block embedding) — /api/yt searches + 302s to the embed
      { name: 'YouTube', url: ytq(`${(detail && detail.name) || ''} s${s} e${e} full episode`, 1500) },
    ];
  }
  return [
    // VidEasy first — 7reels.cc default player; falls back to the rest below
    { name: 'VidEasy', url: `https://player.videasy.net/movie/${id}?overlay=true&color=16A085` },
    { name: '2Embed', url: `https://www.2embed.cc/embed/${key}` },
    { name: 'Vidsrc.pm', url: `https://vidsrc.pm/embed/movie/${key}` },
    { name: 'vsembed', url: `https://vsembed.ru/embed/movie/${key}` },
    { name: 'VidAPI', url: `https://vidapi.xyz/embed/movie/${id}` },
    { name: 'Vidsrc.hair', url: `https://vidsrc.hair/embed/movie/${key}` },
    // re-added 2026-08-14 live probe: vidsrc.io / vidsrc.su / vidsrc.to serve player pages
    { name: 'Vidsrc.io', url: `https://vidsrc.io/embed/movie/${key}` },
    { name: 'Vidsrc.su', url: `https://vidsrc.su/embed/movie/${key}` },
    { name: 'Vidsrc.to', url: `https://vidsrc.to/embed/movie/${key}` },
    // cinezo.gd naye servers (catalog id = TMDB id)
    { name: 'VidLink', url: `https://vidlink.pro/movie/${id}?autoplay=true&title=true` },
    { name: 'VidUp', url: `https://vidup.to/movie/${id}?autoPlay=true&theme=16A085&nextButton=true&autoNext=true&sub=en` },
    { name: 'VidCore', url: `https://vidcore.net/movie/${id}` },
    { name: 'Vidsrc.mov', url: `https://vidsrc.mov/embed/movie/${id}` },
    { name: 'Vidsrc.fyi', url: `https://vidsrc.fyi/embed/movie/${id}` },
    { name: 'VidRock', url: `https://vidrock.net/movie/${id}` },
    { name: 'VidNest', url: `https://vidnest.fun/movie/${id}` },
    { name: 'VidKing', url: `https://www.vidking.net/embed/movie/${id}` },
    { name: 'Peachify', url: `https://peachify.top/embed/movie/${id}` },
    // GDrivePlayer re-added 2026-08-14 — host alive again (jwplayer page); movie only
    { name: 'GDrivePlayer', url: `https://database.gdriveplayer.us/player.php?imdb=${key}` },
    { name: 'YouTube', url: ytq(`${(detail && detail.name) || ''} ${(detail && detail.year) || ''} full movie`, 2700) },
  ];
}
const srcProbe = (url) => new Promise((resolve) => {
  // internal endpoints (/api/yt…) do their own search at load time — no probe needed
  if (url.startsWith('/api/')) return resolve(true);
  execFile('curl', ['-sS', '-L', '-o', '/dev/null', '-m', '9', '-A', EMBED_UA, '-w', '%{http_code}', url], (err, out) => {
    // 2xx/3xx after following redirects = host reachable and serving
    resolve(!err && /^[23]\d\d$/.test((out || '').trim()));
  });
});
let srcCache = { at: 0, key: '', data: null };
app.get('/api/sources', apiCache(900, 1800), async (req, res) => {
  const type = req.query.type === 'tv' ? 'tv' : 'movie';
  const id = String(req.query.id || '');
  const s = Math.max(1, parseInt(req.query.s, 10) || 1);
  const e = Math.max(1, parseInt(req.query.e, 10) || 1);
  if (!id || !/^\d+$/.test(id)) return res.status(400).json({ ok: false });
  const ckey = `${type}|${id}|${s}|${e}`;
  if (srcCache.key === ckey && Date.now() - srcCache.at < 15 * 60 * 1000) {
    return res.json({ ok: true, cached: true, ...srcCache.data });
  }
  const list = embedSources(type, id, s, e);
  try {
    const results = await Promise.all(list.map((x) => srcProbe(x.url)));
    const out = { ts: Date.now(), list: list.map((x, i) => ({ ...x, ok: results[i] })) };
    srcCache = { at: Date.now(), key: ckey, data: out };
    res.json({ ok: true, cached: false, ...out });
  } catch (err) { res.status(502).json({ ok: false, error: err.message }); }
});

// ---------- YouTube search server ----------
// Full Indian episodes/movies are re-uploaded on YouTube by fan/mirror
// channels; official channels (SET/Sony/Netflix/Prime…) disable embedding,
// so they are filtered out here. Searches via yt-dlp (flat = fast), then
// verifies the winner's duration before 302-ing to its embed URL.
const YT_OFFICIAL = /\b(set|sony|sonyliv|viacom|colors|star|zee|zeetv|netflix|prime|amazon|disney|hotstar|jiocinema|jio|voot|tvf|discovery|natgeo|mtv|nick|cartoon|tseries|t-series)\b|trailer|promo|teaser|official|lyrical|song/i;
const ytCache = new Map();
const ytPending = new Map();
const YT_EMBED = (id) => `https://www.youtube.com/embed/${id}?autoplay=1&rel=0`;

function ytSearch(q, min) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp',
      ['ytsearch9:' + q, '--flat-playlist', '--no-playlist', '--no-warnings', '-q',
        '--print', '%(id)s|%(channel)s|%(title)s'],
      { timeout: 30000, maxBuffer: 64 * 1024 * 1024 },
      (err, out) => {
        if (err || !out) return reject(err || new Error('search failed'));
        // score = query words that appear verbatim in the title (prefers the
        // exact show/film over look-alikes), then drop official channels
        const qwords = new Set(q.toLowerCase().match(/[a-z0-9]{2,}/g) || []);
        const cands = out.split('\n')
          .map((l) => l.split('|'))
          .filter((x) => x.length >= 3 && x[0] && x[1] && !YT_OFFICIAL.test(x[1]) && !YT_OFFICIAL.test(x[2]))
          .map((x) => {
            const words = new Set(x[2].toLowerCase().match(/[a-z0-9]{2,}/g) || []);
            const score = [...qwords].reduce((n, w) => n + (words.has(w) ? 1 : 0), 0);
            return [...x, score];
          })
          .sort((a, b) => b[3] - a[3] || a[1].localeCompare(b[1]));
        if (!cands.length) return reject(new Error('no candidates'));
        let i = 0;
        const tryNext = () => {
          if (i >= cands.length) return reject(new Error('no eligible video'));
          const [vid] = cands[i++];
          execFile('yt-dlp',
            ['--no-warnings', '-q', '--print', '%(duration)s', `https://www.youtube.com/watch?v=${vid}`],
            { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
            (e2, durOut) => {
              if (e2) return tryNext();
              const d = parseInt(durOut, 10);
              if (d >= min) return resolve(vid);
              tryNext();
            });
        };
        tryNext();
      });
  });
}

app.get('/api/yt', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.status(400).json({ ok: false, error: 'query too short' });
  const min = Math.max(300, parseInt(req.query.min, 10) || 1500);
  const key = q + '|' + min;
  const hit = ytCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) {
    return res.redirect(YT_EMBED(hit.id));
  }
  if (ytPending.has(key)) {
    try { return res.redirect(YT_EMBED(await ytPending.get(key))); }
    catch (e) { return res.status(404).json({ ok: false, error: String(e.message || e) }); }
  }
  const p = ytSearch(q, min);
  ytPending.set(key, p);
  try {
    const vid = await p;
    ytCache.set(key, { at: Date.now(), id: vid });
    if (ytCache.size > 400) ytCache.clear(); // cache is small (q|min keys) — never let it balloon
    res.redirect(YT_EMBED(vid));
  } catch (e) {
    res.status(404).json({ ok: false, error: String(e.message || e) });
  } finally {
    ytPending.delete(key);
  }
});

app.get('/watch/:type/:id/:s/:e', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/watch/:type/:id/:s', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'watch.html')));
app.get('/watch/:type/:id', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'watch.html')));



// ---------- MovieFlix source (1555 movies + 415 series, all YouTube) ----------
const mflix = require('./mflix');

// browse grid with language filter: kind=movie|series, lang=All|Bollywood|...
app.get('/api/mflix/browse', apiCache(300, 600), (req, res) => {
  const kind = req.query.kind === 'series' ? 'series' : 'movie';
  const lang = String(req.query.lang || 'All');
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const perPage = Math.min(60, Math.max(8, parseInt(req.query.perPage, 10) || 24));
  try {
    res.json({ ok: true, ...mflix.browse(kind, lang, page, perPage) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// merge MovieFlix hits into the main search dropdown
app.get('/api/mflix/search', apiCache(60, 600), (req, res) => {
  const q = String(req.query.q || '');
  if (q.length < 2) return res.json({ ok: true, items: [] });
  const hits = mflix.searchMovieFlix(q).map((c) => {
    const multi = !!(c.versions && c.versions.length > 1);
    return {
      type: c.type === 'series' ? 'mfls' : 'mflix',
      id: c.id,
      title: c.title,
      thumb: c.thumb,
      desc: c.desc || '',
      rating: '',
      year: '',
      lang: c.lang || '',
      versions: c.versions || null,
      multi,
      sub: `Flix · ${c.type === 'series' ? c.epCount + ' eps' : (c.lang || '')}${multi ? ' · ' + c.versions.length + ' langs' : ''}`,
    };
  });
  res.json({ ok: true, items: hits });
});

// detail: kind=movie -> movie card; kind=series -> { title, lang, eps[] }
app.get('/api/mflix/detail/:kind/:id', apiCache(300, 600), (req, res) => {
  const kind = req.params.kind === 'series' ? 'series' : 'movie';
  const detail = kind === 'series'
    ? mflix.getSeries(String(req.params.id))
    : mflix.getMovie(String(req.params.id));
  if (!detail) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, ...detail });
});

// stream info for a YouTube videoId (movie id or episode id)
app.get('/api/mflix/stream/:id', apiCache(60, 300), async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return res.status(400).json({ ok: false, error: 'bad id' });
  try {
    const s = await mflix.streamInfo(id);
    if (!s || !s.ok) return res.json({ ok: false, reason: (s && s.reason) || 'unavailable' });
    res.json(s);
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// SD way through the server so googlevideo's IP lock (this machine's IP)
// always matches; only googlevideo hosts allowed.
app.get('/api/mflix/proxy', (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https:\/\/([a-z0-9.-]+\.)?googlevideo\.com\//i.test(url)) {
    return res.status(400).json({ ok: false, error: 'host not allowed' });
  }
  mflix.proxyStream(url, req, res);
});

// HD: ffmpeg remuxes DASH video+audio into a single fMP4 piped to the client
app.get('/api/mflix/remux/:id', (req, res) => {
  mflix.remux(String(req.params.id), res).catch(() => { try { res.end(); } catch (e) {} });
});

// Legal pages (served directly, not via SPA fallback)
for (const page of ['dmca', 'privacy', 'terms'])
  app.get('/' + page, (req, res) => res.sendFile(path.join(__dirname, 'public', page + '.html')));

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

let bootedFlag = false;
const booted = () => bootedFlag;

(async () => {
  try {
    await boot();
    bootedFlag = true;
    app.listen(PORT, '0.0.0.0', () => console.log(`CineHall → http://localhost:${PORT}`));
  } catch (e) {
    console.error('boot failed:', e.message);
    process.exit(1);
  }
})();