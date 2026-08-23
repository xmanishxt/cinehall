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
    if (!/^[A-Za-z0-9_-]{50,}$/.test(b)) { console.log(`#${i}: api resp non-payload (${b.slice(0,60)})`); continue; }
    try { d = JSON.parse(await _dec(url, params, '634649', '0', seed, b)); } catch { continue; }
  }
  if (!d) { console.log('FAIL all'); return; }
  const hindi = d.sources.find(s => /hindi/i.test(s.quality));
  const u = hindi.url;
  console.log('hindi url:', u.slice(0, 110));
  // capture headers, no follow
  const h1 = await curl(u, ['-A', UA, '-D', '-', '-o', '/dev/null', '-c', 'cj.txt', '-b', 'cj.txt']);
  console.log('--- resp ---');
  console.log(h1.body.slice(0, 500));
  // if 3xx, parse location and fetch it
  const loc = /^Location: (.+)$/m.exec(h1.body);
  if (loc) {
    console.log('LOCATION:', loc[1].slice(0, 200));
    const h2 = await curl(loc[1], ['-A', UA, '-D', '-', '-o', '/dev/null', '-c', 'cj.txt', '-b', 'cj.txt']);
    console.log('--- target ---');
    console.log(h2.body.slice(0, 400));
  }
  console.log('DONE');
})();
