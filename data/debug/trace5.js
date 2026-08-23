'use strict';
const { curl, text } = require('./stream');
const XP = (t) => `https://play.xpass.top/e/movie/${t}?autostart=true`;
(async () => {
  for (const t of ['579067', '897278', '111827']) {
    const ph = text(await curl(XP(t), null, 12000)).replace(/\\u0026/g, '&');
    if (!ph.includes('backups=')) { console.log(t, 'no backups'); continue; }
    const bm = /backups=\s*\[/.exec(ph);
    const seg = ph.slice(bm.index + bm[0].length - 1, ph.indexOf('</script>', bm.index));
    try {
      const arr = JSON.parse(seg.slice(0, seg.lastIndexOf(']') + 1));
      console.log(t, '(', arr.length, '):', arr.slice(0, 10).map(b => b.name).join(', '));
    } catch (e) { console.log(t, 'parse fail', e.message); }
  }
})();
