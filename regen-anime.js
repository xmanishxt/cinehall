// regen-anime.js — one-off: re-run the genre gate over the stored anime catalog
// and rewrite data/catalog.json. Also warms the detail cache so the server's own
// rebuild (server.js buildAnime) becomes a cache-hit pass on next boot.
'use strict';
const fs = require('fs');
const path = require('path');
const { getDetail, sleep } = require('./scraper');

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');
const detailFile = (type, id) => path.join(CACHE_DIR, `detail-${type}-${id}.json`);

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

const isAnime = (d) => !d.genres || !d.genres.length || d.genres.some((g) => /anim/i.test(g));

(async () => {
  const cat = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const anime = cat.anime || [];
  console.log(`stored anime: ${anime.length}`);

  const kept = [];
  let dropped = 0, noGenre = 0, failed = 0;
  for (let i = 0; i < anime.length; i += 8) {
    const batch = anime.slice(i, i + 8);
    const details = await Promise.all(batch.map(async (it) => {
      const cached = readJSON(detailFile(it.type, it.id));
      if (cached && cached.ok) return cached;
      const r = await getDetail(it.type, it.id);
      if (r.ok) writeJSON(detailFile(it.type, it.id), r);
      return r;
    }));
    batch.forEach((it, idx) => {
      const d = details[idx];
      if (!d.ok) { failed++; kept.push(it); return; }
      if (!isAnime(d)) { dropped++; console.log('DROP:', it.title, '=>', (d.genres || []).join(',')); return; }
      if (!d.genres || !d.genres.length) noGenre++;
      kept.push({ ...it, year: d.year, rating: d.rating, ratingCount: d.ratingCount,
        desc: d.desc, genres: d.genres, imdb: d.imdb, duration: d.duration,
        backdrop: d.thumb || (it.poster || '').replace('/w500/', '/w1280/'),
        posterSm: (it.poster || '').replace('/w500/', '/w342/') });
    });
    if ((i / 8) % 4 === 0) console.log(`progress: ${i + batch.length}/${anime.length}`);
    await sleep(120);
  }

  cat.anime = kept;
  cat.animeTs = Date.now();
  writeJSON(CATALOG_FILE, cat);
  console.log(`DONE kept=${kept.length} dropped=${dropped} noGenreKept=${noGenre} fetchFailed=${failed}`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });