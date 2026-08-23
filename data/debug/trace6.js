'use strict';
const { curl, text } = require('./stream');
const XP = (t) => `https://play.xpass.top/e/movie/${t}?autostart=true`;
(async () => {
  for (const t of ['22653', '459410', '597590', '616820']) {
    const ph = text(await curl(XP(t), null, 12000)).replace(/\\u0026/g, '&');
    if (!ph.includes('backups=')) { console.log('tt', t, 'no backups'); continue; }
    const bm = /backups=\s*\[/.exec(ph);
    const seg = ph.slice(bm.index + bm[0].length - 1, ph.indexOf('</script>', bm.index));
    try {
      const arr = JSON.parse(seg.slice(0, seg.lastIndexOf(']') + 1));
      console.log('tt', t, '(', arr.length, '):', arr.map(b => b.name).slice(0, 14).join(', '));
    } catch (e) { console.log('tt', t, 'parse fail', e.message); }
  }
})();
