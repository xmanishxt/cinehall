// cinehall edge worker — full port of CineHall's Node server to Cloudflare Workers
// (₹0, no card, no server). Origin data: 123moviesfree.yachts (SSR) + 2embed/xpass/vidsrc.hair.
//
// THE CATCH (100k/day can never run out):
//   Zone-level CACHE RULES (added by deploy.sh) cache EVERYTHING at the edge.
//   On a cache HIT the CDN serves the response WITHOUT invoking this Worker —
//   0 requests counted against the 100k free budget. We only burn budget on
//   cache misses / first fetches, and the headers below decide who that is:
//     /api/hls?url=...&ref=...  media (ts/m4s/mp4/key) -> max-age 30d + SWR 30d
//                               playlists (m3u8)      -> max-age 10min + SWR 1h
//     static assets                                    -> max-age 1d + SWR 1d
//     api json                                          -> 2h..7d (per route)
//   => ~100-200 Worker invocations warm an entire movie; every later viewer
//      of the same movie pays ZERO.
//
// Dropped vs the Node server (need child_process/ffmpeg): /api/mflix/*, /api/torrent/*.

const BASE = 'https://123moviesfree.yachts';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36';
const EMBED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EMBED = 'https://www.2embed.cc/embed/{id}';
const XPASS = 'https://play.xpass.top/e/movie/{tmdb}?autostart=true';
const VSRC = 'https://vidsrc.hair';
const HLS_REF = 'https://play.xpass.top/';
const MIME = { ts: 'video/mp2t', m4s: 'video/mp4', mp4: 'video/mp4', aac: 'audio/aac', m3u8: 'application/vnd.apple.mpegurl', key: 'application/octet-stream' };

const CATALOG_TTL = 6 * 60 * 60, PAGE_TTL = 8 * 60 * 60, DETAIL_TTL = 7 * 24 * 60 * 60, ANIME_TTL = 6 * 60 * 60, STREAM_TTL = 2 * 60 * 60;
const CH = (s) => `max-age=${s}, stale-while-revalidate=${s}`;

