'use strict';
/* CineHall watch page — detail + native player
   Movies: hls.js native playback via /api/stream (multi-language audio switch + resume)
   TV:     episode grid + iframe fallback embeds (no stable native source — see stream.js) */
const $ = (s) => document.querySelector(s);
const main = $('#main');

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function dur(s) {
  if (!s) return null;
  const m = String(s).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const h = m[1] ? `${+m[1]}h` : '';
  const min = m[2] ? `${+m[2]}m` : '';
  return (h + ' ' + min).trim() || null;
}
function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

// ---------- Continue Watching (localStorage) ----------
const cwKey = (type, id, s, e) => `cwh:${type}:${id}:${s || 0}:${e || 0}`;
function cwRead(type, id, s, e) {
  try { return JSON.parse(localStorage.getItem(cwKey(type, id, s, e))); } catch { return null; }
}
function cwSave(rec) {
  if (!rec || !rec.title) return;
  rec.ts = Date.now();
  try { localStorage.setItem(cwKey(rec.type, rec.id, rec.s, rec.e), JSON.stringify(rec)); } catch {}
}
function cwRemove(type, id, s, e) { try { localStorage.removeItem(cwKey(type, id, s, e)); } catch {} }

// ---------- boot ----------
const mm = window.location.pathname.match(/^\/watch\/(movie|tv)\/(\d+)(?:\/(\d+)(?:\/(\d+))?)?/);
const mfm = window.location.pathname.match(/^\/watch\/mflm\/([A-Za-z0-9_-]{11})/);
const mfs = window.location.pathname.match(/^\/watch\/mfls\/([^/]+)(?:\/(\d+))?/);
if (mfm) loadMflixMovie(mfm[1]);
else if (mfs) loadMflixSeries(decodeURIComponent(mfs[1]), mfs[2] ? +mfs[2] : 1);
else if (!mm) { main.innerHTML = errCard('Bad link — go back and pick a title.'); }
else {
  loadDetails(mm[1], +mm[2], mm[3] ? +mm[3] : null, mm[4] ? +mm[4] : null);
}

function errCard(msg) {
  return `<div class="watch-body"><div class="no-src"><h2 style="margin-bottom:10px">Oops</h2><p>${esc(msg)}</p>
    <p style="margin-top:20px"><a class="btn btn-primary" href="/">← Back to CineHall</a></p></div></div>`;
}

async function loadDetails(type, id, wantS, wantE) {
  let d;
  try {
    d = await (await fetch(`/api/detail/${type}/${id}`)).json();
  } catch (e) {
    main.innerHTML = errCard('Could not reach the server. Is it running?');
    return;
  }
  if (!d || !d.ok) { main.innerHTML = errCard('Title not found (ID ' + id + ').'); return; }
  render(d, wantS, wantE);
}

// TV servers — probed live 2026-08-08 (see probe/). Dead sources were removed:
// Vidsrc.nl (parked "for sale" domain), Vidsrc.su (dead player SPA),
// Vidsrc.to/Vidsrc.io (domains gone, curl 000), GDrivePlayer (black frames),
// multiembed.mov (Cloudflare challenge 403), wootly.ch (SPA shell no player).
function tvEmbeds(d, s, e) {
  const key = d.imdb || d.id;
  return [
    // VidEasy first = auto-picked source, same as 7reels (whose default is
    // videasy). Carries shows VidRock doesn't — e.g. The Kapil Sharma Show
    // (TMDB 66465): vidrock /api/tv returns all-null for it.
    { name: 'VidEasy', src: `https://player.videasy.net/tv/${d.id}/${s}/${e}?nextEpisode=true&autoplayNextEpisode=true&episodeSelector=true&overlay=true&color=16A085` },
    { name: '2Embed', src: `https://www.2embed.cc/embedtv/${key}-${s}-${e}` },
    { name: 'Vidsrc.hair', src: `https://vidsrc.hair/embed/tv/${key}/${s}/${e}` },
    { name: 'VidAPI', src: `https://vidapi.xyz/embed/tv/${d.id}/${s}/${e}` },
    { name: 'Vidsrc.pm', src: `https://vidsrc.pm/embed/tv/${key}/${s}/${e}` },
    { name: 'vsembed', src: `https://vsembed.ru/embed/tv/${key}/${s}/${e}` },
    // re-added 2026-08-14 live probe: vidsrc.io / vidsrc.su / vidsrc.to all
    // serve player pages again (v2 clones; probed per-request server-side)
    { name: 'Vidsrc.io', src: `https://vidsrc.io/embed/tv/${key}/${s}/${e}` },
    { name: 'Vidsrc.su', src: `https://vidsrc.su/embed/tv/${key}/${s}/${e}` },
    { name: 'Vidsrc.to', src: `https://vidsrc.to/embed/tv/${key}/${s}/${e}` },
    // cinezo.gd naye servers — catalog ids ARE TMDB ids (verified), probed live 2026-08-09
    { name: 'VidLink', src: `https://vidlink.pro/tv/${d.id}/${s}/${e}?autoplay=true&title=true` },
    { name: 'VidUp', src: `https://vidup.to/tv/${d.id}/${s}/${e}?autoPlay=true&theme=16A085&nextButton=true&autoNext=true&sub=en` },
    { name: 'Vidsrc.mov', src: `https://vidsrc.mov/embed/tv/${d.id}/${s}/${e}` },
    { name: 'Vidsrc.fyi', src: `https://vidsrc.fyi/embed/tv/${d.id}/${s}/${e}` },
    { name: 'VidRock', src: `https://vidrock.net/tv/${d.id}/${s}/${e}` },
    { name: 'VidNest', src: `https://vidnest.fun/tv/${d.id}/${s}/${e}` },
    { name: 'VidKing', src: `https://www.vidking.net/embed/tv/${d.id}/${s}/${e}` },
    // YouTube mirror-channel search — /api/yt finds a full episode upload and
    // 302s to its embed page (official channels block embedding; see server.js)
    { name: 'YouTube', src: `/api/yt?q=${encodeURIComponent(`${d.name} s${s} e${e} full episode`)}&min=1500` },
  ];
}

