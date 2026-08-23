// ctx.js <file> <key> [n] — print +/-400 chars around first n occurrences of key
const fs = require('fs');
const [file, key, kn] = process.argv.slice(2);
const n = parseInt(kn || '3', 10);
const js = fs.readFileSync(file, 'utf8');
let i = 0, count = 0;
while ((i = js.indexOf(key, i)) >= 0 && count < n) {
  const s = Math.max(0, i - 550), e = Math.min(js.length, i + key.length + 550);
  console.log(`### ${key} @ ${i}\n${js.slice(s, e).replace(/\n/g, ' ')}\n`);
  i += key.length; count++;
}