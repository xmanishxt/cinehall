// mflix.js — MovieFlix source integration for CineHall.
// Catalog: data/movieflix.json (dumped from https://movieshd-53836.firebaseio.com)
// Playback: all content is YouTube videoIds. Resolve a direct stream URL via
// yt-dlp (cookies first for full quality, android client as fallback) and
// optionally remux DASH audio+video into a single fMP4 via ffmpeg for HD.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { fuzzyMatch } = require('./fuzzy');

const CATALOG = path.join(__dirname, 'data', 'movieflix.json');
const COOKIES = '/data/data/com.termux/files/home/.youtube-cookies.txt';
const CACHE_DIR = path.join(__dirname, 'data', 'cache');
const META_TTL = 10 * 60 * 1000; // in-memory
const DISK_TTL = 24 * 3600 * 1000;

let CAT = null;

function loadCatalog() {
  if (CAT) return CAT;
  try {
    CAT = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    // dump contains a handful of sponsor/ad rows whose id isn't a YouTube id — drop them
    CAT.movies = CAT.movies.filter((m) => /^[A-Za-z0-9_-]{11}$/.test(m.id || ''));
    CAT.seriesByTitle = new Map();
    for (const s of CAT.series) CAT.seriesByTitle.set(s.title.trim().toLowerCase(), s);
    CAT.movieById = new Map();
    for (const m of CAT.movies) CAT.movieById.set(m.id, m);
    // MovieBox stores each language dub as a separate catalog entry with its
    // own YouTube videoId — group same-titled entries so the watch page can
    // offer an in-app language switch (chip -> other videoId).
    CAT.titleVersions = new Map();
    for (const m of CAT.movies) {
      const key = norm(m.title);
      if (!CAT.titleVersions.has(key)) CAT.titleVersions.set(key, new Map());
      const byLang = CAT.titleVersions.get(key);
      if (!byLang.has(m.lang || '')) byLang.set(m.lang || '', m);
    }
    return CAT;
  } catch (e) {
    console.error('[mflix] catalog load failed:', e.message);
    return { movies: [], series: [], seriesByTitle: new Map(), movieById: new Map() };
  }
}

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const MOVIE_LANGS = ['Bollywood', 'South', 'English', 'French', 'Spanish', 'Chinese', 'Korean', 'Gujarati'];
const SERIES_LANGS = ['Hindi', 'English', 'Marathi', 'Telugu', 'Tamil', 'Gujarati', 'Bengali', 'Punjabi', 'French', 'Spanish', 'Korean', 'Portuguese'];

function exec(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(new Error(String(err.stderr || err.message || '').slice(0, 300)));
      else resolve(stdout);
    });
  });
}

// ---------------- catalog queries ----------------

function card(m) {
  if (m.type === 'series') {
    const first = m.eps[0] && m.eps[0].id;
    return {
      type: 'series',
      id: m.title, // series keyed by title
      title: m.title,
      lang: m.lang || '',
      epCount: m.eps.length,
      thumb: first ? `https://i.ytimg.com/vi/${first}/hqdefault.jpg` : '',
    };
  }
  const c = CAT;
  const out = {
    type: 'movie',
    id: m.id,
    title: m.title,
    lang: m.lang || '',
    desc: m.desc || '',
    thumb: m.thumb || '',
    cat: m.cat || '',
  };
  // same title dubbed in several languages -> list the alternate videoIds
  const byLang = c && c.titleVersions && c.titleVersions.get(norm(m.title));
  if (byLang && byLang.size > 1) {
    out.versions = [...byLang.values()]
      .sort((a, b) => ((a.lang || '') < (b.lang || '') ? -1 : 1))
      .map((v) => ({ lang: v.lang || '', id: v.id, thumb: v.thumb || '' }));
  }
  return out;
}

function browse(type, lang, page, perPage) {
  const c = loadCatalog();
  const list = type === 'series' ? c.series : c.movies;
  let items = list;
  if (lang && lang !== 'All') items = items.filter((it) => (it.lang || '') === lang);
  const total = items.length;
  const start = (page || 0) * perPage;
  return {
    items: items.slice(start, start + perPage).map(card),
    total,
    page: page || 0,
    perPage,
    langs: type === 'series' ? SERIES_LANGS : MOVIE_LANGS,
  };
}

function getMovie(id) {
  const m = loadCatalog().movieById.get(id);
  return m ? card(m) : null;
}