// Movie embeds — same shape as tvEmbeds ({name, src}) so the shared rotation
// player (initEmbed) treats movies and series identically.
function movieEmbeds(d) {
  const key = d.imdb || d.id;
  return [
    // VidEasy first = auto-picked source, same as 7reels (default videasy)
    { name: 'VidEasy', src: `https://player.videasy.net/movie/${d.id}?overlay=true&color=16A085` },
    { name: '2Embed', src: `https://www.2embed.cc/embed/${key}` },
    { name: 'Vidsrc.pm', src: `https://vidsrc.pm/embed/movie/${key}` },
    { name: 'vsembed', src: `https://vsembed.ru/embed/movie/${key}` },
    { name: 'VidAPI', src: `https://vidapi.xyz/embed/movie/${d.id}` },
    { name: 'Vidsrc.hair', src: `https://vidsrc.hair/embed/movie/${key}` },
    // re-added 2026-08-14 live probe: vidsrc.io / vidsrc.su / vidsrc.to serve player pages
    { name: 'Vidsrc.io', src: `https://vidsrc.io/embed/movie/${key}` },
    { name: 'Vidsrc.su', src: `https://vidsrc.su/embed/movie/${key}` },
    { name: 'Vidsrc.to', src: `https://vidsrc.to/embed/movie/${key}` },
    // cinezo.gd naye servers — catalog ids ARE TMDB ids (verified), probed live 2026-08-09
    { name: 'VidLink', src: `https://vidlink.pro/movie/${d.id}?autoplay=true&title=true` },
    { name: 'VidUp', src: `https://vidup.to/movie/${d.id}?autoPlay=true&theme=16A085&nextButton=true&autoNext=true&sub=en` },
    { name: 'VidCore', src: `https://vidcore.net/movie/${d.id}` },
    { name: 'Vidsrc.mov', src: `https://vidsrc.mov/embed/movie/${d.id}` },
    { name: 'Vidsrc.fyi', src: `https://vidsrc.fyi/embed/movie/${d.id}` },
    { name: 'VidRock', src: `https://vidrock.net/movie/${d.id}` },
    { name: 'VidNest', src: `https://vidnest.fun/movie/${d.id}` },
    { name: 'VidKing', src: `https://www.vidking.net/embed/movie/${d.id}` },
    { name: 'Peachify', src: `https://peachify.top/embed/movie/${d.id}` },
    // GDrivePlayer re-added 2026-08-14 — host alive again (jwplayer page); movie only
    { name: 'GDrivePlayer', src: `https://database.gdriveplayer.us/player.php?imdb=${key}` },
    { name: 'YouTube', src: `/api/yt?q=${encodeURIComponent(`${d.name} ${d.year || ''} full movie`)}&min=2700` },
  ];
}
// All embeds failed (or native playback died) → simple error card.
function nativeError(fb, video, d, msg) {
  video.hidden = true;
  fb.hidden = false;
  fb.innerHTML = `<div class="no-src"><p>${esc(msg)}</p></div>`;
}

