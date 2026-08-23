'use strict';
// torrent.js — IN-APP torrent streaming engine for CineHall.
// No external player needed anymore: aria2c downloads the chosen release
// sequentially, then PLAYBACK streams from the partial file through an
// ffmpeg remux (-c copy = no re-encode) or direct Range serving, so the
// browser <video> plays it directly. Dual/multi-audio MKVs get their
// selected language track mapped in ffmpeg — that's the in-app "language
// switch" the watch page needs.
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, 'data', 'torrents');
fs.mkdirSync(ROOT, { recursive: true });
const VIDEOS = ['.mp4', '.mkv', '.m4v', '.webm', '.avi', '.mov', '.ts', '.flv', '.wmv'];

// ---------- language helpers ----------
const LANG_FULL = { hin: 'Hindi', eng: 'English', tam: 'Tamil', tel: 'Telugu', pan: 'Punjabi', kan: 'Kannada', mal: 'Malayalam', ben: 'Bengali', mar: 'Marathi', guj: 'Gujarati', urd: 'Urdu', nep: 'Nepali', sin: 'Sinhala', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', spa: 'Spanish', fra: 'French', deu: 'German', ita: 'Italian', rus: 'Russian', ara: 'Arabic', tur: 'Turkish', por: 'Portuguese', tha: 'Thai', vie: 'Vietnamese', ind: 'Indonesian', fil: 'Filipino', tgl: 'Filipino', ukr: 'Ukrainian', nld: 'Dutch', pol: 'Polish', swe: 'Swedish', ell: 'Greek', fas: 'Persian', dan: 'Danish', nor: 'Norwegian', fin: 'Finnish', ces: 'Czech', hun: 'Hungarian', ron: 'Romanian', msa: 'Malay', nob: 'Norwegian' };
// full name (any case) → 639-2 code
const NAME2 = { hindi: 'hin', english: 'eng', tamil: 'tam', telugu: 'tel', punjabi: 'pan', kannada: 'kan', malayalam: 'mal', bengali: 'ben', marathi: 'mar', gujarati: 'guj', urdu: 'urd', nepali: 'nep', sinhala: 'sin', japanese: 'jpn', korean: 'kor', chinese: 'chi', mandarin: 'chi', spanish: 'spa', french: 'fra', german: 'deu', italian: 'ita', russian: 'rus', arabic: 'ara', turkish: 'tur', portuguese: 'por', thai: 'tha', vietnamese: 'vie', indonesian: 'ind', filipino: 'fil', tagalog: 'fil', ukrainian: 'ukr', dutch: 'nld', polish: 'pol', swedish: 'swe', greek: 'ell', persian: 'fas', danish: 'dan', norwegian: 'nor', finnish: 'fin', czech: 'ces', hungarian: 'hun', romanian: 'ron', malay: 'msa' };
// short code (any case) → 639-2 code
const SHORT3 = { HI: 'hin', HINDI: 'hin', EN: 'eng', ENG: 'eng', TA: 'tam', TAM: 'tam', TEL: 'tel', TELU: 'tel', PA: 'pan', PAN: 'pan', PUN: 'pan', KN: 'kan', KAN: 'kan', ML: 'mal', MAL: 'mal', BN: 'ben', BEN: 'ben', MR: 'mar', MAR: 'mar', GU: 'guj', GUJ: 'guj', UR: 'urd', URD: 'urd', NE: 'nep', NEP: 'nep', SI: 'sin', SIN: 'sin', JA: 'jpn', JPN: 'jpn', JAP: 'jpn', KO: 'kor', KOR: 'kor', ZH: 'chi', CHI: 'chi', CHS: 'chi', CHT: 'chi', ES: 'spa', SPA: 'spa', FR: 'fra', FRA: 'fra', FRE: 'fra', DE: 'deu', DEU: 'deu', GER: 'deu', IT: 'ita', ITA: 'ita', RU: 'rus', RUS: 'rus', AR: 'ara', ARA: 'ara', TR: 'tur', TUR: 'tur', PT: 'por', POR: 'por', TH: 'tha', THA: 'tha', VI: 'vie', VIE: 'vie', ID: 'ind', IND: 'ind', FIL: 'fil', UK: 'ukr', UKR: 'ukr', NL: 'nld', NLD: 'nld', PL: 'pol', POL: 'pol', SE: 'swe', SV: 'swe', EL: 'ell', GRE: 'ell', FA: 'fas', DA: 'dan', DAN: 'dan', NO: 'nob', NOR: 'nob', FI: 'fin', FIN: 'fin', CZ: 'ces', HU: 'hun', RO: 'ron', MS: 'msa' };
const CODE3_FULL = Object.fromEntries(Object.entries(LANG_FULL).map(([c, l]) => [l.toLowerCase(), c]));

function labelOf(code) { return LANG_FULL[code] || code.toUpperCase(); }

// 'Jawan (2023) [1080p] [HIN-ENG-TAM] (Hindi + English) Dual Audio'
// → { langs:[{code:'hin',label:'Hindi'},…], dual, multi }
function parseLangs(title) {
  const up = ' ' + String(title || '').toUpperCase() + ' ';
  const out = {};
  const flags = { dual: false, multi: false };
  if (/\bDUAL\s*AUDIO\b/.test(up)) flags.dual = true;
  if (/\bMULTI\s*AUDIO\b/.test(up)) flags.multi = true;
  for (const n of Object.keys(NAME2)) {
    if (new RegExp(`\\b${n.toUpperCase()}\\b`).test(up)) out[NAME2[n]] = true;
  }
  if (Object.keys(out).length < 2) { // short-code combos: HIN-ENG, ENG+HIN, [HI|TA]…
    const comboRe = /\b[A-Z]{2,5}(?:[+\/\-&|]\s*[A-Z]{2,5}){1,5}\b/g;
    let m;
    while ((m = comboRe.exec(up))) {
      for (const part of m[0].split(/[+\/\-&|]\s*/)) {
        const c = SHORT3[part.trim().toUpperCase()];
        if (c) out[c] = true;
      }
    }
  }
  if (Object.keys(out).length === 0 && flags.dual) {
    // "Dual Audio" with no names — keep empty; frontend shows "Dual Audio" chip
  }
  const langs = Object.keys(out).map((c) => ({ code: c, label: labelOf(c) }));
  return { langs, ...flags };
}

// pick audio-track index for a requested language
function pickTrack(tracks, code) {
  if (!tracks || !tracks.length) return -1;
  if (code) {
    const want = CODE3_FULL[code] || code; // 'hi' → 'hin'
    let hit = tracks.findIndex((t) => t.lang === want || (t.title || '').toLowerCase().includes(want));
    if (hit < 0) hit = tracks.findIndex((t) => (t.title || '').toLowerCase().includes((LANG_FULL[want] || '').toLowerCase()));
    if (hit >= 0) return hit;
  }
  // default: Hindi track if present (typical dual-audio ordering has it second)
  const h = tracks.findIndex((t) => t.lang === 'hin' || /hindi/i.test(t.title || ''));
  return h >= 0 ? h : 0;
}

// ---------- per-hash download state ----------
const state = new Map();
const dirOf = (hash) => path.join(ROOT, hash);

function findMedia(hash) {
  const dir = dirOf(hash);
  let best = null;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  for (const e of entries) {
    if (e.endsWith('.aria2')) continue;
    const fp = path.join(dir, e);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (st.isFile() && VIDEOS.includes(path.extname(e).toLowerCase())) {
      if (!best || st.size > best.size) best = { file: fp, size: st.size };
    }
  }
  return best;
}

function startDownload(infoHash, magnet, fileIdx) {
  const key = infoHash.toLowerCase();
  const ex = state.get(key);
  if (ex) return ex;
  const dir = dirOf(key);
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.createWriteStream(path.join(dir, 'aria2.log'));
  const args = [
    '--dir=' + dir, '--seed-time=0', '--max-upload-limit=1K',
    '--file-allocation=none', '--stream-piece-selector=inorder',
    '--allow-overwrite=true', '--auto-file-renaming=false',
    '--summary-interval=0', '--console-log-level=warn', '--quiet=true',
  ];
  if (fileIdx) args.push('--select-file=' + fileIdx);
  args.push(magnet);
  const proc = spawn('aria2c', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const s = { key, dir, log, proc, file: null, total: 0, startedAt: Date.now(), done: false, err: null };
  proc.stderr.on('data', (d) => log.write(d));
  proc.on('exit', (code) => { s.proc = null; s.done = code === 0; if (code !== 0) s.err = 'aria2 exit ' + code; log.end(); });
  proc.on('error', (e) => { s.proc = null; s.err = e.message; log.end(); });
  state.set(key, s);
  return s;
}

function progress(hash) {
  const s = state.get(hash.toLowerCase());
  if (!s) return null;
  const media = findMedia(hash);
  const downloaded = media ? media.size : 0;
  return {
    ok: true,
    status: s.done ? 'ready' : (s.proc ? 'downloading' : (s.err ? 'error' : 'idle')),
    downloaded,
    total: s.total || null,
    pct: s.total ? Math.min(100, Math.round(downloaded / s.total * 100)) : null,
    file: media ? media.file : null,
    err: s.err || null,
  };
}

// ---------- ffprobe audio tracks ----------
function probeTracks(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index:stream_tags=language,title,handler_name',
      '-of', 'json', file], { maxBuffer: 4 * 1024 * 1024, timeout: 20000 },
    (err, out) => {
      if (err || !out) return resolve(null);
      try {
        const j = JSON.parse(out);
        resolve((j.streams || []).map((t) => ({
          idx: t.index,
          lang: ((t.tags || {}).language || '').toLowerCase() || null,
          title: (t.tags || {}).title || null,
        })));
      } catch { resolve(null); }
    });
  });
}

