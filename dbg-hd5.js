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
async function getHdSources() {
  for (let i = 1; i <= 6; i++) {
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
    try { const d = JSON.parse(await _dec(url, params, '634649', '0', seed, b)); if (d.sources && d.sources.length) return d; } catch { continue; }
  }
  return null;
}
(async () => {
  const d = await getHdSources();
  if (!d) { console.log('API FAIL'); return; }
  const hindi = d.sources.find(s => /hindi/i.test(s.quality));
  console.log('hindi url:', hindi.url.slice(0, 90));
  // try 6 rounds: fetch i-arch (may redirect to different cdnNNNN) and test target
  for (let round = 1; round <= 6; round++) {
    const h1 = await curl(hindi.url, ['-A', UA, '-D', '-', '-o', '/dev/null', '-c', 'cj.txt', '-b', 'cj.txt']);
    const loc = /^location: (.+)$/im.exec(h1.body);
    if (!loc) { console.log(`round ${round}: no redirect (${h1.body.slice(0,60).replace(/\n/g,' ')})`); continue; }
    const cdn = /https:\/\/(cdn\d+\.hanna427def\.com)/.exec(loc[1]);
    const pl = await curl(loc[1], ['-A', UA, '-c', 'cj.txt', '-b', 'cj.txt']);
    const ok = pl.ok && pl.body.startsWith('#EXTM3U');
    console.log(`round ${round}: ${cdn ? cdn[1] : '?'} -> ${ok ? 'LIVE ' + pl.body.length + 'B' : '404/dead'}`);
    if (ok) { console.log('HEAD:', pl.body.split('\n').slice(0,8).join(' || ').slice(0,300)); break; }
  }
  console.log('DONE');
})();