// ---------- render ----------
function render(d, wantS, wantE) {
  const isTV = d.type === 'tv';
  const seasons = isTV && d.seasons && d.seasons.length ? d.seasons : null;
  const seasonNums = seasons ? seasons.map((s) => s.num) : [];
  let season = wantS && seasonNums.includes(wantS) ? wantS
    : (seasonNums.includes(1) ? 1 : (seasonNums[0] || 0));
  const curSeason = seasons ? seasons.find((s) => s.num === season) : null;
  let episode = wantE && curSeason && wantE <= curSeason.episodes.length ? wantE : 1;
  // /watch/tv/:id (no s/e) should still boot the player at S1E1 — only gate on a
  // season actually existing, not on the URL depth.
  const hasEp = Boolean(curSeason && curSeason.episodes && curSeason.episodes.length);

  const bg = d.thumb ? `url('${esc(d.thumb)}')` : 'linear-gradient(135deg,#3a1030,#0c0c12)';
  const tags = [];
  if (d.year) tags.push(`<span class="year">${d.year}</span>`);
  if (d.rating) tags.push(`<span class="imdb-chip">★ ${esc(d.rating)}</span>`);
  const dura = dur(d.duration);
  if (dura) tags.push(`<span>${dura}</span>`);
  if (d.genres && d.genres.length) d.genres.slice(0, 3).forEach((g) => tags.push(`<span class="genre">${esc(g)}</span>`));

  main.innerHTML = `
    <section class="watch-hero">
      <div class="watch-bg" style="background-image:${bg}"></div>
      <div class="watch-content">
        <div class="watch-tags">${tags.join('')}</div>
        <h1 class="watch-title">${esc(d.title)}</h1>
        <p class="watch-desc">${esc(d.desc || '')}</p>
        <div class="watch-actions">${isTV ? '' : `<a class="btn btn-primary" href="/watch/movie/${d.id}">▶ &nbsp;Play</a>`}</div>
      </div>
    </section>
    <div class="watch-body">
      ${isTV ? tvPanel(d, season, episode, hasEp, seasons, curSeason) : moviePanel(d)}
    </div>`;

  if (isTV && seasons) {
    // season tabs
    document.querySelectorAll('.season-tabs button').forEach((b) => {
      if (!hasEp && b.dataset.season === String(season)) b.classList.add('active');
      b.addEventListener('click', () => {
        window.location.href = `/watch/tv/${d.id}/${b.dataset.season}/1`;
      });
    });
    // episode clicks
    document.querySelectorAll('.ep-item[data-e]').forEach((el) => {
      el.addEventListener('click', () => {
        window.location.href = `/watch/tv/${d.id}/${season}/${el.dataset.e}`;
      });
      if (hasEp && +el.dataset.e === episode) el.classList.add('active');
    });
    // server rotate — shared embed player (same code as the movie flow)
    initEmbed(d, tvEmbeds(d, season, episode), 'tv', season, episode);
  } else if (!isTV) {
    // Movies share the exact same rotation design as series (iframe + Change
    // Server), with MovieFlix native HLS riding as the final entry.
    initEmbed(d, movieEmbeds(d).concat([{ name: 'Native HD', native: true }]), 'movie', 0, 0);
  }
  maybeRelated(d);
}


// ---------- "If you liked X, you might also like…" related row ----------
function relCardHTML(m) {
  const type = m.type === 'tv' ? 'Series' : 'Movie';
  const img = m.poster
    ? `<img src="${esc(m.poster)}" alt="${esc(m.title)}" loading="lazy" onerror="this.style.display='none';this.parentElement.style.background='#252a37'">`
    : '';
  return `<a class="card" href="/watch/${m.type === 'tv' ? 'tv' : 'movie'}/${m.id}" data-id="${esc(m.id)}" data-type="${m.type}">
    <div class="card-poster">
      ${img || `<div class="p-fallback" style="background:#252a37">
        <div class="p-title">${esc(m.title)}</div><div class="p-sub">${type}</div></div>`}
      <div class="card-type-badge">${type}</div>
      <div class="card-overlay">
        <div class="card-name">${esc(m.title)}</div>
        <div class="card-meta"><span>HD</span><span>▶</span></div>
      </div>
    </div>
  </a>`;
}

function maybeRelated(d) {
  const rel = (d.related || []).filter((r) => !(r.id === d.id && (r.type || d.type) === d.type)).slice(0, 30);
  if (!rel.length) return;
  const body = document.querySelector('.watch-body');
  if (!body) return;
  const sec = document.createElement('section');
  sec.className = 'row-section related-section';
  sec.innerHTML = `
    <div class="row-head"><h2>If you liked <span class="rel-title">${esc(d.title)}</span>, you might also like…</h2>
      <div class="row-nav">
        <button data-scroll="-1" aria-label="Previous">‹</button>
        <button data-scroll="1" aria-label="Next">›</button>
      </div>
    </div>
    <div class="row-track-wrap"><div class="row-track">${rel.map(relCardHTML).join('')}</div></div>`;
  body.appendChild(sec);
  // home-page jaisa < > scroll (buttons hide on mobile via CSS)
  sec.querySelectorAll('.row-nav button').forEach((b) => {
    b.addEventListener('click', () => {
      sec.querySelector('.row-track').scrollBy({ left: b.dataset.scroll * 620, behavior: 'smooth' });
    });
  });
}


