'use strict';
const { execFile } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const { _dec } = require('./vid-y-lib.js');
const API = 'https://api.speedracelight.com';
const REF = 'https://player.videasy.to/';

function curlGet(url, referer, timeoutMs = 20000, follow = true) {
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '-m', String(timeoutMs), '-A', UA, '--compressed', '-c', 'cj.txt', '-b', 'cj.txt',
      ...(follow ? ['-L'] : []), ...(referer ? ['-e', referer] : []), url],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 5000 },
      (err, stdout) => resolve({ ok: !err, body: (stdout || Buffer.alloc(0)).toString('utf8') }));
  });
}

(async () => {
  const seed = (await curlGet(`${API}/seed?mediaId=634649`, REF)).body.trim();
  const j = JSON.parse(seed);
  console.log('seed:', j.seed);
  const params = { title: encodeURIComponent('Spider-Man-No-Way-Home'.replace(/-/g,' ')), mediaType: 'movie', year: '2021', totalSeasons: 0, episodeId: 1, seasonId: 1, tmdbId: '634649', imdbId: 'tt10872600' };
  const qs = new URLSearchParams();
  for (const [k,v] of Object.entries(params)) qs.set(k,v);
  qs.set('enc','2'); qs.set('seed', j.seed);
  const url = `${API}/hdmovie/sources-with-title?${qs.toString()}`;
  const r = await curlGet(url, REF + 'movie/634649');
  const d = JSON.parse(await _dec(url, params, '634649', '0', j.seed, r.body.trim()));
  for (const s of d.sources) {
    console.log(`\n[${s.quality}] ${s.url}`);
    const pl = await curlGet(s.url, null, 20000);
    const b = pl.body;
    if (!pl.ok || !b.startsWith('#EXTM3U')) { console.log('  FAILED:', pl.ok ? 'not m3u8: '+b.slice(0,80) : 'http err'); continue; }
    console.log(`  LIVE ${b.length}B, ${b.split('\n').length} lines`);
    const groups = [...b.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/g)].map(m=>m[0]);
    const names = groups.map(g=>{const n=/NAME="([^"]*)"/.exec(g);const l=/LANGUAGE="([^"]*)"/.exec(g);return (l?l[1]:n?n[1]:'?')});
    console.log('  audio groups:', names.length ? names.join('|') : 'NONE');
    console.log('  first 12 lines:', b.split('\n').slice(0,12).join(' || ').slice(0, 400));
  }
  console.log('\nDONE');
})();