// ---------------- fetch helpers (replaces scraper's https + stream's curl) ----------------
async function fget(url, { ref = null, timeoutMs = 15000, retries = 2, binary = false, ua = UA } = {}) {
  const headers = { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9', Accept: '*/*' };
  if (ref) headers.Referer = ref;
  let last = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(url, { headers, redirect: 'follow', signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) { last = { ok: false, status: r.status, body: null }; continue; }
      const body = binary ? await r.arrayBuffer() : await r.text();
      return { ok: true, status: r.status, body, statusType: r.headers.get('content-type') || '' };
    } catch (e) { last = { ok: false, status: 0, body: null }; }
  }
  return last;
}

// ---------------- scraper port (pure string ops, identical regexes) ----------------
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
const CARD_START = '<div class="card h-100 border-0 shadow">';
const LINK_RE = /href="\/(movie|tv-series)\/([\w-]+)-(\d+)\/"/;
const POSTER_RE = /src="(https:\/\/image\.tmdb\.org\/t\/p\/w185\/([^"]+))"|data-src="(https:\/\/image\.tmdb\.org\/t\/p\/w185\/([^"]+))"/;
const TITLE_RE = /card-title[^>]*>([^<]*)<\/(?:h\d|a)>/;
function parseCards(html) {
  const items = [];
  let start = 0;
  while ((start = html.indexOf(CARD_START, start)) !== -1) {
    const chunkStart = start + CARD_START.length;
    const end = html.indexOf(CARD_START, chunkStart);
    const chunk = html.slice(chunkStart, end === -1 ? undefined : end);
    const link = chunk.match(LINK_RE);
    const poster = chunk.match(POSTER_RE);
    const titleM = chunk.match(TITLE_RE);
    if (!link || !titleM) { start = chunkStart; continue; }
    const type = link[1] === 'tv-series' ? 'tv' : 'movie';
    const id = parseInt(link[3], 10);
    const title = decodeEntities(titleM[1]).trim();
    const posterPath = (poster && (poster[2] || poster[4])) || null;
    if (id && title) items.push({ id, slug: link[2], title, type, poster: posterPath ? 'https://image.tmdb.org/t/p/w500/' + posterPath : null });
    start = chunkStart;
  }
  return items;
}
const REL_GRID = '<div class="row row-cols-2 row-cols-sm-4 row-cols-lg-6 list-rel g-3">';
const REL_POSTER_RE = /src="(https:\/\/image\.tmdb\.org\/t\/p\/w(?:185|342)\/([^"]+))"|data-src="(https:\/\/image\.tmdb\.org\/t\/p\/w(?:185|342)\/([^"]+))"/;
function parseRelated(html) {
  const grid = html.indexOf(REL_GRID);
  if (grid === -1) return [];
  const items = [];
  let idx = grid, guard = 0;
  while ((idx = html.indexOf(CARD_START, idx)) !== -1 && guard++ < 40) {
    const chunkStart = idx + CARD_START.length;
    const end = html.indexOf(CARD_START, chunkStart);
    const chunk = html.slice(chunkStart, end === -1 ? undefined : end);
    const link = chunk.match(LINK_RE);
    const poster = chunk.match(REL_POSTER_RE);
    const titleM = chunk.match(TITLE_RE);
    if (link && titleM) {
      const id = parseInt(link[3], 10);
      const title = decodeEntities(titleM[1]).trim();
      const posterPath = (poster && (poster[2] || poster[4])) || null;
      if (id && title) items.push({ id, slug: link[2], title, type: link[1] === 'tv-series' ? 'tv' : 'movie', poster: posterPath ? 'https://image.tmdb.org/t/p/w500/' + posterPath : null });
    }
    idx = chunkStart;
  }
  return items;
}
function parseJSONLD(html) {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}
function parseDetails(html, fallback) {
  const ld = parseJSONLD(html) || {};
  const name = ld.name ? decodeEntities(ld.name).replace(/^Watch\s*|\s*for Free.*$/ig, '') : fallback.title;
  const desc = (ld.description || '').trim();
  const uploadDate = ((ld.datePublished || ld.uploadDate) || '').split('T')[0];
  const year = uploadDate ? (parseInt(uploadDate.slice(0, 4), 10) || null) : null;
  const rating = ld.aggregateRating ? ld.aggregateRating.ratingValue : null;
  const ratingCount = ld.aggregateRating ? ld.aggregateRating.ratingCount : null;
  const thumb = ld.thumbnailUrl && ld.thumbnailUrl[0];
  const servers = [];
  const nameRe = /data-server-name="([^"]*)"/g, srcRe = /data-server-src="([^"]*)"/g;
  const names = [], srcs = [];
  let x;
  while ((x = nameRe.exec(html))) names.push(x[1]);
  while ((x = srcRe.exec(html))) srcs.push(x[1].replace(/&amp;/g, '&'));
  for (let i = 0; i < srcs.length; i++) servers.push({ name: names[i] || ('Server ' + (i + 1)), src: srcs[i] });
  let imdb = null;
  const imdbM = html.match(/embedmaster[^? ]*?\/(movie|tv)\/(tt\d+)/) || html.match(/xps\?imdb=(tt\d+)/);
  if (imdbM) imdb = imdbM[2] || imdbM[1];
  const genres = [];
  const genreBlock = html.match(/<strong>Genre:<\/strong>([\s\S]*?)<\/p>/);
  if (genreBlock) {
    const gRe = /href="\/genre\/[^"]*"[^>]*>([^<]+)</g;
    let g;
    while ((g = gRe.exec(genreBlock[1]))) {
      const t = decodeEntities(g[1]).trim();
      if (t && !genres.includes(t)) genres.push(t);
    }
  }
  let seasons = null;
  if (fallback.type === 'tv') {
    seasons = [];
    const sRe = /<option value="(\d+)"[^>]*data-episode-count="(\d+)"[^>]*>([^<]*)/g;
    let s;
    while ((s = sRe.exec(html))) seasons.push({ num: parseInt(s[1], 10), label: s[3].trim() || ('Season ' + s[1]), episodes: Array.from({ length: parseInt(s[2], 10) }, (_, i) => i + 1) });
    if (seasons.length === 0) seasons = null;
  }
  return { name, desc, year, rating, ratingCount, thumb, servers, genres, seasons, duration: ld.duration || null, imdb };
}
function dedupe(items) {
  const seen = new Set();
  return items.filter((i) => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
}

async function getList(section, page = 1) {
  const url = page > 1 ? `${BASE}/${section}/page/${page}/` : `${BASE}/${section}/`;
  const r = await fget(url, { timeoutMs: 20000 });
  if (!r.ok) return { ok: false, items: [] };
  const items = parseCards(r.body);
  return { ok: items.length > 0, items };
}
async function getSearch(query) {
  const url = `${BASE}/search/?q=${encodeURIComponent(query)}`;
  const r = await fget(url, { timeoutMs: 20000 });
  if (!r.ok) return { ok: false, items: [] };
  return { ok: true, items: dedupe(parseCards(r.body)) };
}
async function getDetail(type, id, slug) {
  const path = type === 'tv' ? 'tv-series' : 'movie';
  const r = await fget(`${BASE}/${path}/${slug || id}-${id}/`, { timeoutMs: 20000 });
  if (!r.ok) return { ok: false };
  return { ok: true, ...parseDetails(r.body, { title: slug || String(id), type }), related: parseRelated(r.body) };
}

// ---------------- edge cache (Cache API = disk cache of the Node server) ----------------
const CACHE = caches.default;
async function cacheGet(key) {
  try { return await CACHE.match(new Request(`https://cine.cache/${encodeURIComponent(key)}`)); } catch { return null; }
}
async function cachePut(key, data, ttl, headers = { 'Content-Type': 'application/json' }) {
  try {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    await CACHE.put(new Request(`https://cine.cache/${encodeURIComponent(key)}`),
      new Response(body, { headers: { 'Cache-Control': CH(ttl), ...headers }, cf: { cacheTtl: ttl } }));
  } catch { /* cache down — non fatal */ }
}
async function cacheJson(key, ttl) {
  const r = await cacheGet(key);
  if (!r) return null;
  try { return JSON.parse(await r.text()); } catch { return null; }
}

// ---------------- catalog (KV snapshot + lazy self-heal) ----------------
const catalog = { movies: [], tv: [], top: [], anime: [], animeTs: 0 };
let topDetailed = [];
let catTs = 0, building = false, builtOnce = false;
// module-level helpers can't see the per-request env/ctx — capture them at fetch entry
let STATE = { env: null, ctx: null };