function moviePanel(d) {
  // Same shell as the TV player: iframe + server-rotate bar. The native
  // <video> stays hidden and is only used by the 'Native HD' rotation entry.
  const poster = d && (d.poster || d.thumb);
  return `
    <div class="video-shell">
      <video id="player" controls playsinline preload="none" hidden${poster ? ` poster="${esc(poster)}"` : ''}></video>
      <iframe id="embedFrame" class="tv-frame" allowfullscreen allow="autoplay; fullscreen; encrypted-media; picture-in-picture" referrerpolicy="origin"></iframe>
      <div class="server-bar">
        <button class="server-btn" id="serverNext">↻ Change Server</button>
        <span id="serverLabel" class="server-label"></span>
        <button class="server-btn" id="fullscreenBtn" title="Fullscreen" style="margin-left:8px">���</button>
      </div>
      <div class="quality-bar" id="langBar" hidden><span class="lang-label">Audio</span></div>
      <div id="resumeToast" class="resume-toast" hidden></div>
      <div class="player-fallback" id="playerFallback" hidden></div>
    </div>`;
}

function tvPanel(d, season, episode, hasEp, seasons, curSeason) {
  if (!seasons || !hasEp) return '';
  const tabs = seasons.map((s) => s.num)
    .map((n) => `<button data-season="${n}" ${n === season ? 'class="active"' : ''}>Season ${n}</button>`).join('');
  const eps = (seasons.find((s) => s.num === season) || { episodes: [] }).episodes
    .map((e) => {
      const img = (d.stills && d.stills[season] && d.stills[season][e]) || '';
      return `<div class="ep-item ${e === episode ? 'active' : ''}" data-e="${e}">`
        + (img ? `<img class="ep-thumb" src="${esc(img)}" alt="" loading="lazy">` : '')
        + `<span class="ep-label">E${e}</span></div>`;
    }).join('');
  const next = curSeason && episode < curSeason.episodes.length ? episode + 1 : null;
  return `
    <div class="ep-panel">
      <div class="season-tabs">${tabs}</div>
      <div class="ep-grid">${eps}</div>
    </div>
    <div class="video-shell">
      <iframe id="embedFrame" class="tv-frame" allowfullscreen allow="autoplay; fullscreen; encrypted-media; picture-in-picture" referrerpolicy="origin"></iframe>
      <div class="server-bar">
        <button class="server-btn" id="serverNext">↻ Change Server</button>
        <span id="serverLabel" class="server-label"></span>
        <button class="server-btn" id="fullscreenBtn" title="Fullscreen" style="margin-left:8px">���</button>
      </div>
      <div class="ep-actions">
        ${next ? `<a class="btn btn-primary" href="/watch/tv/${d.id}/${season}/${next}">Next Episode →</a>` : `<span class="done-chip">✓ Series complete</span>`}
        <button class="server-btn" id="markWatched">Mark watched ✓</button>
      </div>
    </div>`;
}

// ---------- shared embed player (series + movie) ----------
// One rotation, two entry types: {name, src} loads into the iframe, and the
// special {name, native:true} entry swaps the hidden <video> in and boots
// native HLS (MovieFlix). Server-side /api/sources prunes dead embeds right
// after first paint; if every embed is dead the player auto-lands on native.
let activeHls = null; // only one native HLS instance may exist at a time

