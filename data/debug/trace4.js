'use strict';
const { curl, text } = require('./stream');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EMBED = 'https://www.2embed.cc/embed/950387';
const XP = 'https://play.xpass.top/e/movie/950387?autostart=true';
(async () => {
  const html = String((await curl(EMBED)).body);
  const xps = /go\('(https:\/\/streamsrcs\.2embed\.cc\/[^']*)'\)/.exec(html)[1];
  const tmdb = /tmdb=(\d+)/.exec(html)[1];
  const ph = text(await curl(XP.replace('{tmdb}', tmdb), null, 10000));
  const bm = /backups=\s*\[/.exec(ph);
  const start = bm.index + bm[0].length - 1;
  const seg = ph.slice(start, ph.indexOf('</script>', start));
  const arr = JSON.parse(seg.slice(0, seg.lastIndexOf(']') + 1));
  for (const b of arr) {
    const u = b.url.startsWith('http') ? b.url : 'https://play.xpass.top' + b.url;
    let data = null;
    try { data = JSON.parse(text(await curl(u, XP, 8000)).replace(/\\u0026/g, '&')); } catch {}
    const f = data && data.playlist && data.playlist[0] && data.playlist[0].sources && data.playlist[0].sources[0] && data.playlist[0].sources[0].file;
    if (!f) continue;
    const r = await curl(f, null, 6000);
    if (!r.ok) continue;
    const body = text(r);
    if (!body.startsWith('#EXTM3U')) continue;
    const aud = (body.match(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/g) || []).map(l => (l.match(/NAME="([^"]*)"/) || [])[1] || l.slice(0, 60));
    const vars = (body.match(/#EXT-X-STREAM-INF/g) || []).length;
    const firstVariant = (body.match(/\n(?![\s\S]*\n)(?!.*#)[^#\s][^\n]*/) || [])[0] || '';
    console.log(`== ${b.name}: audio=${aud.length} [${aud.join(', ')}] variants=${vars} live`);
    console.log(`   ${f.slice(0, 110)}`);
    if (b.name === 'VIP 1' || b.name === 'LUL 1' || b.name === 'LUL 2') {
      console.log('   --- MASTER CONTENT (first 900 chars):');
      console.log('   ' + body.slice(0, 900).replace(/\n/g, '\n   '));
    }
  }
})();
