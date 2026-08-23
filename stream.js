'use strict';
// stream.js — resolves direct HLS streams for movies (native player)
// TV episodes have no stable native source (verified dead on 2embed/xpass),
// so TV playback falls back to the cineby iframe in watch.js.
// Movie flow (ported from ~/bin/2embed CLI):
//   embed -> xps url -> imdb -> xpass backups -> playlist.json -> probe live m3u8
// Note: vip.1x2.space / ps1.1x2.space block Node's TLS fingerprint (404) but
// serve curl (200) — all HLS fetching here goes through curl for reliability.
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EMBED = 'https://www.2embed.cc/embed/{id}';
const XPASS = 'https://play.xpass.top/e/movie/{tmdb}?autostart=true';
const CACHE_DIR = path.join(__dirname, 'data', 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------- curl-based fetch (binary-safe) ----------
function curl(url, referer, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const args = ['-sS', '-m', String(timeoutMs), '-A', UA, '--compressed'];
    if (referer) args.push('-e', referer);
    args.push(url);
    execFile('curl', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 5000 },
      (err, stdout) => resolve({ ok: !err, body: stdout || Buffer.alloc(0) }));
  });
}
function text(r) { return r.body.toString('utf8'); }

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}
function readJSON(file, ttl) {
  try {
    const st = fs.statSync(file);
    if (ttl && Date.now() - st.mtimeMs > ttl) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

// ---------- per-movie cache (2h, re-verified on every hit) ----------
function streamFile(tmdb) {
  return path.join(CACHE_DIR, `stream-${tmdb}.json`);
}

// Re-probe a server list and keep only masters that are STILL live. 1x2.space
// tokens die within tens of minutes, while the cache lives for hours — a
// cached "live" master can 404 by the time the viewer opens the page (that
// made the player boot a dead "VIP 1", retry, then jump to a real server —
// which read as "two players opening" and a picker stuck on the dead one).
async function pruneServers(list, timeoutMs = 8000) {
  const alive = [];
  await Promise.all((list || []).slice(0, 10).map(async (s) => {
    try {
      const { live } = await liveM3u8(s.master, timeoutMs);
      if (live) alive.push(s);
    } catch { /* dead token — drop */ }
  }));
  return alive;
}

function resolvePlaylist(url, referer, timeoutMs = 15000) {
  return curl(url, referer, timeoutMs).then((r) => {
    if (!r.ok) return [];
    let body = text(r).replace(/\\u0026/g, '&');
    let data;
    try { data = JSON.parse(body); } catch { return []; }
    const out = [];
    for (const p of data.playlist || []) {
      for (const s of p.sources || []) {
        const f = s.file;
        if (f && f.startsWith('http')) out.push({ file: f, label: s.label || '' });
      }
    }
    return out;
  });
}

// does the url return a live #EXTM3U master? captures multi-audio track names
async function liveM3u8(url, timeoutMs = 10000) {
  const r = await curl(url, null, timeoutMs);
  const body = text(r);
  const live = r.ok && body.startsWith('#EXTM3U');
  const langs = [];
  if (live) {
    const re = /#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/g;
    let m;
    while ((m = re.exec(body))) {
      const name = /NAME="([^"]*)"/.exec(m[0]);
      const lang = /LANGUAGE="([^"]*)"/.exec(m[0]);
      if (lang && !langs.includes(lang[1])) langs.push(lang[1]);
      else if (name && !langs.includes(name[1])) langs.push(name[1]);
    }
  }
  return { live, body, langs };
}

