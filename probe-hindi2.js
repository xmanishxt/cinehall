'use strict';
// Dump hdmovie sources for Hollywood titles + verify Hindi source liveliness & audio tracks.
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
  { tmdb: '135397', imdb: 'tt0369610', title: 'Jurassic-World', year: '2015' },
];

async function getHdmovie(movie, seed) {
  const params = {
    title: encodeURIComponent(movie.title.replace(/-/g, ' ')),
    mediaType: 'movie', year: movie.year, totalSeasons: 0,
    episodeId: 1, seasonId: 1, tmdbId: movie.tmdb, imdbId: movie.imdb,
  };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, v);
  qs.set('enc', '2'); qs.set('seed', seed);
  const url = `${API}/hdmovie/sources-with-title?${qs.toString()}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await curlGet(url, `${REF}movie/${movie.tmdb}`);
    if (r.ok) {
      const payload = r.body.trim();
      try {
        const d = JSON.parse(await _dec(url, params, movie.tmdb, '0', seed, payload));
        return { attempt, d };
      } catch (e) { if (attempt === 5) return { attempt, err: e.message }; }
    } else if (attempt === 5) return { attempt, err: 'http fail' };
  }
  return { attempt: 5, err: 'no success' };
}

(async () => {
  for (const movie of MOVIES) {
    console.log(`\n=== ${movie.title} hdmovie ===`);
    const seed = await seedFor(movie.tmdb);
    const { d, err, attempt } = await getHdmovie(movie, seed);
    if (err) { console.log('ERR after', attempt, 'attempts:', err); continue; }
    console.log(`ok (attempt ${attempt}); sources=${d.sources ? d.sources.length : 0} subs=${d.subtitles ? d.subtitles.length : 0}`);
    for (const s of d.sources || []) {
      const q = s.quality || s.label || s.name || '?';
      const u = s.url || s.file || s.src || '';
      console.log(`  [${q}] ${u}`);
      if (/hindi/i.test(q) && u.startsWith('http')) {
        // verify playlist live + audio groups
        const pl = await curlGet(u, null, 15000);
        const body = pl.body;
        if (!pl.ok) { console.log(`    -> FETCH FAILED (${body.slice(0, 60)})`); continue; }
        if (!body.startsWith('#EXTM3U')) { console.log(`    -> NOT M3U8: ${body.slice(0, 100)}`); continue; }
        const audio = [...body.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/g)];
        const names = audio.map((mm) => {
          const n = /NAME="([^"]*)"/.exec(mm[0]);
          const l = /LANGUAGE="([^"]*)"/.exec(mm[0]);
          return (l ? l[1] : n ? n[1] : '?');
        });
        console.log(`    -> LIVE m3u8, ${body.length} bytes, audio groups=${names.length}: ${names.join('|') || '-'}`);
        // show first few lines
        console.log('    first lines:', body.split('\n').slice(0, 10).join(' / ').slice(0, 300));
      }
    }
  }
  console.log('\nDONE');
})();