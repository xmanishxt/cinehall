'use strict';
const { curl, text } = require('./stream');
(async () => {
  const ph = text(await curl('https://play.xpass.top/e/movie/616820?autostart=true', null, 12000));
  const bm = /backups=\s*\[/.exec(ph);
  const seg = ph.slice(bm.index + bm[0].length - 1, ph.indexOf('</script>', bm.index));
  const arr = JSON.parse(seg.slice(0, seg.lastIndexOf(']') + 1));
  for (const b of arr) {
    const u = b.url.startsWith('http') ? b.url : 'https://play.xpass.top' + b.url;
    let data = null;
    try { data = JSON.parse(text(await curl(u, 'https://play.xpass.top/e/movie/616820?autostart=true', 8000)).replace(/\\u0026/g, '&')); } catch {}
    const srcs = data && data.playlist || [];
    const first = srcs[0];
    const label = first && first.sources && first.sources[0] && first.sources[0].label;
    const loaded = first && first.loaded;
    const type = first && first.type;
    console.log(`${b.name}: type=${type} label=${label} loaded=${loaded}`);
  }
})();