// ---------- vidsrc.hair — independent second source of movie servers ----------
// The xpass chain above typically yields ONE live server (vip.1x2.space), which
// is why only "VIP 1" shows up. vidsrc.hair has its own original CDNs
// (VNE/XPT/XPV/XPF...) and its own API — verified: Shawshank resolves 19 live
// servers via /api.php. Only used in the background full sweep, so the fast
// boot path stays on xpass.
const VSRC = 'https://vidsrc.hair';
// server families observed live (VNE/VNH/VNN/SWM/MAF) vs always-dead XPT/XPV/XPM
function familyRank(name) {
  if (/VNE|VNH|VNN|VNM|SWM|MAF/.test(name)) return 0; // known-live CDN families
  if (/XPT|XPV|XPW|XPM|XPB/.test(name)) return 2;     // known-dead "no source"
  return 1;                                           // unknown — try between
}
async function vidsrcExtra(tmdb, max = 5) {
  // probe must be forgiving: the CDN (tiktoks.animanga.fun) responds slowly,
  // a 6s probe silently dropped every server. 10s matches liveM3u8's default.
  const PROBE = 10000;
  try {
    const embed = `${VSRC}/embed/movie/${tmdb}`;
    const { ok, body: html } = await curl(embed, null, 12000);
    if (!ok) return [];
    const m = /var Q = (\{.*?\})\s*[;<]/.exec(html.toString('utf8'));
    let Q;
    try { Q = m && JSON.parse(m[1]); } catch {}
    if (!Q || !Q.t || !Q.id) return [];
    const t = encodeURIComponent(Q.t);
    // sources -> [{ref, name}] (referer REQUIRED, else {"error":"unavailable"}).
    // NOTE: it must be the ORIGIN (https://vidsrc.hair/) — the full embed URL
    // as referer gets rejected with {"error":"unavailable"}. Verified live.
    const src = await curl(`${VSRC}/api.php?a=sources&type=movie&id=${Q.id}&s=0&e=0&t=${t}`, `${VSRC}/`, 12000);
    let j;
    try { j = JSON.parse(text(src)); } catch {}
    if (!j || !j.servers || !j.servers.length) return [];
    // Server list order rotates and is dominated by the always-dead XPT/XPV/
    // XPW/XPM family ("no source" HTML from a=play), with the live families
    // (VNE/VNH/VNN/VNM/SWM/MAF) at the tail — sort live-first so the max
    // probe budget hits real sources instead of burning time on dead ones.
    j.servers.sort((a, b) => familyRank(a.name) - familyRank(b.name));
    const out = [];
    for (const s of j.servers.slice(0, max)) {
      try {
        // play is flaky (rate-limit/expiry returns an HTML page) — retry once
        let d = null;
        for (let k = 0; k < 2 && !d; k++) {
          const pl = await curl(`${VSRC}/api.php?a=play&ref=${encodeURIComponent(s.ref)}`, `${VSRC}/`, 12000);
          try { d = JSON.parse(text(pl)); } catch { if (k === 0) await sleep(700); }
        }
        if (!d || !d.url || !d.url.startsWith('http')) continue;
        const { live } = await liveM3u8(d.url, PROBE);
        if (live) {
          const name = s.name || 'vidsrc';
          out.push({ master: d.url, server: 'vidsrc · ' + name, label: name, audio: 0, langs: [] });
        }
      } catch { /* broken server — skip */ }
    }
    return out;
  } catch { return []; }
}

