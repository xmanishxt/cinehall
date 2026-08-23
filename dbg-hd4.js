'use strict';
const { execFile } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const { _dec } = require('./vid-y-lib.js');
const API = 'https://api.speedracelight.com';
const REF = 'https://player.videasy.to/';

function curl(url, args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '-m', String(timeoutMs), ...args, url],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 5000 },
      (err, stdout) => resolve({ ok: !err, body: (stdout || Buffer.alloc(0)).toString('utf8') }));
  });
}

(async () => {
  let d = null;
  for (let i = 1; i <= 8 && !d; i++) {
    const seedR = await curl(`${API}/seed?mediaId=634649`, ['-A', UA, '--compressed', '-e', REF, '-c', 'cj.txt', '-b', 'cj.txt']);
    let seed; try { seed = JSON.parse(seedR.body).seed; } catch { continue; }
    const params = { title: encodeURIComponent('Spider-Man No Way Home'), mediaType: 'movie', year: '2021', totalSeasons: 0, episodeId: 1, seasonId: 1, tmdbId: '634649', imdbId: 'tt10872600' };
    const qs = new URLSearchParams();
    for (const [k,v] of Object.entries(params)) qs.set(k,v);
    qs.set('enc','2'); qs.set('seed', seed);
    const url = `${API}/hdmovie/sources-with-title?${qs.toString()}`;
    const r = await curl(url, ['-A', UA, '--compressed', '-e', REF + 'movie/634649', '-c', 'cj.txt', '-b', 'cj.txt']);
    const b = r.body.trim();
    if (!/^[A-Za-z0-9_-]{50,}$/.test(b)) continue;
    try { d = JSON.parse(await _dec(url, params, '634649', '0', seed, b)); } catch { continue; }
  }
  if (!d) { console.log('FAIL all'); return; }
  const hindi = d.sources.find(s => /hindi/i.test(s.quality));
  const u = hindi.url;
  // capture location
  const h1 = await curl(u, ['-A', UA, '-D', '-', '-o', '/dev/null', '-c', 'cj.txt', '-b', 'cj.txt']);
  const loc = /^location: (.+)$/im.exec(h1.body);
  if (!loc) { console.log('NO LOCATION:', h1.body.slice(0,200)); return; }
  console.log('redirect to:', loc[1].slice(0, 110));
  // fetch the location directly (no follow)
  const pl = await curl(loc[1], ['-A', UA, '-c', 'cj.txt', '-b', 'cj.txt']);
  const b2 = pl.body;
  if (!pl.ok || !b2.startsWith('#EXTM3U')) {
    console.log('TARGET FAIL:', pl.ok ? 'not m3u8: ' + b2.slice(0, 150).replace(/\n/g,' ') : 'http err');
    return;
  }
  console.log(`TARGET LIVE ${b2.length}B ${b2.split('\n').length} lines`);
  const audio = [...b2.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/g)].map(m=>m[0]);
  console.log('audio groups:', audio.length ? audio.map(a=>{const n=/NAME="([^"]*)"/.exec(a);const l=/LANGUAGE="([^"]*)"/.exec(a);return (l?l[1]:n?n[1]:'?')}).join('|') : 'NONE');
  console.log('head:', b2.split('\n').slice(0, 10).join(' || ').slice(0, 400));
  // try segment? first rendition line:
  const rend = [...b2.matchAll(/(index|.*\.m3u8)/g)].slice(0,3).map(m=>m[1]);
  console.log('renditions:', rend.join(', '));
  console.log('DONE');
})();