function initEmbed(d, servers, type, season, episode) {
  const frame = $('#embedFrame'), label = $('#serverLabel'), video = $('#player');
  let si = 0;

  const loadServer = (i) => {
    si = i % servers.length;
    const s = servers[si];
    label.textContent = `Server ${si + 1}/${servers.length} — ${s.name}`;

    if (s.native) {
      // kill any lingering HLS session, then boot native playback in <video>
      if (activeHls) { try { activeHls.destroy(); } catch {} activeHls = null; }
      frame.src = ''; frame.hidden = true;
      if (video) video.hidden = false;
      bootNative(d, video, () => loadServer(si + 1));
    } else {
      if (video) { try { video.pause(); } catch {} video.hidden = true; }
      const lb = $('#langBar'); if (lb) lb.hidden = true; // audio bar belongs to native only
      frame.src = s.src; frame.hidden = false;
    }
  };
  loadServer(0);

  // live health check — drop dead sources. API returns {name,url} → remap to
  // {name,src}; movie rotation keeps the trailing 'Native HD' entry.
  const q = type === 'tv'
    ? `?type=tv&id=${encodeURIComponent(d.id)}&s=${season}&e=${episode}`
    : `?type=movie&id=${encodeURIComponent(d.id)}`;
  fetch(`/api/sources${q}`)
    .then((r) => r.json()).then((j) => {
      if (!j || !Array.isArray(j.list) || !j.list.length) return;
      const live = j.list.filter((x) => x.ok);
      if (type === 'movie' && servers.some((s) => s.native)) {
        if (!live.length) { loadServer(servers.length - 1); return; } // all embeds dead → native
        servers = live.map((x) => ({ name: x.name, src: x.url }))
          .concat([{ name: 'Native HD', native: true }]);
      } else if (live.length) {
        servers = live.map((x) => ({ name: x.name, src: x.url }));
      } else {
        return; // probes ok but everything dead — keep the client list
      }
      loadServer(0);
    }).catch(() => {});
  $('#serverNext').addEventListener('click', () => loadServer(si + 1));
  const fsBtn = $('#fullscreenBtn');
  if (fsBtn) fsBtn.addEventListener('click', () => {
    const target = frame && !frame.hidden ? frame : (video && !video.hidden ? video : null);
    if (target && target.requestFullscreen) {
      target.requestFullscreen().catch(() => {});
    } else if (target && target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
    } else if (target && target.mozRequestFullScreen) {
      target.mozRequestFullScreen();
    } else if (target && target.msRequestFullscreen) {
      target.msRequestFullscreen();
    }
  });
  // Continue Watching entry (position resume not possible cross-origin)
  cwSave({ title: d.title, poster: d.poster, thumb: d.thumb, type, id: d.id,
    s: type === 'tv' ? season : 0, e: type === 'tv' ? episode : 0, t: 0, d: 1 });
}

// ---------- native movie player (xpass/vidsrc HLS) ----------
// Rotates through /api/stream/movie servers on fatal errors, then hands back
// to the embed rotation via the onFail callback. When the master carries
// multiple audio renditions (#EXT-X-MEDIA:TYPE=AUDIO) the Audio bar appears
// so the user can switch dubbed/original language tracks (hls.js audioTracks).
function setupLangBar(hls) {
  const bar = $('#langBar');
  if (!bar || !hls || !hls.audioTracks) return;
  bar.replaceChildren(); // clear stale server's tracks
  const label = document.createElement('span');
  label.className = 'lang-label';
  label.textContent = 'Audio';
  bar.appendChild(label);
  const tracks = hls.audioTracks.filter((t) => t.id >= 0 && (t.name || t.lang));
  if (tracks.length < 2) { bar.hidden = true; return; }
  tracks.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quality-btn';
    b.textContent = t.name || t.lang;
    b.classList.toggle('active', t.id === hls.audioTrack);
    b.addEventListener('click', () => {
      try { hls.audioTrack = t.id; } catch {}
      bar.querySelectorAll('.quality-btn').forEach((x) => x.classList.toggle('active', x === b));
    });
    bar.appendChild(b);
  });
  bar.hidden = false;
}

async function bootNative(d, video, onFail) {
  const toast = $('#resumeToast'), fb = $('#playerFallback');
  showToast(toast, 'Loading stream…', null, '');
  let st = null, stTimer;
  try {
    const timeout = new Promise((_, rej) => { stTimer = setTimeout(() => rej(new Error('timeout')), 25000); });
    st = await Promise.race([(await fetch(`/api/stream/movie/${d.id}`)).json(), timeout]);
  } catch {}
  clearTimeout(stTimer);
  const servers = st && st.stream && st.servers && st.servers.length ? st.servers
    : (st && st.stream ? [{ src: st.src, label: st.label || 'VIP 1' }] : null);
  if (!st || !st.stream || !servers) {
    hideToast(toast);
    nativeError(fb, video, d, 'Native stream unavailable.');
    return;
  }

  const saved = cwRead('movie', d.id);
  const resumeAt = saved && saved.t > 25 && saved.d && saved.t < saved.d * 0.95 ? saved.t : 0;

  const onReady = () => {
    hideToast(toast);
    if (resumeAt) {
      video.currentTime = resumeAt;
      showToast(toast, `Resumed from ${fmt(resumeAt)}`, () => { video.currentTime = 0; hideToast(toast); }, 'Start over');
    }
    video.play().catch(() => {});
  };

  let hls = null, cur = 0;
  const killed = () => { try { hls.destroy(); } catch {} if (activeHls === hls) activeHls = null; hls = null; };

  const boot = (i) => {
    if (hls) killed();
    cur = i % servers.length;
    const s = servers[cur];
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 30, backBufferLength: 30 });
      activeHls = hls;
      const current = hls;
      hls.loadSource(s.src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setupLangBar(hls); // multi-audio masters → language switcher
        onReady();
      });
      let retries = 0;
      hls.on(Hls.Events.ERROR, (ev, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retries < 2) {
          retries++;
          setTimeout(() => { try { current.startLoad(); } catch {} }, 800 * retries);
          return;
        }
        try { current.destroy(); } catch {}
        if (activeHls === current) activeHls = null;
        hideToast(toast);
        if (cur + 1 < servers.length) { boot(cur + 1); return; }
        if (onFail) { onFail(); return; } // hand back to the embed rotation
        nativeError(fb, video, d, 'Playback failed on all sources.');
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = s.src;
      video.addEventListener('loadedmetadata', onReady);
    } else {
      fb.innerHTML = '<div class="no-src"><p>This browser cannot play HLS natively.</p></div>';
      return;
    }
  };

  boot(0);
  wireProgress(video, d, 0, 0);
}

