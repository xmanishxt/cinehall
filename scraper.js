// scraper.js — 123moviesfree.yachts catalog + detail scraper (CineHall)
// Parses SSR HTML into structured JSON. Source: 123moviesfree.yachts (MovieBox/123Movies APK lead)
'use strict';
const https = require('https');
const http = require('http');

const BASE = 'https://123moviesfree.yachts';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36';

// ---------- HTTP fetch ----------
function fetch(url, timeout = 15000, retries = 2) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    let current = url;
    let redirects = 0;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const attempt = (left) => {
      const req = mod.get(current, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects >= 8) return done({ ok: false, status: res.statusCode, html: '' });
          redirects++;
          current = new URL(res.headers.location, current).toString(); // follow the actual Location
          req.removeAllListeners('timeout'); // old request must not trigger a retry
          return attempt(left);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return done({ ok: false, status: res.statusCode, html: '' });
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { done({ ok: true, status: 200, html: Buffer.concat(chunks).toString('utf8') }); }
          catch (e) { done({ ok: false, status: 0, html: '' }); }
        });
      });
      req.setTimeout(timeout);
      req.on('timeout', () => { if (settled) return; req.destroy(); if (left > 0) attempt(left - 1); else done({ ok: false, status: 0, html: '' }); });
      req.on('error', () => { if (settled) return; if (left > 0) attempt(left - 1); else done({ ok: false, status: 0, html: '' }); });
    };
    attempt(retries);
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Card parsing (movies/tv-series/top-imdb/search pages) ----------
// Split the page into one chunk per card, then extract fields per chunk.
// This avoids cross-card regex bleed (e.g. cards whose <img> has no direct src).
const CARD_START = '<div class="card h-100 border-0 shadow">';

