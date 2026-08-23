'use strict';
/* CineHall frontend — loads live catalog from the local API */
const $ = (s) => document.querySelector(s);
const main = $('#main');
const header = $('#header');

const CATS = {
  movies: { title: 'Movies', api: 'movies' },
  series: { title: 'TV Series', api: 'tv' },
  anime: { title: 'Anime', api: 'anime' },
};

// ---------- gradient fallback (keeps the original design's poster-less look) ----------
function gradFor(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360;
  const c1 = `hsl(${h}, 70%, 28%)`;
  const c2 = `hsl(${(h + 70) % 360}, 75%, 14%)`;
  return `linear-gradient(135deg, ${c1}, ${c2})`;
}

// MovieFlix cards carry type 'mflix' (movie) / 'mfls' (series); their id is a
// YouTube videoId / URL-encoded series title, NOT the internal catalog id.
function hrefFor(m) {
  if (m.type === 'mflix') return `/watch/mflm/${m.id}`;
  if (m.type === 'mfls') return `/watch/mfls/${encodeURIComponent(m.id)}`;
  return `/watch/${m.type}/${m.id}`;
}

// ---------- card ----------
function cardHTML(m) {
  const type = m.type === 'tv' || m.type === 'mfls' ? 'Series' : 'Movie';
  const poster = m.posterSm || m.poster || m.thumb;
  const img = poster
    ? `<img src="${esc(poster)}" alt="${esc(m.title)}" loading="lazy" onerror="this.style.display='none';this.parentElement.style.background='${gradFor(m.title)}'">`
    : '';
  const meta = [];
  if (m.rating) meta.push(`<span class="imdb-chip">IMDb ${esc(m.rating)}</span>`);
  if (m.year) meta.push(`<span>${esc(m.year)}</span>`);
  if (m.lang) meta.push(`<span class="lang-chip">${esc(m.lang)}</span>`);
  // MovieFlix multi-language titles: a "N languages" chip tells the user the
  // watch page has in-app language switching (multiple videoIds per title).
  if (m.versions && m.versions.length > 1) meta.push(`<span class="lang-chip multi">${m.versions.length} languages</span>`);
  return `<a class="card" href="${hrefFor(m)}" data-id="${esc(m.id)}" data-type="${m.type}">
    <div class="card-poster">
      ${img || `<div class="p-fallback" style="background:${gradFor(m.title)}">
        <div class="p-title">${esc(m.title)}</div><div class="p-sub">${type}</div></div>`}
      <div class="card-type-badge">${type}</div>
      <div class="card-overlay">
        <div class="card-name">${esc(m.title)}</div>
        <div class="card-meta">${meta.join('') || `<span>HD</span>`}<span>▶</span></div>
      </div>
    </div>
  </a>`;
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- hero ----------
function renderHero(items) {
  if (!items || !items.length) return '';
  const slides = items.slice(0, 6).map((h, i) => {
    const bg = h.backdrop
      ? `url('${esc(h.backdrop)}')`
      : gradFor(h.title);
    const tags = [];
    if (h.year) tags.push(`<span class="year">${h.year}</span>`);
    if (h.rating) tags.push(`<span class="rating"><span class="star">★</span> ${h.rating}</span>`);
    if (h.genres && h.genres.length) tags.push(`<span class="genre">${esc(h.genres[0])}</span>`);
    tags.push(`<span class="studio">${h.type === 'tv' ? 'TV SERIES' : 'MOVIE'}</span>`);
    return `<div class="hero-slide ${i === 0 ? 'active' : ''}" data-slide="${i}" style="background-image:${bg}">
      <div class="hero-content">
        <div class="hero-content-inner">
          <div class="hero-badge">Now Streaming</div>
          <h1 class="hero-title">${esc(h.title)}</h1>
          <div class="hero-tags">${tags.join('')}</div>
          <p class="hero-desc">${esc(h.desc || 'Stream this title right now — HD quality, no account needed.')}</p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="/watch/${h.type}/${h.id}">▶ &nbsp;Watch Now</a>
            <a class="btn btn-icon" href="/watch/${h.type}/${h.id}" title="Info">ℹ</a>
          </div>
        </div>
      </div>
    </div>`;
  });
  return `<section class="hero" id="hero">${slides.join('')}
    <div class="hero-dots">${items.slice(0, 6).map((_, i) => `<span class="${i === 0 ? 'active' : ''}" data-dot="${i}"></span>`).join('')}</div>
  </section>`;
}

function heroDots() {
  const dots = document.querySelectorAll('.hero-dots span');
  if (!dots.length) return;
  let cur = 0;
  const slides = document.querySelectorAll('.hero-slide');
  const go = (i) => {
    slides[cur].classList.remove('active');
    dots[cur].classList.remove('active');
    cur = i % slides.length;
    slides[cur].classList.add('active');
    dots[cur].classList.add('active');
  };
  dots.forEach((d) => d.addEventListener('click', () => go(+d.dataset.dot)));
  setInterval(() => go(cur + 1), 7000);
}

// ---------- rows ----------
function rowHTML(row) {
  return `<section class="row-section" data-key="${row.key}">
    <div class="row-head">
      <h2>${esc(row.title)}</h2>
      <div class="row-nav">
        <button data-scroll="-1" aria-label="Previous">‹</button>
        <button data-scroll="1" aria-label="Next">›</button>
      </div>
    </div>
    <div class="row-track-wrap"><div class="row-track">${row.items.map(cardHTML).join('') || '<p style="color:var(--text-dim);padding:10px 0">Loading…</p>'}</div></div>
  </section>`;
}

function wireRows() {
  document.querySelectorAll('.row-nav button').forEach((b) => {
    b.addEventListener('click', () => {
      const track = b.closest('.row-section').querySelector('.row-track');
      track.scrollBy({ left: b.dataset.scroll * 620, behavior: 'smooth' });
    });
  });
}

function skeletonRows(n = 3) {
  let out = '';
  for (let r = 0; r < n; r++) {
    out += `<section class="row-section"><div class="row-head"><h2>&nbsp;</h2></div>
      <div class="row-track-wrap"><div class="row-track">${Array(8).fill('<div class="skeleton-card"></div>').join('')}</div></div></section>`;
  }
  return out;
}

// ---------- browse grid ----------
async function renderBrowse(section, page = 1) {
  const api = section === 'series' ? 'tv' : section; // nav says 'series', API expects 'tv'
  const title = section === 'movies' ? 'Movies' : section === 'anime' ? 'Anime' : 'TV Series';
  main.innerHTML = `
    <section class="browse-page">
      <div class="browse-head">
        <h1>${title}</h1>
        <div class="pager">
          <button id="pgPrev" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
          <span class="page-num">Page ${page}</span>
          <button id="pgNext">Next →</button>
        </div>
      </div>
      <div class="grid" id="grid"><div class="loading-wrap" style="padding:40px 0"><div class="spinner"></div></div></div>
    </section>`;
  setActiveNav(section === 'movies' ? 'movies' : section === 'anime' ? 'anime' : 'series');
  $('#pgPrev').onclick = () => renderBrowse(section, page - 1);
  $('#pgNext').onclick = () => renderBrowse(section, page + 1);
  try {
    const r = await fetch(`/api/browse?section=${api}&page=${page}`);
    const d = await r.json();
    const grid = $('#grid');
    if (!d.items || !d.items.length) { grid.innerHTML = '<p style="color:var(--text-dim);padding:30px">Nothing here yet.</p>'; return; }
    grid.innerHTML = d.items.map(cardHTML).join('');
    // curated catalogs (anime) report maxPage — cap Next at it
    if ((d.maxPage && page >= d.maxPage) || page >= 250) $('#pgNext').disabled = true;
  } catch (e) {
    $('#grid').innerHTML = '<p style="color:var(--text-dim);padding:30px">Failed to load — is the server running?</p>';
  }
}

// ---------- continue watching (localStorage) ----------
function cwRow() {
  const items = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('cwh:')) continue;
      try {
        const rec = JSON.parse(localStorage.getItem(k));
        if (rec && rec.title) items.push(rec);
      } catch { /* corrupt entry — skip */ }
    }
  } catch { return ''; }
  if (!items.length) return '';
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const cards = items.slice(0, 14).map((r) => {
    const pct = r.d ? Math.max(0, Math.min(100, Math.round(((r.t || 0) / r.d) * 100))) : 0;
    const href = r.type === 'tv' ? `/watch/tv/${r.id}/${r.s || 1}/${r.e || 1}`
      : r.type === 'mflix' ? `/watch/mflm/${r.id}`
      : r.type === 'mfls' ? `/watch/mfls/${encodeURIComponent(r.id)}/${r.e || 1}`
      : `/watch/movie/${r.id}`;
    // thumb (w1280 backdrop) is 16:9 → landscape cards; poster is the portrait fallback
    const poster = r.thumb || r.poster || '';
    const img = poster
      ? `<img src="${esc(poster)}" alt="${esc(r.title)}" loading="lazy" onerror="this.style.display='none';this.parentElement.style.background='${gradFor(r.title)}'">`
      : '';
    const sub = r.type === 'tv' ? `S${r.s || 1} · E${r.e || 1}` : r.type === 'mfls' ? `E${r.e || 1}` : (pct ? `${pct}% watched` : 'Movie');
    return `<a class="card cw-card" href="${href}">
      <div class="card-poster">
        ${img || `<div class="p-fallback" style="background:${gradFor(r.title)}">
          <div class="p-title">${esc(r.title)}</div><div class="p-sub">${r.type === 'tv' || r.type === 'mfls' ? 'Series' : 'Movie'}</div></div>`}
        <button class="cw-del" type="button" data-type="${esc(r.type)}" data-id="${esc(r.id)}" aria-label="Remove from Continue Watching" title="Remove">✕</button>
        <span class="cw-badge">▶ Resume</span>
        <div class="cw-bar"><span style="width:${pct}%"></span></div>
        <div class="card-overlay">
          <div class="card-name">${esc(r.title)}</div>
          <div class="card-meta"><span>${esc(sub)}</span><span>▶</span></div>
        </div>
      </div>
    </a>`;
  }).join('');
  return `<section class="row-section cw-row" data-key="cw">
    <div class="row-head">
      <h2>↺ Continue Watching</h2>
      <div class="row-nav"><button data-scroll="-1" aria-label="Previous">‹</button><button data-scroll="1" aria-label="Next">›</button></div>
    </div>
    <div class="row-track-wrap"><div class="row-track">${cards}</div></div>
  </section>`;
}

