'use strict';
const { curl, text } = require('./stream');
const { execFile } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EMBED = 'https://www.2embed.cc/embed/950387';
const XP = 'https://play.xpass.top/e/movie/950387?autostart=true';
function rawF(url, args) {
  return new Promise((res) => execFile('curl', ['-sS', ...args, url], { encoding: 'buffer', maxBuffer: 4*1024*1024 }, (err, out) => res(err ? { err: err.message } : { out: out.toString('utf8') })));
}
(async () => {
  const html = String((await curl(EMBED)).body);
  let m = /go\('(https:\/\/streamsrcs\.2embed\.cc\/[^']*)'\)/.exec(html);
  const xps = m ? m[1] : null;
  m = /tmdb=(\d+)/.exec(html);
  const tmdb = m ? m[1] : '';
  const ph = text(await curl(XP.replace('{tmdb}', tmdb), null, 10000));
  const bm = /backups=\s*\[/.exec(ph);
  const start = bm.index + bm[0].length - 1;
  const seg = ph.slice(start, ph.indexOf('</script>', start));
  const arr = JSON.parse(seg.slice(0, seg.lastIndexOf(']') + 1));
  console.log('backups:', arr.length, 'tmdb:', tmdb);
  for (const b of arr.slice(0, 4)) {
    const u = b.url.startsWith('http') ? b.url : 'https://play.xpass.top' + b.url;
    let data = null;
    try { data = JSON.parse(text(await curl(u, XP, 10000)).replace(/\\u0026/g, '&')); } catch {}
    const f = data && data.playlist && data.playlist[0] && data.playlist[0].sources && data.playlist[0].sources[0] && data.playlist[0].sources[0].file;
    console.log('---', b.name, '|', f ? f.slice(0, 60) : 'NO FILE');
    if (!f) continue;
    const tests = [
      ['A no-L  ,gz', ['-A', UA, '--compressed']],
      ['B L     ,gz', ['-L', '-A', UA, '--compressed']],
      ['C L,ident   ', ['-L', '-A', UA, '-H', 'Accept: */*', '-H', 'Accept-Encoding: identity']],
      ['D L,gz,UApy ', ['-L', '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', '--compressed']],
    ];
    for (const [name, args] of tests) {
      const r = await rawF(f, args);
      const body = r.ok || '';
      const first = body.length ? body.slice(0, 60).replace(/\n/g, ' ') : '';
      console.log('   ', name, '->', (r.ok !== undefined ? 'OK' : 'ERR'), 'len', body.length, '|', first);
      await new Promise(r => setTimeout(r, 300));
    }
    if (arr.indexOf(b) >= 2) break;
  }
})();
function rawF(url, args) {
  return new Promise((res) => execFile('curl', ['-sS', '-m', '15', ...args, url], { encoding: 'buffer', maxBuffer: 4*1024*1024 }, (e, out) => res(e ? { err: e.message } : { ok: out ? out.toString('utf8') : '' })));
}