// SSR pages HTML-escape titles (&#039; &quot; &amp; …) — decode so the API
// returns clean text instead of "The Devil&#039;s Mouth".
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
const LINK_RE = /href="\/(movie|tv-series)\/([\w-]+)-(\d+)\/"/;
const POSTER_RE = /src="(https:\/\/image\.tmdb\.org\/t\/p\/w185\/([^"]+))"|data-src="(https:\/\/image\.tmdb\.org\/t\/p\/w185\/([^"]+))"/;
const TITLE_RE = /card-title[^>]*>([^<]*)<\/(?:h\d|a)>/;

function parseCards(html) {
  const items = [];
  let start = 0;
  while ((start = html.indexOf(CARD_START, start)) !== -1) {
    const chunkStart = start + CARD_START.length;
    const end = html.indexOf(CARD_START, chunkStart);
    const chunk = html.slice(chunkStart, end === -1 ? undefined : end);
    const link = chunk.match(LINK_RE);
    const poster = chunk.match(POSTER_RE);
    const titleM = chunk.match(TITLE_RE);
    if (!link || !titleM) { start = chunkStart; continue; }
    const type = link[1] === 'tv-series' ? 'tv' : 'movie';
    const slug = link[2];
    const id = parseInt(link[3], 10);
    const title = decodeEntities(titleM[1]).trim();
    const posterPath = (poster && (poster[2] || poster[4])) || null;
    if (id && title) {
      items.push({
        id, slug, title, type,
        poster: posterPath ? 'https://image.tmdb.org/t/p/w500/' + posterPath : null,
      });
    }
    start = chunkStart;
  }
  return items;
}

// ---------- "You May Also Like" related grid (detail page bottom) ----------
// Detail pages end with a fixed related grid under:
//   <div class="card-header ...><div class="fs-6 list-title">You May Also Like</div></div>
//   <div class="row row-cols-2 row-cols-sm-4 row-cols-lg-6 list-rel g-3">…cards…</div>
// The cards use the same h-100 markup as catalog cards but with w342 posters
// (parseCards' POSTER_RE only matches w185), so they get their own parser,
// scoped by the grid wrapper instead of scanning the whole page.
const REL_GRID = '<div class="row row-cols-2 row-cols-sm-4 row-cols-lg-6 list-rel g-3">';
const REL_POSTER_RE = /src="(https:\/\/image\.tmdb\.org\/t\/p\/w(?:185|342)\/([^"]+))"|data-src="(https:\/\/image\.tmdb\.org\/t\/p\/w(?:185|342)\/([^"]+))"/;

function parseRelated(html) {
  const grid = html.indexOf(REL_GRID);
  if (grid === -1) return [];
  const items = [];
  let idx = grid, guard = 0;
  while ((idx = html.indexOf(CARD_START, idx)) !== -1 && guard++ < 40) {
    const chunkStart = idx + CARD_START.length;
    const end = html.indexOf(CARD_START, chunkStart);
    const chunk = html.slice(chunkStart, end === -1 ? undefined : end);
    const link = chunk.match(LINK_RE);
    const poster = chunk.match(REL_POSTER_RE);
    const titleM = chunk.match(TITLE_RE);
    if (link && titleM) {
      const id = parseInt(link[3], 10);
      const title = decodeEntities(titleM[1]).trim();
      const posterPath = (poster && (poster[2] || poster[4])) || null;
      if (id && title) {
        items.push({
          id, slug: link[2], title,
          type: link[1] === 'tv-series' ? 'tv' : 'movie',
          poster: posterPath ? 'https://image.tmdb.org/t/p/w500/' + posterPath : null,
        });
      }
    }
    idx = chunkStart;
  }
  return items;
}

// ---------- Detail page parsing ----------
function parseJSONLD(html) {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch (e) { return null; }
}

function parseDetails(html, fallback) {
  const ld = parseJSONLD(html) || {};
  const name = ld.name ? decodeEntities(ld.name).replace(/^Watch\s*|\s*for Free.*$/ig, '') : fallback.title;
  const desc = (ld.description || '').trim();
  const uploadDate = ((ld.datePublished || ld.uploadDate) || '').split('T')[0];
  const year = uploadDate ? (parseInt(uploadDate.slice(0, 4), 10) || null) : null;
  const rating = ld.aggregateRating ? ld.aggregateRating.ratingValue : null;
  const ratingCount = ld.aggregateRating ? ld.aggregateRating.ratingCount : null;
  // the site fills missing images with its own relative '/img/no-poster.png' —
  // must not leak into backdrops/heroes as a broken 'url(/img/...)' on our host
  const thRaw = ld.thumbnailUrl && ld.thumbnailUrl[0];
  const thumb = thRaw && /^https?:/i.test(thRaw) ? thRaw : null;

  // embed servers
  const servers = [];
  const nameRe = /data-server-name="([^"]*)"/g;
  const srcRe = /data-server-src="([^"]*)"/g;
  const names = [], srcs = [];
  let x;
  while ((x = nameRe.exec(html))) names.push(x[1]);
  while ((x = srcRe.exec(html))) srcs.push(x[1].replace(/&amp;/g, '&'));
  for (let i = 0; i < srcs.length; i++) {
    servers.push({ name: names[i] || ('Server ' + (i + 1)), src: srcs[i] });
  }

  // imdb id from embedmaster / stream.xps urls if present
  let imdb = null;
  const imdbM = html.match(/embedmaster[^? ]*?\/(movie|tv)\/(tt\d+)/) || html.match(/xps\?imdb=(tt\d+)/);
  if (imdbM) imdb = imdbM[2] || imdbM[1];

  // genres from the detail-page "Genre:" paragraph (<a href="/genre/X/">Label</a>)
  const genres = [];
  const genreBlock = html.match(/<strong>Genre:<\/strong>([\s\S]*?)<\/p>/);
  if (genreBlock) {
    const gRe = /href="\/genre\/[^"]*"[^>]*>([^<]+)</g;
    let g;
    while ((g = gRe.exec(genreBlock[1]))) {
      const t = decodeEntities(g[1]).trim();
      if (t && !genres.includes(t)) genres.push(t);
    }
  }

  // ---------- TV: seasons + episodes ----------
  let seasons = null;
  if (fallback.type === 'tv') {
    seasons = [];
    const sRe = /<option value="(\d+)"[^>]*data-episode-count="(\d+)"[^>]*>([^<]*)/g;
    let s;
    while ((s = sRe.exec(html))) {
      seasons.push({ num: parseInt(s[1], 10), label: s[3].trim() || ('Season ' + s[1]),
        episodes: Array.from({ length: parseInt(s[2], 10) }, (_, i) => i + 1) });
    }
    if (seasons.length === 0) seasons = null;
  }
  const duration = ld.duration || null;

  return { name, desc, year, rating, ratingCount, thumb, servers, genres, seasons, duration, imdb };
}