// ---------- remove from continue watching ----------
// Deleting a card removes EVERY entry for that title (all seasons/episodes) —
// the card represents the show, not one episode.
function remCW(type, id) {
  try {
    const rm = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`cwh:${type}:${id}:`)) rm.push(k);
    }
    rm.forEach((k) => localStorage.removeItem(k));
    return rm.length > 0;
  } catch { return false; }
}

function wireCW() {
  document.querySelectorAll('.cw-del').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      remCW(b.dataset.type, b.dataset.id);
      // re-render only this section — other rows keep their scroll positions
      const cur = document.querySelector('.cw-row');
      const fresh = cwRow();
      if (fresh && cur) { cur.outerHTML = fresh; wireCW(); wireRows(); }
      else if (cur) { cur.remove(); }
    });
  });
}

// ---------- home ----------
async function renderHome() {
  setActiveNav('home');
  main.innerHTML = skeletonRows(3);
  let d;
  try {
    d = await (await fetch('/api/home')).json();
  } catch (e) {
    main.innerHTML = '<div class="loading-wrap"><div class="spinner"></div><p>Connecting to catalog… (first run builds the database)</p></div>';
    return;
  }
  const hero = d.hero || [];
  const rows = d.rows || [];
  main.innerHTML = renderHero(hero) + `<div class="rows">${cwRow()}${rows.map(rowHTML).join('')}</div>`;
  heroDots();
  wireRows();
  wireCW();
}

