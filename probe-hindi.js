'use strict';
// Probe ALL VidEasy servers for Hindi-dubbed Hollywood titles.
// Goal: find a currently-working server that exposes Hindi audio (quality:"Hindi"
// or VidCloud multi-audio) for Hollywood movies.
const { execFile } = require('child_process');
const { _dec } = require('./vid-y-lib.js');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const API = 'https://api.speedracelight.com';
const REF = 'https://player.videasy.to/';

function curlGet(url, referer, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '-m', String(timeoutMs), '-A', UA, '--compressed', '-c', 'cj.txt', '-b', 'cj.txt',
      ...(referer ? ['-e', referer] : []), url],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 5000 },
      (err, stdout) => resolve({ ok: !err, body: (stdout || Buffer.alloc(0)).toString('utf8') }));
  });
}

async function seedFor(tmdb) {
  const r = await curlGet(`${API}/seed?mediaId=${tmdb}`, REF);
  if (!r.ok) throw new Error('seed fetch failed: ' + r.body.slice(0, 120));
  const j = JSON.parse(r.body);
  if (!j.seed) throw new Error('no seed in: ' + r.body.slice(0, 120));
  return j.seed;
}

const MOVIES = [
  { tmdb: '634649', imdb: 'tt10872600', title: 'Spider-Man-No-Way-Home', year: '2021' },
  { tmdb: '299534', imdb: 'tt4154796', title: 'Avengers-Endgame', year: '2019' },
  { tmdb: '353081', imdb: 'tt4912910', title: 'Mission-Impossible-Fallout', year: '2018' },
  { tmdb: '284053', imdb: 'tt3501632', title: 'Thor-Ragnarok', year: '2017' },
  { tmdb: '135397', imdb: 'tt0369610', title: 'Jurassic-World', year: '2015' },
  { tmdb: '168259', imdb: 'tt2820852', title: 'Furious-7', year: '2015' },
];
const SERVERS = ['cdn', 'lamovie', 'hdmovie', 'm4uhd', 'superflix', 'downloader2', 'vsrc', 'meine'];

async function probeOne(server, movie, seed, attempt) {
  const params = {
    title: encodeURIComponent(movie.title.replace(/-/g, ' ')),
    mediaType: 'movie', year: movie.year, totalSeasons: 0,
    episodeId: 1, seasonId: 1, tmdbId: movie.tmdb, imdbId: movie.imdb,
  };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, v);
  qs.set('enc', '2'); qs.set('seed', seed);
  const url = `${API}/${server}/sources-with-title?${qs.toString()}`;
  const r = await curlGet(url, `${REF}movie/${movie.tmdb}`);
  if (!r.ok) return { server, ok: false, err: 'HTTP fail' + (r.body ? ':' + r.body.slice(0, 60) : '') };
  const payload = r.body.trim();
  if (!payload || payload.length < 20) return { server, ok: false, err: 'payload tiny (' + payload.length + ')' };
  try {
    const json = await _dec(url, params, movie.tmdb, '0', seed, payload);
    const d = JSON.parse(json);
    const srcs = Array.isArray(d.sources) ? d.sources : [];
    const list = srcs.map((s) => ({
      q: s.quality || s.label || s.name || '?',
      u: s.url || s.file || s.src || '',
    }));
    const hindi = list.filter((s) => /hindi/i.test(s.q) || /hindi/i.test(s.u));
    if (attempt > 1 || list.length || hindi.length) {
      console.log(`[${movie.title}] ${server} attempt=${attempt}: ${list.length} sources | hindi=${hindi.length}`);
    }
    return { server, ok: true, count: list.length, hindi: hindi.length, list };
  } catch (e) {
    return { server, ok: false, err: e.message.slice(0, 80) };
  }
}

(async () => {
  let seedCache = {};
  for (const movie of MOVIES) {
    console.log(`\n=== ${movie.title} (${movie.tmdb}) ===`);
    seedCache[movie.tmdb] = seedCache[movie.tmdb] || await seedFor(movie.tmdb);
    const seed = seedCache[movie.tmdb];
    for (const server of SERVERS) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await probeOne(server, movie, seed, attempt);
        if (!res.ok) {
          if (attempt === 3) console.log(`[${movie.title}] ${server}: FAIL ${res.err}`);
          continue;
        }
        break; // got a decrypted result (even 0 sources)
      }
    }
  }
  console.log('\nDONE');
})();