// ---------- Public API ----------
async function getList(section, page = 1) {
  // section: 'movies' | 'tv-series' | 'top-imdb'
  const url = page > 1 ? `${BASE}/${section}/page/${page}/` : `${BASE}/${section}/`;
  const r = await fetch(url);
  if (!r.ok) return { ok: false, items: [] };
  const items = parseCards(r.html);
  return { ok: items.length > 0, items };
}

async function getSearch(query) {
  const url = `${BASE}/search/?q=${encodeURIComponent(query)}`;
  const r = await fetch(url);
  if (!r.ok) return { ok: false, items: [] };
  const items = parseCards(r.html);
  const merged = dedupe(items);
  return { ok: merged.length > 0, items: merged };
}

async function getDetail(type, id, slug) {
  const path = type === 'tv' ? 'tv-series' : 'movie';
  const url = `${BASE}/${path}/${slug || id}-${id}/`;
  const r = await fetch(url);
  if (!r.ok) return { ok: false };
  const fallback = { title: slug || String(id), type };
  const detail = parseDetails(r.html, fallback);
  const related = parseRelated(r.html);
  if (type === 'tv' && detail.seasons && detail.seasons.length) {
    try { detail.stills = await getEpisodeStills(id, detail.seasons); } catch (e) { /* non-fatal */ }
  }
  return { ok: true, ...detail, related };
}

// ---------- Episode thumbnails (TMDB season pages) ----------
// CineHall ids ARE TMDB ids, and TMDB's season pages are server-rendered with
// one card per episode: <a class="no_click open" data-episode-number="N">…
// <img class="backdrop" src="…w320_and_h180_face/…jpg">. The img lookup is
// scoped to the anchor's own block so the lazy regex can't bleed into the
// next episode's card (TMDB renders a second, shifted episode list on the
// same page). Failures are non-fatal — shows without stills keep number-only
// boxes.
const TMDB_ORIGIN = 'https://www.themoviedb.org';
const TMDB_EP_CARD_RE = /<a class="no_click open"[^>]*data-episode-number="(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
const TMDB_STILL_RE = /src="(https:\/\/media\.themoviedb\.org\/t\/p\/w320_and_h180_face\/[^"]+)"/;

async function getEpisodeStills(id, seasons) {
  const stills = {};
  let i = 0;
  const worker = async () => {
    while (i < seasons.length) {
      const s = seasons[i++];
      try {
        const r = await fetch(`${TMDB_ORIGIN}/tv/${id}/season/${s.num}`);
        if (!r.ok || !r.html) continue;
        const map = {};
        let m;
        TMDB_EP_CARD_RE.lastIndex = 0;
        while ((m = TMDB_EP_CARD_RE.exec(r.html))) {
          const ep = parseInt(m[1], 10);
          const img = m[2].match(TMDB_STILL_RE);
          if (ep && img && !map[ep]) map[ep] = img[1];
        }
        if (Object.keys(map).length) stills[s.num] = map;
      } catch (e) { /* non-fatal */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return stills;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
}

module.exports = { fetch, sleep, parseCards, parseRelated, parseDetails, getList, getSearch, getDetail, getEpisodeStills, BASE };