// ---------- ffmpeg remux → fragmented mp4 (browser-playable, partial file ok) ----------
function startRemux(file, trackIdx) {
  const args = [
    '-v', 'error', '-nostdin',
    '-fflags', '+genpts+discardcorrupt',
    '-i', file,
    '-map', '0:v:0',
    trackIdx >= 0 ? '-map' : null,
  ];
  if (trackIdx >= 0) args.push(`0:a:${trackIdx}`);
  else args.push('-map', '0:a:0?');
  args.push(
    '-map_metadata', '-1',
    '-c:v', 'copy', '-c:a', 'copy',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  );
  return spawn('ffmpeg', args.filter(Boolean), { stdio: ['ignore', 'pipe', 'pipe'] });
}

// is the file's moov atom reachable from the front (partial mp4 playable)?
function headReadable(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-read_intervals', '%+#1', '-show_entries', 'format=duration', '-of', 'json', file],
      { timeout: 15000 }, (err) => resolve(!err));
  });
}

// ---------- old download cleanup (disk hygiene) ----------
function cleanup() {
  let removed = 0;
  try {
    for (const e of fs.readdirSync(ROOT)) {
      const fp = path.join(ROOT, e);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (st.isDirectory() && Date.now() - st.mtimeMs > 48 * 3600 * 1000) {
        fs.rmSync(fp, { recursive: true, force: true });
        state.delete(e.toLowerCase());
        removed++;
      }
    }
  } catch {}
  return removed;
}
setInterval(cleanup, 6 * 3600 * 1000).unref();
cleanup();

module.exports = { parseLangs, labelOf, pickTrack, startDownload, progress, probeTracks, findMedia, startRemux, headReadable, ROOT, state };