function wireProgress(video, d, s, e) {
  let lastSave = 0;
  const save = () => {
    if (!video.duration || Number.isNaN(video.duration)) return;
    cwSave({ title: d.title, poster: d.poster, thumb: d.thumb, type: d.type, id: d.id, s, e, t: video.currentTime, d: video.duration });
  };
  video.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastSave > 5000) { lastSave = now; save(); }
  });
  video.addEventListener('pause', save);
  video.addEventListener('seeking', save);
  window.addEventListener('pagehide', save);
  video.addEventListener('ended', () => {
    if (video.duration && video.currentTime >= video.duration * 0.97) {
      cwRemove(d.type, d.id, s, e);
      showToast($('#resumeToast'), 'Watched — removed from Continue Watching');
    }
  });
  // clear stale entry when the user starts a fresh view (no resume position in URL)
}

// ============================================================
// MovieFlix pages — direct MP4 (remux HD / proxied SD + YouTube embed)
// ============================================================

// Boot one of /watch/mflm/:videoId or /watch/mfls/:encodedTitle/:ep.
// These never touch the 2Embed/HLS stack — mflix streams are plain MP4s.

function flixBg(thumb, title) {
  return thumb
    ? `url('${esc(thumb)}')`
    : `linear-gradient(135deg, hsl(${((title || '').length * 37) % 360}, 70%, 22%), #0c0c12)`;
}

// ---------- movie: /watch/mflm/:videoId ----------
async function loadMflixMovie(videoId) {
  main.innerHTML = '<div class="watch-body"><div class="loading-wrap" style="padding:60px 0"><div class="spinner"></div></div></div>';
  let d, stream;
  try {
    [d, stream] = await Promise.all([
      fetch(`/api/mflix/detail/movie/${videoId}`).then((r) => r.json()).catch(() => ({ ok: false })),
      fetch(`/api/mflix/stream/${videoId}`).then((r) => r.json()).catch(() => ({ ok: false })),
    ]);
  } catch (e) { d = { ok: false }; stream = { ok: false, reason: 'Server unreachable' }; }
  if (!d || !d.ok) { main.innerHTML = errCard('Movie not found.'); return; }
  // MovieBox: same movie exists per-language as a separate videoId —
  // chips let the user switch language IN-APP (re-plays that version).
  const versions = d.versions && d.versions.length > 1 ? d.versions : null;
  const langChips = versions ? versions.map((v) => `
      <button class="lang-chip ${v.id === videoId ? 'selected' : ''}" data-id="${esc(v.id)}">${esc(v.lang || 'Audio')}</button>`).join('') : '';
  // language row is ALWAYS visible: chips when the title has multiple
  // versions, otherwise just the current language so it's clear the feature
  // exists but this title has no other version in the catalog
  const langRow = `
    <div class="lang-row" id="flixLangRow">
      <span class="lang-label">${versions ? 'Languages' : 'Language'}</span>
      ${langChips || `<span class="lang-chip">${esc(d.lang || 'Audio')}</span>`}
      ${versions ? '' : '<span class="lang-note">— only this version in catalog</span>'}
    </div>`;
  main.innerHTML = `
    <section class="watch-hero">
      <div class="watch-bg" style="background-image:${flixBg(d.thumb, d.title)}"></div>
      <div class="watch-content">
        <div class="watch-tags"><span class="lang-chip">${esc(d.lang || '')}</span><span class="studio">STREAMING NOW</span></div>
        <h1 class="watch-title">${esc(d.title)}</h1>
        <p class="watch-desc">${esc(d.desc || '')}</p>
        ${langRow}
      </div>
    </section>
    <div class="watch-body">
      <div class="video-shell">
        <video id="player" controls playsinline preload="metadata"></video>
        <iframe id="mflixFrame" class="tv-frame" allowfullscreen allow="autoplay; fullscreen; encrypted-media; picture-in-picture" referrerpolicy="origin" hidden></iframe>
        <div class="quality-bar" id="qualityBar" hidden></div>
        <div id="resumeToast" class="resume-toast" hidden></div>
        <div class="player-fallback" id="playerFallback" hidden></div>
      </div>
      <div class="server-bar" style="margin-top:10px">
        <button class="server-btn" id="fullscreenBtn" title="Fullscreen">���</button>
      </div>
      <p class="watch-hint">Tip: HD = ffmpeg re-mux (10–60s first load). SD = direct stream. YouTube = inline embed.</p>
    </div>`;
  showToast($('#resumeToast'), 'Loading stream…', null, '');
  attachStream(stream, { type: 'mflix', id: videoId, title: d.title, thumb: d.thumb, s: 0, e: 0 });
  // language switch: chip -> that version's videoId, re-render in place
  const row = $('#flixLangRow');
  if (row && versions) row.querySelectorAll('.lang-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const id = chip.dataset.id;
      if (id && id !== videoId) {
        window.history.replaceState(null, '', `/watch/mflm/${encodeURIComponent(id)}`);
        document.title = d.title + ' – CineHall';
        loadMflixMovie(id);
      }
    });
  });
}

