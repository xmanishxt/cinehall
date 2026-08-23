'use strict';
const { execFile } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const { _dec } = require('./vid-y-lib.js');
const API = 'https://api.speedracelight.com';
const REF = 'https://player.videasy.to/';

function curl(url, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '-m', String(timeoutMs), ...args, url],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 5000 },
      (err, stdout) => resolve({ ok: !err, body: (stdout || Buffer.alloc(0)).toString('utf8') }));
  });
}

(async () => {
  for (const [tmdb, imdb, title, year] of [['634649','tt10872600','Spider-Man-No-Way-Home','2021'], ['299534','tt4154796','Avengers-Endgame','2019']]) {
    console.log(`\n=== ${title} ===`);
    // fetch hdmovie payload with retries until decryption succeeds
    let d = null;
    for (let i = 1; i <= 8 && !d; i++) {
      const seedR = await curl(`${API}/seed?mediaId=${tmdb}`, ['-A', UA, '--compressed', '-e', REF, '-c', 'cj.txt', '-b', 'cj.txt']);
      let seed;
      try { seed = JSON.parse(seedR.body).seed; } catch { continue; }
      const params = { title: encodeURIComponent(title.replace(/-/g,' ')), mediaType: 'movie', year, totalSeasons: 0, episodeId: 1, seasonId: 1, tmdbId: tmdb, imdbId: imdb };
      const qs = new URLSearchParams();
      for (const [k,v] of Object.entries(params)) qs.set(k,v);
      qs.set('enc','2'); qs.set('seed', seed);
      const url = `${API}/hdmovie/sources-with-title?${qs.toString()}`;
      const r = await curl(url, ['-A', UA, '--compressed', '-e', REF + 'movie/' + tmdb, '-c', 'cj.txt', '-b', 'cj.txt']);
      const b = r.body.trim();
      if (!/^[A-Za-z0-9_-]{50,}$/.test(b)) continue;
      try { d = JSON.parse(await _dec(url, params, tmdb, '0', seed, b)); }
      catch { continue; }
      if (!d.sources || !d.sources.length) d = null;
    }
    if (!d) { console.log('  hdmovie FAILED after 8 attempts'); continue; }
    const hindi = d.sources.find(s => /hindi/i.test(s.quality));
    if (!hindi) { console.log('  no Hindi source returned'); continue; }
    console.log('  hindi url:', hindi.url.slice(0, 100) + '...');
    // IMMEDIATELY fetch with redirect follow
    const pl = await curl(hindi.url, ['-A', UA, '-L', '-c', 'cj.txt', '-b', 'cj.txt'], 25000);
    const b2 = pl.body;
    if (!pl.ok || !b2.startsWith('#EXTM3U')) {
      console.log('  PLAYLIST FAIL:', pl.ok ? 'not m3u8: ' + b2.slice(0, 120).replace(/\n/g,' ') : 'http err');
      continue;
    }
    console.log(`  LIVE ${b2.length}B ${b2.split('\n').length} lines`);
    const audio = [...b2.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/g)].map(m=>m[0]);
    console.log('  audio groups:', audio.length ? audio.map(a=>{const n=/NAME="([^"]*)"/.exec(a);const l=/LANGUAGE="([^"]*)"/.exec(a);return (l?l[1]:n?n[1]:'?')}).join('|') : 'NONE (direct rendition)');
    // first 8 lines
    console.log('  head:', b2.split('\n').slice(0, 8).join(' || ').slice(0, 350));
  }
  console.log('\nDONE');
})();