function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function enrichItem(item, d) {
  return {
    ...item, year: d.year, rating: d.rating, ratingCount: d.ratingCount,
    desc: d.desc, genres: d.genres, imdb: d.imdb, duration: d.duration,
    backdrop: d.thumb || (item.poster || '').replace('/w500/', '/w1280/'),
    posterSm: (item.poster || '').replace('/w500/', '/w342/'),
  };
}
function trimItem(it) {
  const th = topDetailed.find((d) => d.id === it.id && d.type === it.type);
  if (th) return th;
  return { ...it, posterSm: (it.poster || '').replace('/w500/', '/w342/') };
}
function newReleases(items = [], limit = 24) {
  const seen = new Set(); const out = [];
  for (const it of items) {
    const k = it.id + ':' + it.type;
    if (seen.has(k)) continue;
    seen.add(k); out.push(it);
    if (out.length >= limit) break;
  }
  return out.map(trimItem);
}

async function loadCatalog() {
  if (builtOnce && Date.now() - catTs < 60_000) return;
  builtOnce = true;
  try {
    const j = await (STATE.env.KV ? STATE.env.KV.get('catalog', 'json') : null);
    if (j) {
      catalog.movies = j.movies || []; catalog.tv = j.tv || [];
      catalog.top = j.top || []; catalog.anime = shuffleArr(j.anime || []);
      catalog.animeTs = j.animeTs || 0; topDetailed = j.topDetailed || [];
      catTs = j.ts || Date.now();
      // stale catalog -> rebuild in the background (6h TTL)
      if (Date.now() - catTs > CATALOG_TTL * 1000) kickBuild(true);
      return;
    }
    kickBuild(true); // nothing on KV yet -> build
  } catch { /* KV missing in dev */ }
}
function kickBuild(quick) {
  if (building) return;
  building = true;
  STATE.ctx.waitUntil(warm(quick).then(() => { building = false; }).catch(() => { building = false; }));
}

async function ensurePage(section, page) {
  const ck = `page:${section}:${page}`;
  const cached = await cacheJson(ck, PAGE_TTL);
  if (cached) return cached;
  let items = [];
  const urlSection = { movies: 'movies', tv: 'tv-series', top: 'top-imdb' }[section] || section;
  for (let attempt = 0; attempt < 3 && !items.length; attempt++) {
    const r = await getList(urlSection, page);
    items = r.items || [];
    if (!items.length) await new Promise((r) => setTimeout(r, 1000 + attempt * 1000));
  }
  if (items.length) await cachePut(ck, items, PAGE_TTL);
  return items;
}

