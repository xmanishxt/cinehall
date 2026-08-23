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
      (err, stdout, stderr) => resolve({ ok: !err, body: (stdout || Buffer.alloc(0)).toString('utf8'), err: err ? err.message : '' }));
  });
}

(async () => {
  // fresh fetch of sources
  const seedR = await curl(`${API}/seed?mediaId=634649`, ['-A', UA, '--compressed', '-e', REF, '-c', 'cj.txt', '-b', 'cj.txt']);
  const seed = JSON.parse(seedR.body).seed;
  const params = { title: encodeURIComponent('Spider-Man No Way Home'), mediaType: 'movie', year: '2021', totalSeasons: 0, episodeId: 1, seasonId: 1, tmdbId: '634649', imdbId: 'tt10872600' };
  const qs = new URLSearchParams();
  for (const [k,v] of Object.entries(params)) qs.set(k,v);
  qs.set('enc','2'); qs.set('seed', seed);
  const url = `${API}/hdmovie/sources-with-title?${qs.toString()}`;
  const r = await curl(url, ['-A', UA, '--compressed', '-e', REF + 'movie/634649', '-c', 'cj.txt', '-b', 'cj.txt']);
  const d = JSON.parse(await _dec(url, params, '634649', '0', seed, r.body.trim()));
  const hindi = d.sources.find(s => /hindi/i.test(s.quality));
  console.log('hindi url:', hindi.url.slice(0, 120));

  // 1) no follow, capture headers
  const h1 = await curl(hindi.url, ['-A', UA, '-D', '-', '-o', '/dev/null', '-c', 'cj.txt', '-b', 'cj.txt']);
  console.log('\n--- no-follow headers ---');
  console.log(h1.body.split('\n').slice(0, 12).join('\n'));

  // 2) with referer of hdmovie site?
  const h2 = await curl(hindi.url, ['-A', UA, '-D', '-', '-o', '/dev/null', '-e', 'https://hdmovie2.site/', '-c', 'cj.txt', '-b', 'cj.txt']);
  console.log('\n--- no-follow w/ hdmovie referer ---');
  console.log(h2.body.split('\n').slice(0, 12).join('\n'));

  // 3) HEAD w/o referer
  const h3 = await curl(hindi.url, ['-A', UA, '-I', '-c', 'cj.txt', '-b', 'cj.txt']);
  console.log('\n--- HEAD ---');
  console.log(h3.body.split('\n').slice(0, 12).join('\n'));
  console.log('DONE');
})();