// ---------- nav ----------
function setActiveNav(cat) {
  document.querySelectorAll('nav a, .mobile-nav a').forEach((a) => a.classList.toggle('active', a.dataset.cat === cat));
}
function closeMobileNav() { $('#mobileNav').classList.remove('open'); $('#scrim').classList.remove('show'); $('#hamburger').classList.remove('open'); }

function bindNav() {
  document.querySelectorAll('nav a, .mobile-nav a').forEach((a) => {
    a.addEventListener('click', () => {
      closeMobileNav();
      if (a.dataset.cat === 'home') renderHome();
      else if (a.dataset.cat === 'movies' || a.dataset.cat === 'series' || a.dataset.cat === 'anime') renderBrowse(a.dataset.cat, 1);
      window.scrollTo({ top: 0 });
    });
  });
  $('#brand').addEventListener('click', () => { renderHome(); window.scrollTo({ top: 0 }); });
  $('#hamburger').addEventListener('click', () => {
    const open = $('#mobileNav').classList.toggle('open');
    $('#scrim').classList.toggle('show', open);
    $('#hamburger').classList.toggle('open', open);
  });
  $('#scrim').addEventListener('click', closeMobileNav);
  window.addEventListener('scroll', () => header.classList.toggle('scrolled', window.scrollY > 30));
}

// ---------- search ----------
let searchTimer = null;
let trendingCache = { ts: 0, items: [] };

function searchItemHTML(it) {
  const thumb = it.poster || it.thumb;
  return `<a class="search-item" href="${hrefFor(it)}">
    <div class="search-thumb" style="${thumb ? '' : 'background:' + gradFor(it.title)}">${thumb ? `<img src="${esc(thumb)}" alt="">` : esc(it.title.slice(0, 4))}</div>
    <div class="search-meta">
      <span class="search-title">${esc(it.title)}</span>
      <span class="search-sub">${esc(it.sub || (it.type === 'tv' || it.type === 'mfls' ? 'TV Series' : 'Movie') + ' · HD')}</span>
    </div>
  </a>`;
}