// anime crawl — port of server.js buildAnime (batched searches + genre gate)
const ANIME_QUERIES = [
  'naruto', 'one piece', 'attack on titan', 'demon slayer', 'jujutsu kaisen',
  'bleach', 'dragon ball', 'death note', 'fullmetal alchemist', 'chainsaw man',
  'spy x family', 'one punch man', 'tokyo ghoul', 'my hero academia',
  'hunter x hunter', 'berserk', 'frieren', 'solo leveling', 'vinland saga',
  'sword art online', 'black clover', 'tokyo revengers', 'code geass',
  'cowboy bebop', 'steins gate', 'dandadan', 'oshi no ko', 'kaiju no 8',
  'hells paradise', 'fruits basket', 'boruto', 'jojo', 'monster', 'flcl',
  'no game no life', 'parasyte', 'ergo proxy',
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
function animeMatch(it, q) {
  const t = (it.title || '').toLowerCase();
  const ql = q.toLowerCase();
  const words = ql.split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 1) return new RegExp(`(^|[^a-z0-9])${words[0]}([^a-z0-9]|$)`).test(t);
  if (t.includes(ql)) return true;
  if (words.length < 2) return false;
  const titleWords = t.split(/[^a-z0-9]+/).filter(Boolean);
  if (titleWords.length >= words.length * 2 + 1) return false;
  return words.every((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(t));
}
async function buildAnime() {
  const seen = new Map();
  const pick = (it) => {
    const key = (it.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) return;
    const cur = seen.get(key);
    if (!cur) seen.set(key, it);
    else if (!cur.poster && it.poster) seen.set(key, it);
  };
  for (let i = 0; i < ANIME_QUERIES.length; i += 6) {
    await Promise.all(ANIME_QUERIES.slice(i, i + 6).map(async (q) => {
      try {
        const r = await getSearch(q);
        for (const it of (r.items || [])) if (animeMatch(it, q)) pick(it);
      } catch { /* one bad query */ }
    }));
    if (i + 6 < ANIME_QUERIES.length) await new Promise((r) => setTimeout(r, 150));
    catalog.anime = Array.from(seen.values());
  }
  const staged = Array.from(seen.values());
  const kept = [];
  const isAnime = (d) => !d.genres || !d.genres.length || d.genres.some((g) => /anim/i.test(g));
  for (let i = 0; i < staged.length; i += 8) {
    const details = await Promise.all(staged.slice(i, i + 8).map(async (it) => {
      const ck = `detail:${it.type}:${it.id}`;
      const cached = await cacheJson(ck, DETAIL_TTL);
      if (cached && cached.ok) return cached;
      const r = await getDetail(it.type, it.id, it.slug);
      if (r.ok) await cachePut(ck, r, DETAIL_TTL);
      return r;
    }));
    staged.slice(i, i + 8).forEach((it, idx) => {
      const d = details[idx];
      if (d.ok && !isAnime(d)) return;
      kept.push(d.ok ? enrichItem(it, d) : it);
    });
    catalog.anime = kept;
    await new Promise((r) => setTimeout(r, 150));
  }
  catalog.anime = shuffleArr(kept);
  catalog.animeTs = Date.now();
}

async function refreshHeroPool() {
  const limit = 18;
  const pool = catalog.top.length ? catalog.top : catalog.movies;
  const seen = new Set();
  const uniq = pool.filter((it) => {
    const k = it.type + ':' + it.id;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  if (uniq.length < limit) return;
  const out = [];
  const n = Math.min(limit, uniq.length);
  for (let i = 0; i < n; i++) {
    const it = uniq[i];
    const ck = `detail:${it.type}:${it.id}`;
    const cached = await cacheJson(ck, DETAIL_TTL);
    if (cached && cached.ok) { out.push(enrichItem(it, cached)); continue; }
    const r = await getDetail(it.type, it.id, it.slug);
    if (r.ok) { await cachePut(ck, r, DETAIL_TTL); out.push(enrichItem(it, r)); }
    else out.push(it);
    await new Promise((r) => setTimeout(r, 300));
  }
  topDetailed = out;
}

// ---------- warm: rebuild catalog (movies/tv/top fast; anime optional crawl) ----------
async function warm(quick) {
  const ckHome = 'page:movies:1', ckHomeTv = 'page:tv:1', ckTop = 'page:top:1';
  const [m, tv, top] = await Promise.all([ensurePage('movies', 1), ensurePage('tv', 1), ensurePage('top', 1)]);
  catalog.movies = m; catalog.tv = tv; catalog.top = top;
  if (!quick) {
    await buildAnime();
    await refreshHeroPool();
  } else {
    try { await refreshHeroPool(); } catch { /* fine */ }
  }
  const snap = { ts: Date.now(), movies: catalog.movies, tv: catalog.tv, top: catalog.top, anime: catalog.anime, animeTs: catalog.animeTs || 0, topDetailed };
  if (STATE.env.KV) await STATE.env.KV.put('catalog', JSON.stringify(snap));
  catTs = snap.ts;
  return snap;
}

// ---------------- stream resolution (port of stream.js, fetch instead of curl) ----------------
function resolvePlaylist(url, referer) {
  return fget(url, { ref: referer, timeoutMs: 15000, ua: EMBED_UA }).then((r) => {
    if (!r.ok) return [];
    const body = r.body.replace(/\\u0026/g, '&');
    let data;
    try { data = JSON.parse(body); } catch { return []; }
    const out = [];
    for (const p of data.playlist || []) {
      for (const s of p.sources || []) {
        const f = s.file;
        if (f && f.startsWith('http')) out.push({ file: f, label: s.label || '' });
      }
    }
    return out;
  });
}
async function liveM3u8(url, timeoutMs = 10000) {
  const r = await fget(url, { timeoutMs, ua: EMBED_UA });
  const body = r.body || '';
  const live = r.ok && body.startsWith('#EXTM3U');
  const langs = [];
  if (live) {
    const re = /#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/g;
    let m;
    while ((m = re.exec(body))) {
      const name = /NAME="([^"]*)"/.exec(m[0]);
      const lang = /LANGUAGE="([^"]*)"/.exec(m[0]);
      if (lang && !langs.includes(lang[1])) langs.push(lang[1]);
      else if (name && !langs.includes(name[1])) langs.push(name[1]);
    }
  }
  return { live, body, langs };
}
async function vidsrcExtra(tmdb, max = 5) {
  try {
    const embed = `${VSRC}/embed/movie/${tmdb}`;
    const r = await fget(embed, { timeoutMs: 12000 });
    if (!r.ok) return [];
    const m = /var Q = (\{.*?\})\s*[;<]/.exec(r.body);
    let Q;
    try { Q = m && JSON.parse(m[1]); } catch {}
    if (!Q || !Q.t || !Q.id) return [];
    const t = encodeURIComponent(Q.t);
    const src = await fget(`${VSRC}/api.php?a=sources&type=movie&id=${Q.id}&s=0&e=0&t=${t}`, { ref: embed, timeoutMs: 12000 });
    let j;
    try { j = JSON.parse(src.body); } catch {}
    if (!j || !j.servers || !j.servers.length) return [];
    const out = [];
    for (const s of j.servers.slice(0, max)) {
      try {
        let d = null;
        for (let k = 0; k < 2 && !d; k++) {
          const pl = await fget(`${VSRC}/api.php?a=play&ref=${encodeURIComponent(s.ref)}`, { ref: embed, timeoutMs: 12000 });
          try { d = JSON.parse(pl.body); } catch { if (k === 0) await new Promise((r) => setTimeout(r, 700)); }
        }
        if (!d || !d.url || !d.url.startsWith('http')) continue;
        const { live } = await liveM3u8(d.url, 10000);
        if (live) {
          const name = s.name || 'vidsrc';
          out.push({ master: d.url, server: 'vidsrc · ' + name, label: name, audio: 0, langs: [] });
        }
      } catch { /* broken server */ }
    }
    return out;
  } catch { return []; }
}
async function pruneServers(list, timeoutMs = 8000) {
  const alive = [];
  await Promise.all((list || []).slice(0, 10).map(async (s) => {
    try {
      const { live } = await liveM3u8(s.master, timeoutMs);
      if (live) alive.push(s);
    } catch { /* dead token */ }
  }));
  return alive;
}
async function resolveMovie(id, firstOnly = false) {
  const PL_TIMEOUT = 15000, PROBE_TIMEOUT = 12000, CONC = 10, ATTEMPTS = 2;
  let lastErr = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const embed = EMBED.replace('{id}', id);
      const r = await fget(embed, { timeoutMs: 15000 });
      if (!r.ok) throw new Error('embed failed');
      const html = r.body;
      const xps = [];
      let m;
      const goRe = /go\('(https:\/\/streamsrcs\.2embed\.cc\/[^']*)'\)/g;
      while ((m = goRe.exec(html))) xps.push(m[1]);
      m = /data-src="([^"]*)"/.exec(html);
      if (m && m[1].includes('streamsrcs')) xps.push(m[1]);
      if (!xps.length) return null;
      m = /tmdb=(\d+)/.exec(html);
      const tmdb = m ? m[1] : (/^\d+$/.test(id) ? id : '');
      if (!tmdb) throw new Error('no tmdb in embed page');
      let imdb = ((html.match(/imdb[=:]["']?(tt\d+)/) || [])[1]) || null;
      if (!imdb) {
        const detail = await cacheJson(`detail:movie:${id}`, DETAIL_TTL);
        if (detail && detail.imdb) imdb = detail.imdb;
      }
      const xpass = XPASS.replace('{tmdb}', imdb || tmdb);
      const pages = await Promise.all([
        fget(XPASS.replace('{tmdb}', imdb || tmdb), { ref: embed, timeoutMs: 15000 }),
        imdb && imdb !== tmdb ? fget(XPASS.replace('{tmdb}', tmdb), { ref: embed, timeoutMs: 15000 })
          : Promise.resolve({ ok: false, body: '', status: 0 }),
      ]);
      const seenBk = new Set();
      const backups = [];
      for (const pr of pages) {
        const ph = pr.body;
        if (!ph.includes('backups=')) continue;
        m = /backups=\s*\[/.exec(ph);
        if (!m) continue;
        const start = m.index + m[0].length - 1;
        const seg = ph.slice(start, ph.indexOf('</script>', start));
        const end = seg.lastIndexOf(']');
        if (end <= 0) continue;
        try {
          const arr = JSON.parse(seg.slice(0, end + 1));
          for (const b of arr) {
            const u = b.url || '';
            if (!u || seenBk.has(u)) continue;
            seenBk.add(u);
            backups.push({ name: b.name || '?', url: u.startsWith('http') ? u : 'https://play.xpass.top' + u });
          }
        } catch { /* skip */ }
      }
      if (!backups.length) throw new Error('no backups');
      const lists = await Promise.all(backups.map((b) => resolvePlaylist(b.url, xpass, PL_TIMEOUT)));
      const sources = [];
      const seen = new Set();
      lists.forEach((list, i) => {
        for (const s of list) {
          if (seen.has(s.file)) continue;
          seen.add(s.file);
          sources.push({ server: backups[i].name, ...s });
        }
      });
      if (!sources.length) throw new Error('no sources resolved');
      const pool = sources.slice();
      const alive = [];
      const worker = async () => {
        while (pool.length) {
          const s = pool.shift();
          try {
            const { live, body, langs } = await liveM3u8(s.file, PROBE_TIMEOUT);
            if (!live) continue;
            const audio = (body.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length;
            const entry = { master: s.file, server: s.server, label: s.label, audio: audio || 0, langs };
            if (firstOnly) { alive.push(entry); return; }
            alive.push(entry);
          } catch { /* probe failed */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONC, pool.length) }, worker));
      if (!alive.length && !firstOnly) alive.push(...(await vidsrcExtra(tmdb)));
      if (alive.length) {
        if (!firstOnly) {
          alive.sort((a, b) => (b.audio > 0 ? 1 : 0) - (a.audio > 0 ? 1 : 0));
          alive.push(...(await vidsrcExtra(tmdb)));
        }
        const servers = firstOnly ? alive.slice(0, 1) : alive.slice(0, 10);
        const out = { servers, referer: xpass, tmdb, attempt: attempt + 1, probing: firstOnly };
        out.master = out.servers[0].master;
        return out;
      }
      lastErr = new Error('no live m3u8 among sources');
    } catch (e) { lastErr = e; }
    if (attempt < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 400 + attempt * 400));
  }
  throw lastErr;
}
const inflight = new Map();
async function getStream(type, id, s, e) {
  if (type === 'tv') return null;
  const key = /^\d+$/.test(String(id)) ? id : `tt-${id}`;
  const ck = `stream:${type}:${key}${s ? ':' + s : ''}${e ? ':' + e : ''}`;
  const cache = await cacheJson(ck, STREAM_TTL);
  if (cache && cache.master) {
    const list = (cache.servers && cache.servers.length)
      ? cache.servers
      : (cache.master ? [{ master: cache.master, server: 'VIP 1', label: 'VIP 1', audio: cache.audio || 0 }] : []);
    const alive = await pruneServers(list);
    if (alive.length) return { ...cache, servers: alive };
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const r = await resolveMovie(id, true);
    await cachePut(ck, r, STREAM_TTL);
    resolveMovie(id, false)
      .then(async (full) => {
        const servers = await pruneServers(full.servers || []);
        await cachePut(ck, { ...r, ...full, servers: servers.length ? servers : [r.servers[0]], probing: false }, STREAM_TTL);
      })
      .catch(() => { /* keep fast result */ });
    return r;
  })();
  inflight.set(key, p);
  p.finally(() => inflight.delete(key)).catch(() => {});
  return p;
}

