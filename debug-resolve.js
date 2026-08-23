'use strict';
// Debug harness: step-by-step trace of resolveMovie flow for one movie id.
const { execFile } = require('child_process');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EMBED = 'https://www.2embed.cc/embed/{id}';
const XPASS = 'https://play.xpass.top/e/movie/{tmdb}?autostart=true';

function curl(url, referer, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const args = ['-sS', '-m', String(timeoutMs), '-A', UA, '--compressed'];
    if (referer) args.push('-e', referer);
    args.push(url);
    execFile('curl', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 5000 },
      (err, stdout) => resolve({ ok: !err, body: stdout || Buffer.alloc(0) }));
  });
}
const text = (r) => r.body.toString('utf8');

const id = process.argv[2] || '1603330';
const log = (k, v) => console.log(`[${k}] ${v}`);

(async () => {
  // STEP 1: embed page
  log('STEP1', `fetch ${EMBED.replace('{id}', id)}`);
  const r1 = await curl(EMBED.replace('{id}', id), null, 15000);
  if (!r1.ok) { log('STEP1', `EMBED FAILED: ${r1.body ? text(r1).slice(0, 200) : '(no body)'}`); return; }
  const html = text(r1);
  log('STEP1', `embed ok, ${html.length} bytes`);

  const goRe = /go\('(https:\/\/streamsrcs\.2embed\.cc\/[^']*)'\)/g;
  const xps = [];
  let m;
  while ((m = goRe.exec(html))) xps.push(m[1]);
  m = /data-src="([^"]*)"/.exec(html);
  if (m && m[1].includes('streamsrcs')) xps.push(m[1]);
  log('STEP1', `go()/data-src urls: ${xps.length ? xps.join('\n          ') : 'NONE'}`);
  if (!xps.length) return;

  m = /tmdb=(\d+)/.exec(html);
  const tmdb = m ? m[1] : (/^\d+$/.test(id) ? id : '');
  log('STEP1', `tmdb=${tmdb}`);

  let imdb = ((html.match(/imdb[=:]["']?(tt\d+)/) || [])[1]) || null;
  log('STEP1', `imdb (from page)=${imdb}`);

  // STEP 2: xpass pages
  const pages = await Promise.all([
    curl(XPASS.replace('{tmdb}', imdb || tmdb), EMBED.replace('{id}', id), 15000),
    imdb && imdb !== tmdb ? curl(XPASS.replace('{tmdb}', tmdb), EMBED.replace('{id}', id), 15000)
      : Promise.resolve({ ok: false, body: Buffer.alloc(0) }),
  ]);
  for (let i = 0; i < pages.length; i++) {
    const ph = text(pages[i]);
    const label = i === 0 ? `xpass/${imdb || tmdb}` : `xpass/${tmdb}`;
    if (!pages[i].ok) { log('STEP2', `${label}: FETCH FAILED`); continue; }
    log('STEP2', `${label}: ok, ${ph.length} bytes, has backups=: ${ph.includes('backups=')}`);
  }

  // STEP 3: parse backups
  const seenBk = new Set();
  const backups = [];
  for (const r of pages) {
    const ph = text(r);
    if (!ph.includes('backups=')) continue;
    m = /backups=\s*\[/.exec(ph);
    if (!m) continue;
    const start = m.index + m[0].length - 1;
    const seg = ph.slice(start, ph.indexOf('</script>', start));
    const end = seg.lastIndexOf(']');
    if (end <= 0) continue;
    try {
      const arr = JSON.parse(seg.slice(0, end + 1));
      for (const b of arr) {
        const u = b.url || '';
        if (!u || seenBk.has(u)) continue;
        seenBk.add(u);
        backups.push({ name: b.name || '?', url: u.startsWith('http') ? u : 'https://play.xpass.top' + u });
      }
    } catch (e) { log('STEP3', `backups JSON parse failed: ${e.message}`); }
  }
  log('STEP3', `backups parsed: ${backups.length}`);
  backups.forEach((b, i) => log('STEP3', `  [${i}] ${b.name} -> ${b.url.slice(0, 100)}`));
  if (!backups.length) return;

  // STEP 4: resolve playlists
  const lists = [];
  for (let i = 0; i < backups.length; i++) {
    const b = backups[i];
    const r = await curl(b.url, XPASS.replace('{tmdb}', imdb || tmdb), 15000);
    if (!r.ok) { log('STEP4', `[${i}] ${b.name}: playlist FETCH FAILED`); lists.push([]); continue; }
    const body = text(r).replace(/\\u0026/g, '&');
    let data;
    try { data = JSON.parse(body); } catch { log('STEP4', `[${i}] ${b.name}: not JSON (${body.slice(0, 120)})`); lists.push([]); continue; }
    const srcs = [];
    for (const p of data.playlist || []) for (const s of p.sources || []) {
      if (s.file && s.file.startsWith('http')) srcs.push({ file: s.file, label: s.label || '' });
    }
    log('STEP4', `[${i}] ${b.name}: ${srcs.length} sources`);
    srcs.forEach((s) => log('STEP4', `    ${s.label || '?'} ${s.file.slice(0, 110)}`));
    lists.push(srcs);
  }

  // STEP 5: probe each source for live m3u8 + audio tracks
  const seen = new Set();
  const sources = [];
  lists.forEach((list, i) => {
    for (const s of list) {
      if (seen.has(s.file)) continue;
      seen.add(s.file);
      sources.push({ server: backups[i].name, ...s });
    }
  });
  log('STEP5', `total unique sources: ${sources.length}`);
  for (const s of sources) {
    const r = await curl(s.file, null, 12000);
    const body = text(r);
    const live = r.ok && body.startsWith('#EXTM3U');
    const audioTracks = (body.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length;
    const names = [...body.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/g)].map((mm) => {
      const n = /NAME="([^"]*)"/.exec(mm[0]); const l = /LANGUAGE="([^"]*)"/.exec(mm[0]);
      return (l ? l[1] : n ? n[1] : '?');
    });
    log('STEP5', `${s.server}/${s.label || '?'}: ${live ? 'LIVE' : 'dead'} audio=${audioTracks} langs=${names.join(',') || '-'} :: ${s.file.slice(0, 90)}`);
  }
  console.log('DONE');
})();