// ---------- series: /watch/mfls/:title/:ep ----------
async function loadMflixSeries(title, epWanted) {
  main.innerHTML = '<div class="watch-body"><div class="loading-wrap" style="padding:60px 0"><div class="spinner"></div></div></div>';
  let d;
  try {
    d = await fetch(`/api/mflix/detail/series/${encodeURIComponent(title)}`).then((r) => r.json()).catch(() => ({ ok: false }));
  } catch (e) { d = { ok: false }; }
  if (!d || !d.ok || !d.eps || !d.eps.length) { main.innerHTML = errCard('Series not found.'); return; }
  const total = d.eps.length;
  const ep = epWanted && epWanted >= 1 && epWanted <= total ? epWanted : 1;
  const epMeta = d.eps[ep - 1];
  const epGrid = d.eps.map((e, i) => {
    const n = i + 1;
    return `<div class="ep-item ${n === ep ? 'active' : ''}" data-e="${n}">
      ${e.thumb ? `<img class="ep-thumb" src="${esc(e.thumb)}" alt="" loading="lazy">` : ''}
      <div class="ep-label">E${n}</div></div>`;
  }).join('');
  main.innerHTML = `
    <section class="watch-hero">
      <div class="watch-bg" style="background-image:${flixBg(epMeta.thumb, d.title)}"></div>
      <div class="watch-content">
        <div class="watch-tags"><span class="lang-chip">${esc(d.lang || '')}</span><span>${total} episodes</span><span class="studio">MOVIEFLIX</span></div>
        <h1 class="watch-title">${esc(d.title)}</h1>
        <p class="watch-desc">Episode ${ep} of ${total} — pick any episode below</p>
        <div class="lang-row" id="flixLangRow">
          <span class="lang-label">Language</span>
          <span class="lang-chip">${esc(d.lang || 'Audio')}</span>
        </div>
      </div>
    </section>
    <div class="watch-body">
      <div class="ep-panel" style="margin-bottom:18px"><div class="ep-grid">${epGrid}</div></div>
      <div class="video-shell">
        <video id="player" controls playsinline preload="metadata"></video>
        <iframe id="mflixFrame" class="tv-frame" allowfullscreen allow="autoplay; fullscreen; encrypted-media; picture-in-picture" referrerpolicy="origin" hidden></iframe>
        <div class="quality-bar" id="qualityBar" hidden></div>
        <div id="resumeToast" class="resume-toast" hidden></div>
        <div class="player-fallback" id="playerFallback" hidden></div>
      </div>
      <div class="server-bar" style="margin-top:10px">
        <button class="server-btn" id="fullscreenBtn" title="Fullscreen">���</button>
      </div>
      <p class="watch-hint">Tip: HD = ffmpeg re-mux (10–30s first load). SD = direct stream. YouTube = inline embed.</p>
    </div>`;
  document.querySelectorAll('.ep-item[data-e]').forEach((el) => {
    el.addEventListener('click', () => { window.location.href = `/watch/mfls/${encodeURIComponent(d.title)}/${el.dataset.e}`; });
  });
  showToast($('#resumeToast'), 'Loading stream…', null, '');
  let stream;
  try {
    stream = await (await fetch(`/api/mflix/stream/${epMeta.id}`)).json();
  } catch (e) { stream = null; }
  attachStream(stream, { type: 'mfls', id: d.title, title: d.title, thumb: epMeta.thumb, s: 0, e: ep });
}