// ---------------- embed sources probe (port of embedSources + srcProbe) ----------------
function embedSources(type, id, s, e) {
  const key = String(id);
  if (type === 'tv') {
    return [
      // VidEasy first = auto-picked source, same as 7reels (default videasy)
      { name: 'VidEasy', url: `https://player.videasy.net/tv/${id}/${s}/${e}?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=true&overlay=true&color=16A085` },
      { name: '2Embed', url: `https://www.2embed.cc/embedtv/${key}-${s}-${e}` },
      { name: 'Vidsrc.hair', url: `https://vidsrc.hair/embed/tv/${key}/${s}/${e}` },
      { name: 'VidAPI', url: `https://vidapi.xyz/embed/tv/${id}/${s}/${e}` },
      { name: 'Vidsrc.pm', url: `https://vidsrc.pm/embed/tv/${key}/${s}/${e}` },
      { name: 'vsembed', url: `https://vsembed.ru/embed/tv/${key}/${s}/${e}` },
      { name: 'VidLink', url: `https://vidlink.pro/tv/${id}/${s}/${e}?autoplay=true&title=true` },
      { name: 'VidUp', url: `https://vidup.to/tv/${id}/${s}/${e}?autoPlay=true&theme=16A085&nextButton=true&autoNext=true&sub=en` },
      { name: 'Vidsrc.mov', url: `https://vidsrc.mov/embed/tv/${id}/${s}/${e}` },
      { name: 'Vidsrc.fyi', url: `https://vidsrc.fyi/embed/tv/${id}/${s}/${e}` },
      { name: 'VidRock', url: `https://vidrock.net/tv/${id}/${s}/${e}` },
      { name: 'VidNest', url: `https://vidnest.fun/tv/${id}/${s}/${e}` },
      { name: 'VidKing', url: `https://www.vidking.net/embed/tv/${id}/${s}/${e}` },
    ];
  }
  return [
    // VidEasy first = auto-picked source, same as 7reels (default videasy)
    { name: 'VidEasy', url: `https://player.videasy.net/movie/${id}?overlay=true&color=16A085` },
    { name: '2Embed', url: `https://www.2embed.cc/embed/${key}` },
    { name: 'Vidsrc.pm', url: `https://vidsrc.pm/embed/movie/${key}` },
    { name: 'vsembed', url: `https://vsembed.ru/embed/movie/${key}` },
    { name: 'VidAPI', url: `https://vidapi.xyz/embed/movie/${id}` },
    { name: 'Vidsrc.hair', url: `https://vidsrc.hair/embed/movie/${key}` },
    { name: 'VidLink', url: `https://vidlink.pro/movie/${id}?autoplay=true&title=true` },
    { name: 'VidUp', url: `https://vidup.to/movie/${id}?autoPlay=true&theme=16A085&nextButton=true&autoNext=true&sub=en` },
    { name: 'VidCore', url: `https://vidcore.net/movie/${id}` },
    { name: 'Vidsrc.mov', url: `https://vidsrc.mov/embed/movie/${id}` },
    { name: 'Vidsrc.fyi', url: `https://vidsrc.fyi/embed/movie/${id}` },
    { name: 'VidRock', url: `https://vidrock.net/movie/${id}` },
    { name: 'VidNest', url: `https://vidnest.fun/movie/${id}` },
    { name: 'VidKing', url: `https://www.vidking.net/embed/movie/${id}` },
    { name: 'Peachify', url: `https://peachify.top/embed/movie/${id}` },
  ];
}
async function srcProbe(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': EMBED_UA }, signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

// ---------------- HLS proxy (the catch lives here) ----------------
function hlsProxyUrl(abs, ref, origin) {
  return `${origin}/api/hls?url=${encodeURIComponent(abs)}${ref ? '&ref=' + encodeURIComponent(ref) : ''}`;
}
function rewritePlaylist(body, baseUrl, ref, origin) {
  const proxify = (u) => {
    try { return hlsProxyUrl(new URL(u, baseUrl).toString(), ref, origin); }
    catch { return u; }
  };
  return body.split('\n').map((line) => {
    if (line.startsWith('#')) {
      if (/URI=/.test(line) && !line.startsWith('#EXT-X-DISCONTINUITY')) {
        return line.replace(/URI="([^"]*)"/g, (_, u) => `URI="${proxify(u)}"`);
      }
      return line;
    }
    if (line.trim().length) return proxify(line);
    return line;
  }).join('\n');
}

// ---------------- auto-guard (100k/day meter) ----------------
let dayCount = 0, dayKey = '', lastFlush = 0, locked = false, bootLockCheck = true;
function todayKey() {
  const d = new Date();
  return `day:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function guardInit() {
  dayKey = todayKey();
  try {
    if (STATE.env.KV) {
      const [c, l] = await Promise.all([STATE.env.KV.get(dayKey), STATE.env.KV.get('locked:' + dayKey)]);
      dayCount = parseInt(c || '0', 10) || 0;
      locked = l === '1';
    }
  } catch { /* dev */ }
}
async function guardFlush() {
  if (!STATE.env.KV) return;
  try {
    await STATE.env.KV.put(dayKey, String(dayCount));
    const l = await STATE.env.KV.get('locked:' + dayKey);
    locked = l === '1';
  } catch { }
}
function guardTick() {
  dayCount++;
  if (Date.now() - lastFlush > 180_000) { // KV write budget: ~480/day, far under the 1k/day cap
    lastFlush = Date.now();
    STATE.ctx.waitUntil(guardFlush());
  }
}
async function guardLockIfNeeded() {
  if (locked || dayCount < 90_000) return;
  locked = true;
  if (STATE.env.KV) await STATE.env.KV.put('locked:' + dayKey, '1');
}

// ---------------- request router ----------------
async function handleRequest(request, ctx, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  guardTick();
  const json = (obj, status = 200, cacheSec = 0) => {
    const r = new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
        'Cache-Control': cacheSec ? CH(cacheSec) : 'no-store' },
    });
    return r;
  };

  // ------- static assets (browsers + edge cache; 0 worker burns on hits) -------
  if (!path.startsWith('/api/') && !path.startsWith('/watch/')) {
    const res = await (env.ASSETS ? env.ASSETS.fetch(request) : new Response('assets binding missing', { status: 500 }));
    const r = new Response(res.body, { status: res.status, headers: res.headers });
    r.headers.set('Cache-Control', CH(86400));
    return r;
  }
  if (path.startsWith('/watch/')) {
    const res = await (env.ASSETS ? env.ASSETS.fetch(new Request(new URL('/watch.html', request.url))) : new Response('missing', { status: 500 }));
    const r = new Response(res.body, { status: res.status, headers: res.headers });
    r.headers.set('Cache-Control', CH(86400));
    return r;
  }

  // ------- /api/health -------
  if (path === '/api/health') return json({ ok: true, booted: true }, 200, 60);

  // ------- /api/guard — daily meter (secret) -------
  if (path === '/api/guard') {
    if (request.headers.get('x-guard-key') !== (env.WARM_KEY || '')) return json({ ok: false }, 403);
    return json({ ok: true, day: dayKey, count: dayCount, locked, catalog: { movies: catalog.movies.length, tv: catalog.tv.length, top: catalog.top.length, anime: catalog.anime.length, topDetailed: topDetailed.length, ts: catTs } });
  }

  // ------- /api/warm — rebuild catalog (secret) -------
  if (path === '/api/warm') {
    if (request.headers.get('x-warm-key') !== (env.WARM_KEY || '')) return json({ ok: false }, 403);
    if (building) return json({ ok: true, building: true });
    building = true;
    try {
      const quick = url.searchParams.get('quick') === '1';
      const snap = await warm(quick);
      return json({ ok: true, building: false, quick, ...snap.stats }, 200, 60);
    } catch (e) {
      return json({ ok: false, error: e.message }, 502);
    } finally { building = false; }
  }

  // ------- /api/home -------
  if (path === '/api/home') {
    await loadCatalog();
    const rows = [
      { key: 'top', title: 'Top Rated', cat: 'top', items: shuffleArr(catalog.top).slice(0, 16).map(trimItem) },
      { key: 'new', title: 'New Releases', cat: 'new', items: newReleases([...catalog.movies, ...catalog.tv]) },
      { key: 'anime', title: 'Anime', cat: 'anime', items: shuffleArr(catalog.anime).slice(0, 22).map(trimItem) },
      { key: 'movies', title: 'Movies', cat: 'movies', items: shuffleArr(catalog.movies).slice(0, 22).map(trimItem) },
      { key: 'tv', title: 'TV Series', cat: 'tv', items: shuffleArr(catalog.tv).slice(0, 22).map(trimItem) },
    ];
    return json({ booted: true, hero: shuffleArr(topDetailed).slice(0, 12), rows }, 200, 600);
  }

  // ------- /api/browse -------
  if (path === '/api/browse') {
    const section = String(url.searchParams.get('section') || 'movies');
    let page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    if (!['movies', 'tv', 'top', 'anime'].includes(section)) return json({ ok: false }, 400);
    try {
      if (section === 'anime') {
        await loadCatalog();
        const size = 24;
        const maxPage = Math.max(1, Math.ceil(catalog.anime.length / size));
        page = Math.min(page, maxPage);
        return json({ ok: true, section, page, maxPage, items: catalog.anime.slice((page - 1) * size, page * size).map(trimItem) }, 200, 600);
      }
      page = Math.min(page, 250);
      let items;
      if (page === 1) {
        await loadCatalog();
        items = catalog[section].slice(0, 22);
        if (!items.length) items = await ensurePage(section, 1);
      } else {
        items = await ensurePage(section, page);
      }
      return json({ ok: true, section, page, items: items.map(trimItem) }, 200, 900);
    } catch (e) { return json({ ok: false, error: e.message }, 502); }
  }

  // ------- /api/search -------
  if (path === '/api/search') {
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) return json({ ok: false, items: [] });
    try {
      const r = await getSearch(q);
      return json({ ok: r.ok, items: r.items.map((i) => ({ ...i, poster: (i.poster || '').replace('/w500/', '/w342/') })) }, 200, 300);
    } catch (e) { return json({ ok: false, error: e.message }, 502); }
  }

  // ------- /api/detail/:type/:id -------
  let m = path.match(/^\/api\/detail\/(movie|tv)\/(\d+)$/);
  if (m) {
    const type = m[1], id = parseInt(m[2], 10);
    if (!id) return json({ ok: false }, 400);
    const ck = `detail:${type}:${id}`;
    let d = await cacheJson(ck, DETAIL_TTL);
    if (d && d.ok && !d.related) {
      try {
        const r = await getDetail(type, id);
        if (r.ok && Array.isArray(r.related)) { d = r; await cachePut(ck, r, DETAIL_TTL); }
      } catch { }
    }
    if (!d || !d.ok) {
      try {
        const r = await getDetail(type, id);
        if (!r.ok) return json({ ok: false, id }, 404);
        d = r; await cachePut(ck, r, DETAIL_TTL);
      } catch (e) { return json({ ok: false, error: e.message }, 502); }
    }
    await loadCatalog();
    let poster = d.poster || d.thumb;
    if (!d.poster) {
      const catItem = (catalog.movies || []).concat(catalog.tv || [], catalog.anime || [])
        .find((i) => i.type === type && i.id === id);
      if (catItem && catItem.poster) poster = catItem.poster;
    }
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
    return json({ type, id, ...d, title: d.title || d.name, poster, related }, 200, 3600);
  }

  // ------- /api/stream/:type/:id/... -------
  m = path.match(/^\/api\/stream\/(movie|tv)\/([^/]+)(?:\/(\d+))?(?:\/(\d+))?$/);
  if (m) {
    const type = m[1], id = m[2], s = m[3], e = m[4];
    if (!id) return json({ ok: false }, 400);
    try {
      const st = await getStream(type, id, s, e);
      if (!st) return json({ ok: true, stream: false, tv: true }, 200, 60);
      const i = parseInt(id, 10) ? parseInt(id, 10) : id;
      const origin = url.origin;
      const list = (st.servers && st.servers.length ? st.servers : [{ master: st.master, server: st.server || 'VIP 1', label: st.label || 'VIP 1', audio: st.audio || 0 }])
        .map((v) => ({
          src: hlsProxyUrl(v.master, st.referer, origin),
          server: v.server, label: v.label,
          audio: v.audio || 0, langs: v.langs || [],
        }));
      if (!list.length) return json({ ok: true, stream: false, reason: 'no live servers' });
      return json({
        ok: true, stream: true, type, id: i,
        src: list[0].src, servers: list,
        server: list[0].server, label: list[0].label,
        audio: Math.max(0, ...list.map((v) => v.audio)),
        probing: Boolean(st.probing),
      }, 200, 30);
    } catch (e) { return json({ ok: false, error: e.message }, 502); }
  }

  // ------- /api/sources -------
  if (path === '/api/sources') {
    const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
    const id = String(url.searchParams.get('id') || '');
    const s = Math.max(1, parseInt(url.searchParams.get('s'), 10) || 1);
    const e = Math.max(1, parseInt(url.searchParams.get('e'), 10) || 1);
    if (!id || !/^\d+$/.test(id)) return json({ ok: false }, 400);
    const ck = `sources:${type}:${id}:${s}:${e}`;
    const cached = await cacheJson(ck, 15 * 60);
    if (cached) return json({ ok: true, cached: true, ...cached }, 200, 900);
    const list = embedSources(type, id, s, e);
    try {
      const results = await Promise.all(list.map((x) => srcProbe(x.url)));
      const out = { ts: Date.now(), list: list.map((x, i) => ({ ...x, ok: results[i] })) };
      await cachePut(ck, out, 15 * 60);
      return json({ ok: true, cached: false, ...out }, 200, 900);
    } catch (err) { return json({ ok: false, error: err.message }, 502); }
  }

  // ------- /api/hls — the video proxy (30d edge cache) -------
  if (path === '/api/hls') {
    const up = String(url.searchParams.get('url') || '');
    if (!/^https?:\/\//.test(up)) return json({ ok: false, error: 'bad url' }, 400);
    const ref = String(url.searchParams.get('ref') || HLS_REF);
    // guard: cached-only mode when the day budget is nearly exhausted
    if (locked) {
      const hit = await cacheGet('hls:' + up + '|' + ref);
      if (hit) {
        const r = new Response(hit.body, { status: 200, headers: hit.headers });
        r.headers.set('Cache-Control', CH(2592000));
        return r;
      }
      return json({ ok: false, error: 'guard: budget cap reached' }, 503, 0);
    }
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 25000);
      const ures = await fetch(up, {
        headers: { 'User-Agent': UA, Referer: ref, Accept: '*/*' },
        redirect: 'follow', signal: ctl.signal,
      });
      clearTimeout(t);
      if (!ures.ok || !ures.body) return json({ ok: false, error: 'upstream ' + ures.status }, 502, 0);
      const body = await ures.text();
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Length',
      };
      if (body.startsWith('#EXTM3U')) {
        headers['Content-Type'] = 'application/vnd.apple.mpegurl; charset=utf-8';
        headers['Cache-Control'] = CH(600); // playlists: 10 min — cheap (a few per session)
        return new Response(rewritePlaylist(body, up, ref, url.origin), { status: 200, headers });
      }
      const ext = (up.split('?')[0].match(/\.(\w+)$/) || [])[1];
      headers['Content-Type'] = MIME[ext] || 'application/octet-stream';
      headers['Cache-Control'] = CH(2592000); // segments: 30 days — the catch
      return new Response(body, { status: 200, headers });
    } catch (e) { return json({ ok: false, error: e.message }, 502); }
  }

  return json({ ok: false, error: 'not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    STATE = { env, ctx };
    if (bootLockCheck) { bootLockCheck = false; ctx.waitUntil(guardInit()); }
    await guardLockIfNeeded();
    return handleRequest(request, ctx, env);
  },
};