// resolve a movie's master m3u8 (any of the backup servers that talks live).
// The upstream is flaky: fresh tokens can 404 one moment and work the next, so
// the whole resolve retries with brand-new tokens (2 retries) before giving up.
// firstOnly=true stops at the FIRST live server (fast boot); the full sweep
// (resolveMovie) is run in the background by getStream to fill the server list.
async function resolveMovie(id, firstOnly = false) {
  const PL_TIMEOUT = 15000, PROBE_TIMEOUT = 12000, CONC = 10, ATTEMPTS = 2;
  let lastErr = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const embed = EMBED.replace('{id}', id);
      const { ok, body } = await curl(embed, null, 15000);
      if (!ok) throw new Error('embed failed');
      const html = body.toString('utf8'); // Buffer lacks .match/.includes properly

      // source urls from go('...') / data-src
      const xps = [];
      let m;
      const goRe = /go\('(https:\/\/streamsrcs\.2embed\.cc\/[^']*)'\)/g;
      while ((m = goRe.exec(html))) xps.push(m[1]);
      m = /data-src="([^"]*)"/.exec(html);
      if (m && m[1].includes('streamsrcs')) xps.push(m[1]);
      if (!xps.length) return null;

      // tmdb id — the embed page embeds it in vcr/vnest source urls (tmdb=NNN)
      m = /tmdb=(\d+)/.exec(html);
      const tmdb = m ? m[1] : (/^\d+$/.test(id) ? id : '');
      if (!tmdb) throw new Error('no tmdb in embed page');

      // imdb id — xpass pages built from the IMDb id expose the FULL backup set
      // (mdata/vip with live tokens); tmdb-derived pages often only carry the
      // weak vxr/vrk placeholder playlists, which resolve to no live source
      // (movie 1003919: imdb page = 7 backups incl. live VIP, tmdb page = 2 dead).
      // Fall back to the detail cache (server.js writes it when a title is viewed).
      let imdb = ((html.match(/imdb[=:]["']?(tt\d+)/) || [])[1]) || null;
      if (!imdb) {
        const df = path.join(CACHE_DIR, `detail-movie-${id}.json`);
        if (fs.existsSync(df)) { try { imdb = JSON.parse(fs.readFileSync(df, 'utf8')).imdb || null; } catch {} }
      }

      // fetch BOTH xpass pages (imdb-preferred + tmdb) and merge their backups
      const xpass = XPASS.replace('{tmdb}', imdb || tmdb);
      const pages = await Promise.all([
        curl(XPASS.replace('{tmdb}', imdb || tmdb), embed, 15000),
        imdb && imdb !== tmdb ? curl(XPASS.replace('{tmdb}', tmdb), embed, 15000)
          : Promise.resolve({ ok: false, body: Buffer.alloc(0) }),
      ]);
      const seenBk = new Set();
      const backups = [];
      for (const r of pages) {
        const ph = text(r);
        if (!ph.includes('backups=')) continue;
        m = /backups=\s*\[/.exec(ph);
        if (!m) continue;
        const start = m.index + m[0].length - 1; // at '['
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
        } catch { /* skip broken page */ }
      }
      if (!backups.length) throw new Error('no backups');

      // collect sources from every backup playlist — in parallel, short timeout
      const lists = await Promise.all(backups.map((b) => resolvePlaylist(b.url, xpass, PL_TIMEOUT)));
      const sources = [];
      const seen = new Set();
      lists.forEach((list, i) => {
        for (const s of list) {
          if (seen.has(s.file)) continue;
          seen.add(s.file);
          sources.push({ server: backups[i].name, ...s });
        }
      });
      if (!sources.length) throw new Error('no sources resolved');

      // probe sources for a live master — concurrency 8. In firstOnly mode we
      // bail the moment the first live one shows up; otherwise keep ALL live
      // servers; multi-audio renditions (#EXT-X-MEDIA:TYPE=AUDIO) sort first so
      // the language switcher gets a source to work with.
      const pool = sources.slice();
      const alive = [];
      const worker = async () => {
        while (pool.length) {
          const s = pool.shift();
          try {
            const { live, body, langs } = await liveM3u8(s.file, PROBE_TIMEOUT);
            if (!live) continue;
            const audio = (body.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length;
            const entry = { master: s.file, server: s.server, label: s.label, audio: audio || 0, langs };
            if (firstOnly) { alive.push(entry); return; } // first live — stop the sweep
            alive.push(entry);
          } catch { /* probe failed — skip */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONC, pool.length) }, worker));
      if (alive.length) {
        if (!firstOnly) {
          alive.sort((a, b) => (b.audio > 0 ? 1 : 0) - (a.audio > 0 ? 1 : 0));
          // independent server list from vidsrc.hair — grows the picker
          alive.push(...(await vidsrcExtra(tmdb)));
        }
        const servers = firstOnly ? alive.slice(0, 1) : alive.slice(0, 10);
        const out = { servers, referer: xpass, tmdb, attempt: attempt + 1, probing: firstOnly };
        out.master = out.servers[0].master; // first = best (multi-audio preferred)
        return out;
      }
      lastErr = new Error('no live m3u8 among sources');
    } catch (e) { lastErr = e; }
    if (attempt < ATTEMPTS - 1) await sleep(400 + attempt * 400); // brief backoff before fresh tokens
  }
  throw lastErr;
}

// getStream(type, id, s, e) -> {master,...} | null (tv -> null)
// Boot path returns the FIRST live server fast (so playback starts within a few
// seconds); the full server sweep runs in the background and fills the cache.
const inflight = new Map();
async function getStream(type, id, s, e) {
  if (type === 'tv') return null; // no native source (see header)
  const key = /^\d+$/.test(String(id)) ? id : `tt-${id}`;
  const cache = readJSON(streamFile(key), 2 * 60 * 60 * 1000);
  if (cache && cache.master) {
    // cache hit → re-verify BEFORE handing over; drop servers whose token died
    const list = (cache.servers && cache.servers.length)
      ? cache.servers
      : (cache.master ? [{ master: cache.master, server: 'VIP 1', label: 'VIP 1', audio: cache.audio || 0 }] : []);
    const alive = await pruneServers(list);
    if (alive.length) return { ...cache, servers: alive };
    // cache fully dead → fall through and resolve fresh tokens
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const r = await resolveMovie(id, true);           // first live — seconds
    writeJSON(streamFile(key), r);
    resolveMovie(id, false)                            // full sweep — background
      .then(async (full) => {
        // prune the sweep too — a source that died during the sweep must not
        // be offered to the player (avoid booting dead entries)
        const servers = await pruneServers(full.servers || []);
        writeJSON(streamFile(key), { ...r, ...full, servers: servers.length ? servers : [r.servers[0]], probing: false });
      })
      .catch(() => { /* keep the fast result */ });
    return r;
  })();
  inflight.set(key, p);
  p.finally(() => inflight.delete(key)).catch(() => {});
  return p;
}

module.exports = { getStream, resolveMovie, curl, text, vidsrcExtra };