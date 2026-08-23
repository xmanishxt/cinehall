'use strict';
// fuzzy.js — typo-tolerant title matching for CineHall search.
// "spaderman" / "spedar man" must resolve to "Spider-Man". Strategy:
//   norm()    -> lowercase, non-alphanumerics to spaces, trim
//   dl()      -> Damerau-Levenshtein distance (adjacent transpositions count 1)
//   sim()     -> 1 - dist/maxLen
//   tokenSim()-> greedy alignment when query/title have multiple words
//   score()   -> max(full-string, token) + small prefix bonus (typos keep the
//                first letters intact, so a matching 3-char prefix is a strong
//                signal — "spaderman" vs "spider-man")
// fuzzyMatch uses a cheap first-token pre-filter so the score pass only runs
// on plausible candidates (the catalog can be several thousand titles).

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Damerau-Levenshtein: insertion/deletion/substitution/transposition = 1
function dl(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev2 = new Uint16Array(n + 1);
  let prev = new Uint16Array(n + 1);
  let cur = new Uint16Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1); // transposition
      }
      cur[j] = v;
    }
    // rotate rows: prev2 <- prev, prev <- cur, cur <- old prev2 (reused)
    const t = prev2; prev2 = prev; prev = cur; cur = t;
  }
  return prev[n];
}

function sim(a, b) {
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  return 1 - dl(a, b) / Math.max(la, lb);
}

// multi-word: align each query token to its best unused candidate token
function tokenSim(q, key) {
  const qt = q.split(' ').filter(Boolean);
  const kt = key.split(' ').filter(Boolean);
  if (!qt.length || !kt.length) return 0;
  if (qt.length === 1 && kt.length === 1) return sim(qt[0], kt[0]);
  const used = new Array(kt.length).fill(false);
  let total = 0;
  for (const t of qt) {
    let best = -1, bi = -1;
    for (let j = 0; j < kt.length; j++) {
      if (used[j]) continue;
      const s = sim(t, kt[j]);
      if (s > best) { best = s; bi = j; }
    }
    if (bi >= 0) { used[bi] = true; total += best; }
  }
  return total / qt.length;
}

function score(q, key) {
  let v = Math.max(sim(q, key), tokenSim(q, key));
  const q3 = q.slice(0, 3), k3 = key.slice(0, 3);
  if (q3 && k3 && q3 === k3) v += 0.08; // matching prefix: likely a typo
  return Math.min(1, v);
}

// items: [{ title, ... }] — returns the matching item objects, most similar first
function fuzzyMatch(q, items, opts = {}) {
  const { limit = 8, minScore = 0.55, minQueryLen = 4 } = opts;
  const nq = norm(q);
  if (nq.length < minQueryLen) return [];
  const q0 = String(nq.split(' ')[0] || '');
  const scored = [];
  for (const it of items) {
    const key = norm(it.title);
    if (!key) continue;
    // cheap pre-filter: query's first token must resemble the title's first
    // token (typos don't change the leading word), or share a 4-char chunk
    if (q0.length >= 4) {
      const k0 = String(key.split(' ')[0] || '');
      if (sim(q0, k0) < 0.45 && !key.includes(q0.slice(0, 4))) continue;
    }
    const s = score(nq, key);
    if (s >= minScore) scored.push({ item: it, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title));
  return scored.slice(0, limit).map((x) => x.item);
}

module.exports = { norm, dl, sim, tokenSim, score, fuzzyMatch };