function searchFooter(q) {
  return `<a class="search-more" href="#">See all results for <b>"${esc(q)}"</b> →</a>`;
}

async function loadTrending() {
  if (trendingCache.items.length && Date.now() - trendingCache.ts < 10 * 60 * 1000) return trendingCache.items;
  try {
    const d = await (await fetch('/api/search/trending')).json();
    trendingCache = { ts: Date.now(), items: d.items || [] };
  } catch (e) { trendingCache = { ts: Date.now(), items: [] }; }
  return trendingCache.items;
}

function bindSearch() {
  const box = $('#searchBox');
  const results = $('#searchResults');
  // Click/focus on an empty box -> trending Hollywood suggestions
  box.addEventListener('focus', async () => {
    if (box.value.trim() || results.classList.contains('show')) return;
    const items = await loadTrending();
    if (!items.length || box.value.trim()) return;
    results.innerHTML = '<div class="search-head">Trending Hollywood</div>' + items.map(searchItemHTML).join('');
    results.classList.add('show');
  });
  box.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = box.value.trim();
    if (!q) { results.classList.remove('show'); results.innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      try {
        const [d, mf] = await Promise.all([
          fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => ({ items: [] })),
          fetch(`/api/mflix/search?q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => ({ items: [] })),
        ]);
        const items = [...(d.items || []), ...(mf.items || [])].slice(0, 8);
        if (!items.length) {
          results.innerHTML = '<div class="search-empty">No results for "' + esc(q) + '"</div>';
        } else {
          let html = '';
          // typo correction from the backend: show what we matched against
          if (d.didYouMean && d.didYouMean.toLowerCase() !== q.toLowerCase()) {
            html += '<div class="search-tip">Showing results for <b>"' + esc(d.didYouMean) + '"</b> — did you mean this?</div>';
          }
          html += items.map(searchItemHTML).join('') + searchFooter(q);
          results.innerHTML = html;
        }
        results.classList.add('show');
      } catch (e) { /* server mid-boot */ }
    }, 250);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      results.classList.remove('show');
      const q = box.value.trim();
      if (q) renderSearchResults(q); // results page — never auto-open the first hit
      else box.blur();
    }
    if (e.key === 'Escape') { results.classList.remove('show'); box.blur(); }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) results.classList.remove('show');
    const more = e.target.closest('.search-more');
    if (more) {
      e.preventDefault();
      results.classList.remove('show');
      renderSearchResults(box.value.trim());
    }
  });
}

// ---------- search results page (matches + similar) ----------
async function renderSearchResults(q) {
  closeMobileNav();
  setActiveNav(null);
  $('#searchBox').blur();
  main.innerHTML = `<section class="browse-page"><div class="browse-head">
      <h1>Results for <span class="q">"${esc(q)}"</span></h1>
      <p class="browse-sub">Searching…</p>
    </div><div class="grid" id="searchGrid">${Array(12).fill('<div class="skeleton-card"></div>').join('')}</div></section>`;
  window.scrollTo({ top: 0 });
  let d;
  try {
    d = await (await fetch(`/api/search/full?q=${encodeURIComponent(q)}`)).json();
  } catch (e) { d = { items: [], similar: [] }; }
  const head = main.querySelector('.browse-head');
  const didYouMean = (d.didYouMean && d.didYouMean.toLowerCase() !== q.toLowerCase())
    ? `Showing results for <b>"${esc(d.didYouMean)}"</b> — did you mean this?`
    : 'Matching and similar titles';
  head.innerHTML = `<h1>Results for <span class="q">"${esc(q)}"</span></h1><p class="browse-sub">${didYouMean}</p>`;
  const grid = main.querySelector('#searchGrid');
  if (!d.items || !d.items.length) {
    grid.outerHTML = '<div class="search-empty" style="padding:60px 0">No matches for "' + esc(q) + '". Try a different spelling.</div>';
    return;
  }
  grid.id = '';
  grid.innerHTML = d.items.map(cardHTML).join('');
  if (d.similar && d.similar.length) {
    main.insertAdjacentHTML('beforeend', `<section class="row-section" style="margin-top:48px"><div class="row-head"><h2>Similar titles</h2></div>
      <div class="row-track-wrap"><div class="row-track">${d.similar.map(cardHTML).join('')}</div></div></section>`);
    wireRows();
  }
}

// ---------- boot ----------
bindNav();
bindSearch();
renderHome();