function getSeries(title) {
  const s = loadCatalog().seriesByTitle.get(title.trim().toLowerCase());
  if (!s) return null;
  return {
    type: 'series',
    title: s.title,
    lang: s.lang || '',
    eps: s.eps.map((e, i) => ({ n: i + 1, title: e.title, id: e.id, thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg` })),
  };
}

function searchMovieFlix(q) {
  const c = loadCatalog();
  const nq = norm(q);
  if (nq.length < 2) return [];
  const hits = [];
  for (const m of c.movies) if (norm(m.title).includes(nq)) hits.push(card(m));
  for (const s of c.series) if (norm(s.title).includes(nq)) hits.push(card(s));
  if (hits.length) return hits.slice(0, 30);
  // typo fallback: distance match over the local catalog, dedupes same-title dubs
  const pool = [
    ...c.movies.map((m) => ({ title: m.title, m })),
    ...c.series.map((s) => ({ title: s.title, s })),
  ];
  const out = [];
  const seen = new Set();
  for (const hit of fuzzyMatch(q, pool, { limit: 40, minScore: 0.55 })) {
    const t = (hit.m ? hit.m.title : hit.s.title).trim().toLowerCase();
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(hit.m ? card(hit.m) : card(hit.s));
  }
  return out.slice(0, 30);
}

// ---------------- yt-dlp resolution ----------------

const metaCache = new Map();

function cachePath(id) { return path.join(CACHE_DIR, `mflix-${id}.json`); }

async function ytMetadata(id) {
  const now = Date.now();
  const hit = metaCache.get(id);
  if (hit && now - hit.at < META_TTL) return hit.data;

  try {
    const d = JSON.parse(fs.readFileSync(cachePath(id), 'utf8'));
    if (now - d.at < DISK_TTL && d.data) { metaCache.set(id, { at: now, data: d.data }); return d.data; }
  } catch (e) { /* miss */ }

  const args = ['-J', '--no-playlist', '--no-warnings'];
  let haveCookies = false;
  try { haveCookies = fs.existsSync(COOKIES); } catch (e) {}
  const attempts = haveCookies
    ? [['--cookies', COOKIES], ['--extractor-args', 'youtube:player_client=android']]
    : [['--extractor-args', 'youtube:player_client=android']];
  let data = null;
  for (const extra of attempts) {
    try {
      data = JSON.parse(await exec('yt-dlp', [...extra, ...args, id], 45000));
      break;
    } catch (e) { /* try next */ }
  }
  if (!data) return null;
  const entry = { at: now, data };
  metaCache.set(id, entry);
  try { fs.writeFileSync(cachePath(id), JSON.stringify(entry)); } catch (e) {}
  return data;
}

function pickFormats(meta) {
  const fmts = meta.formats || [];
  let progressive = null; // combined video+audio
  let v720 = null; // video-only >= 720p for remux
  let bestVideo = null;
  let bestAudio = null;
  for (const f of fmts) {
    if (!f.url || f.protocol === 'mhtml') continue;
    const vc = f.vcodec || '';
    if (!vc || vc === 'none') {
      // audio-only track
      if (f.acodec && f.acodec !== 'none' && (!bestAudio || (f.abr || 0) > (bestAudio.abr || 0))) bestAudio = f;
      continue;
    }
    if (f.acodec && f.acodec !== 'none') {
      if (!progressive || (f.height || 0) > (progressive.height || 0)) progressive = f;
    } else {
      const h = f.height || 0;
      if (!bestVideo || h > (bestVideo.height || 0)) bestVideo = f;
      if (h >= 720 && h <= 1080 && (!v720 || h > (v720.height || 0) || (h === (v720.height || 0) && (f.fps || 0) > (v720.fps || 0)))) v720 = f;
    }
  }
  const video = v720 || bestVideo;
  const canRemux = !!(video && bestAudio);
  return { progressive, bestVideo: video, bestAudio, canRemux, title: meta.title || '', duration: meta.duration || 0 };
}

// GET stream info for a movie/episode videoId
async function streamInfo(id) {
  const meta = await ytMetadata(id);
  if (!meta) {
    return { ok: false, reason: 'Video unavailable', embed: `https://www.youtube.com/embed/${id}?autoplay=1` };
  }
  const p = pickFormats(meta);
  const sd = p.progressive ? { url: `/api/mflix/proxy?url=${encodeURIComponent(p.progressive.url)}`, type: p.progressive.mime_type || 'video/mp4', label: 'SD ' + (p.progressive.height || '') + 'p' } : null;
  return {
    ok: true,
    id,
    title: p.title,
    formats: {
      hd: p.canRemux
        ? { url: `/api/mflix/remux/${id}`, type: 'video/mp4', label: 'HD ' + (p.bestVideo.height || '') + 'p' }
        : null,
      sd,
      embed: `https://www.youtube.com/embed/${id}?autoplay=1`,
    },
  };
}

// binary-safe streaming proxy: spawn curl and pipe straight to the response.
// stream.js's curl buffers (64MB cap) — fine for manifests, wrong for media.
// googlevideo URLs are IP-locked to this machine, so the browser must fetch
// through the server; pass through the browser's Range header for seeking.
function proxyStream(url, req, res) {
  const args = ['-sS', '-L', '-A', 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'];
  if (req.headers.range) args.push('-H', `Range: ${req.headers.range}`);
  args.push(url);
  const child = spawn('curl', args);
  child.stdout.pipe(res);
  child.on('error', () => { try { res.end(); } catch (e) {} });
  res.on('close', () => { try { child.kill('SIGKILL'); } catch (e) {} });
}

// ffmpeg remux: video-only audio-only DASH -> fMP4 pipe. Warms metadata
// itself (server restart or direct reload must not 409).
async function remux(id, res) {
  const meta = await ytMetadata(id);
  if (!meta) { res.statusCode = 409; res.end('No metadata: ' + id); return; }
  const { bestVideo, bestAudio } = pickFormats(meta);
  if (!bestVideo || !bestAudio) { res.statusCode = 409; res.end('No remux formats'); return; }
  const args = [
    '-loglevel', 'error',
    '-i', bestVideo.url,
    '-i', bestAudio.url,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1',
  ];
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  const child = execFile('ffmpeg', args, { maxBuffer: 0 });
  child.stdout.pipe(res);
  child.on('error', () => { try { res.end(); } catch (e) {} });
  res.on('close', () => { try { child.kill('SIGKILL'); } catch (e) {} });
  child.stderr.on('data', (d) => { if (process.env.MFLIX_DEBUG) console.error('[mflix-ffmpeg]', d.toString().slice(0, 200)); });
}

module.exports = {
  loadCatalog,
  card,
  browse,
  getMovie,
  getSeries,
  searchMovieFlix,
  streamInfo,
  remux,
  proxyStream,
  MOVIE_LANGS,
  SERIES_LANGS,
};