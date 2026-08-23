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
async function getSources(server, tmdb, imdb, title, year) {
  for (let i = 1; i <= 5; i++) {
    const seedR = await curl(`${API}/seed?mediaId=${tmdb}`, ['-A', UA, '--compressed', '-e', REF, '-c', 'cj.txt', '-b', 'cj.txt']);
    let seed; try { seed = JSON.parse(seedR.body).seed; } catch { continue; }
    const params = { title: encodeURIComponent(title), mediaType: 'movie', year, totalSeasons: 0, episodeId: 1, seasonId: 1, tmdbId: tmdb, imdbId: imdb };
    const qs = new URLSearchParams();
    for (const [k,v] of Object.entries(params)) qs.set(k,v);
    qs.set('enc','2'); qs.set('seed', seed);
    const url = `${API}/${server}/sources-with-title?${qs.toString()}`;
    const r = await curl(url, ['-A', UA, '--compressed', '-e', REF + 'movie/' + tmdb, '-c', 'cj.txt', '-b', 'cj.txt']);
    const b = r.body.trim();
    if (!/^[A-Za-z0-9_-]{50,}$/.test(b)) continue;
    try { const d = JSON.parse(await _dec(url, params, tmdb, '0', seed, b)); if (d.sources && d.sources.length) return d.sources; } catch { continue; }
  }
  return null;
}
(async () => {
  const cases = [
    ['634649', 'tt10872600', 'Spider-Man No Way Home', '2021'],
    ['299534', 'tt4154796', 'Avengers Endgame', '2019'],
  ];
  const servers = ['cdn', 'm4uhd', 'downloader2', 'lamovie'];
  for (const [tmdb, imdb, title, year] of cases) {
    console.log(`\n=== ${title} ===`);
    for (const server of servers) {
      const srcs = await getSources(server, tmdb, imdb, title, year);
      if (!srcs) { console.log(`${server}: API FAIL`); continue; }
      console.log(`${server}: ${srcs.length} sources`);
      for (const s of srcs.slice(0, 3)) {
        const q = s.quality || s.label || '?';
        const u = (s.url || s.file || s.src || '').trim();
        console.log(`  [${q}] ${u.slice(0, 110)}`);
        if (!u.startsWith('http')) continue;
        const pl = await curl(u, ['-A', UA, '-L', '-c', 'cj.txt', '-b', 'cj.txt']);
        const b = pl.body;
        if (!pl.ok || !b.startsWith('#EXTM3U')) { console.log(`    -> dead/not m3u8`); continue; }
        const audio = [...b.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/g)].map(m => m[0]);
        if (audio.length) {
          const names = audio.map(a => { const n = /NAME="([^"]*)"/.exec(a); const l = /LANGUAGE="([^"]*)"/.exec(a); return (l ? l[1] : n ? n[1] : '?'); });
          console.log(`    -> LIVE, AUDIO GROUPS: ${names.join(' | ')}`);
        } else {
          const rends = [...b.matchAll(/#EXT-X-STREAM-INF[^\n]*\n([^\n]+)/g)].map(m => m[1]);
          console.log(`    -> LIVE, no audio groups, ${rends.length} renditions`);
        }
      }
    }
  }
  console.log('\nDONE');
})();