// ---------- shared player wiring (movie + series episode) ----------
// formats: { hd:{url,label}, sd:{url,label}, embed:url }. hd/sd are plain MP4
// URLs (remux or proxied) playable directly by <video> — no HLS needed here.
function attachStream(stream, cw) {
  const video = $('#player');
  const frame = $('#mflixFrame');
  const qbar = $('#qualityBar');
  const toast = $('#resumeToast');
  const fb = $('#playerFallback');
  const f = stream && stream.ok && stream.formats ? stream.formats : null;
  const fail = (msg) => {
    hideToast(toast);
    fb.hidden = false;
    fb.innerHTML = `<div class="no-src"><p>${esc(msg)}</p>
      <p style="margin-top:20px"><a class="btn btn-icon" href="/">← Home</a></p></div>`;
  };
  if (!f) { fail((stream && stream.reason) || 'Stream unavailable.'); return; }
  const avail = [];
  if (f.hd) avail.push('hd');
  if (f.sd) avail.push('sd');
  if (f.embed) avail.push('embed');
  if (!avail.length) { fail('No playable formats returned.'); return; }
  const labels = { hd: (f.hd && f.hd.label) || 'HD', sd: (f.sd && f.sd.label) || 'SD', embed: 'YouTube' };
  qbar.hidden = false;
  const btns = {};
  avail.forEach((k) => {
    const b = document.createElement('button');
    b.dataset.q = k;
    b.textContent = labels[k];
    qbar.appendChild(b);
    btns[k] = b;
  });
  let cur = avail.includes('hd') ? 'hd' : (avail.includes('sd') ? 'sd' : 'embed');
  const setActive = (k) => { cur = k; Object.values(btns).forEach((b) => b.classList.toggle('active', b.dataset.q === k)); };
  const toNative = (k) => {
    frame.hidden = true; frame.src = '';
    video.hidden = false;
    if (video.src !== f[k].url) { video.src = f[k].url; video.currentTime = 0; }
    video.play().catch(() => {});
  };
  const toEmbed = () => {
    video.pause();
    video.hidden = true;
    hideToast(toast);
    frame.src = f.embed;
    frame.hidden = false;
  };
  const switchTo = (k) => {
    setActive(k);
    if (k === 'embed') toEmbed();
    else toNative(k);
  };
  qbar.querySelectorAll('.quality-btn').forEach((b) => b.addEventListener('click', () => switchTo(b.dataset.q)));
  switchTo(cur);
  // Fullscreen button for MovieFlix
  const fsBtn = $('#fullscreenBtn');
  if (fsBtn) fsBtn.addEventListener('click', () => {
    const target = frame && !frame.hidden ? frame : (video && !video.hidden ? video : null);
    if (target && target.requestFullscreen) {
      target.requestFullscreen().catch(() => {});
    } else if (target && target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
    } else if (target && target.mozRequestFullScreen) {
      target.mozRequestFullScreen();
    } else if (target && target.msRequestFullscreen) {
      target.msRequestFullscreen();
    }
  });
  video.addEventListener('loadedmetadata', () => {
    hideToast(toast);
    const saved = cwRead(cw.type, cw.id, cw.s || 0, cw.e || 0);
    const t = saved && saved.t > 25 && saved.d && saved.t < saved.d * 0.95 ? saved.t : 0;
    if (t) { video.currentTime = t; showToast(toast, 'Resumed from ' + fmt(t), () => { video.currentTime = 0; }, 'Start over'); }
  });
  video.addEventListener('error', () => {
    if (cur === 'embed') return;
    const queue = avail.filter((k) => k !== 'embed');
    const i = queue.indexOf(cur);
    const next = queue[i + 1];
    if (next) { switchTo(next); return; }
    if (f.embed) { switchTo('embed'); return; }
    hideToast(toast);
    fb.hidden = false;
    fb.innerHTML = '<div class="no-src"><p>Playback failed on all sources.</p></div>';
  });
  wireProgress(video, { title: cw.title, poster: '', thumb: cw.thumb, type: cw.type, id: cw.id }, cw.s || 0, cw.e || 0);
}

function showToast(el, msg, actionCb, actionLabel) {
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `<span>${esc(msg)}</span>${actionCb ? `<button class="toast-btn">${esc(actionLabel || 'OK')}</button>` : ''}`;
  if (actionCb) el.querySelector('button').addEventListener('click', () => { actionCb(); hideToast(el); });
  clearTimeout(el._t);
  el._t = setTimeout(() => hideToast(el), 7000);
}
function hideToast(el) { if (el) el.hidden = true; }