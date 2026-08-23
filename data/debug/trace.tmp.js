'use strict';
// TEMP timing trace — uses only stream.js exports; stepwise timing per stage.
const { curl, text } = require('./stream');
const EMBED = 'https://www.2embed.cc/embed/950387';
const XPASS = 'https://play.xpass.top/e/movie/950387?autostart=true';

function resolvePlaylist(url, referer, timeoutMs) {
  const ts = Date.now();
  return curl(url, referer, timeoutMs).then((r) => {
    let body = '';
    if (r.ok) body = text(r).replace(/\\u0026/g, '&');
    let data = null;
    try { data = JSON.parse(body); } catch {}
    const srcs = [];
    for (const p of (data && data.playlist) || []) {
      for (const s of p.sources || []) {
        const f = s.file;
        if (f && f.startsWith('http')) srcs.push({ file: f, label: s.label || '' });
      }
    }
    console.log(`    playlist(t=${timeoutMs}): ${Date.now() - ts}ms ok=${r.ok} len=${r.body.length} srcs=${srcs.length}`);
    return srcs;
  });
}
async function liveM3u8(url, timeoutMs) {
  const ts = Date.now();
  const r = await curl(url, null, timeoutMs);
  const body = text(r);
  const live = r.ok && body.startsWith('#EXTM3U');
  console.log(`      probe ${Date.now() - ts}ms live=${live} len=${r.body.length} ${url.slice(0, 90)}`);
  return live;
}

(async () => {
  let t0 = Date.now();
  const emb = await curl(EMBED, null, 15000);
  const html = String(emb.body);
  console.log('embed:', Date.now() - t0, 'ms, len', html.length, emb.ok ? '' : '(FAIL)');
  const xps = [];
  let m;
  const goRe = /go\('(https:\/\/streamsrcs\.2embed\.cc\/[^']*)'\)/g;
  while ((m = goRe.exec(html))) xps.push(m[1]);
  m = /data-src="([^"]*)"/.exec(html);
  if (m && m[1].includes('streamsrcs')) xps.push(m[1]);
  console.log('xps sources:', xps.length);
  m = /tmdb=(\d+)/.exec(html);
  const tmdb = m ? m[1] : '';
  console.log('tmdb:', tmdb);

  let t = Date.now();
  const ph = text(await curl(XPASS, EMBED, 15000));
  console.log('xpass:', Date.now() - t, 'ms len', ph.length, 'has backups:', ph.includes('backups='));
  const bm = /backups=\s*\[/.exec(ph);
  if (!bm) { console.log('NO BACKUPS FOUND'); return; }
  const start = bm.index + bm[0].length - 1;
  const seg = ph.slice(start, ph.indexOf('</script>', start));
  const end = seg.lastIndexOf(']');
  const arr = JSON.parse(seg.slice(0, end + 1));
  console.log('backups:', arr.length, arr.map(b => b.name));

  t = Date.now();
  const lists = await Promise.all(arr.map((b) => {
    const u = b.url.startsWith('http') ? b.url : 'https://play.xpass.top' + b.url;
    return resolvePlaylist(u, XPASS, 10000);
  }));
  console.log('playlists total:', Date.now() - t, 'ms');
  const sources = [];
  const seen = new Set();
  lists.forEach((l, i) => { for (const s of l) { if (seen.has(s.file)) continue; seen.add(s.file); sources.push({ server: arr[i].name, ...s }); } });
  console.log('sources total:', sources.length, sources.map(s => s.server + '|' + s.label).join(', '));

  t = Date.now();
  const pool = sources.slice();
  const alive = [];
  const worker = async () => {
    while (pool.length) {
      const s = pool.shift();
      try {
        const live = await liveM3u8(s.file, 8000);
        if (live) alive.push(s.server + '|' + s.label);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log('probe total:', Date.now() - t, 'ms alive:', alive.length, alive);
  const endT = Date.now();
  console.log('TOTAL:', endT - t0, 'ms');
  // also time the full resolveMovie() call end-to-end with server cache disabled
  console.log('---');
  const { resolveMovie } = require('./stream');
  t = Date.now();
  try {
    const r = await resolveMovie('950671');
    const tot = Date.now() - t;
    console.log('resolveMovie(950671):', tot, 'ms servers:', r.servers.map(v => v.server + '/' + v.label + '/a' + v.audio).join(', '));
  } catch (e) { console.log('resolveMovie failed:', e.message); }
})().catch(e => console.error('ERR', e.message));