const fs = require('fs');
const src = fs.readFileSync('/data/data/com.termux/files/home/work/CineHall/mainmini.js', 'utf8');

const m = src.match(/_0x4d02cd=\['(.*?)'\];a0_0x2f56=function/);
if (!m) { console.log('ARRAY NOT FOUND'); process.exit(1); }
const arr = m[1].split("','");

const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
function decode(str) {
  let out = '';
  for (let i = 0, code, chr, enc = 0; i < str.length; ) {
    chr = str.charAt(i++);
    if (~(chr = charset.indexOf(chr))) {
      code = enc % 4 ? code * 64 + chr : chr;
      if (enc++ % 4) out += String.fromCharCode(255 & (code >> (-2 * enc & 6)));
    }
  }
  let d = '';
  for (let j = 0; j < out.length; j++) d += '%' + ('00' + out.charCodeAt(j).toString(16)).slice(-2);
  try { return decodeURIComponent(d); } catch (e) { return '[ERR]' + d.slice(0, 80); }
}

console.log('Total entries:', arr.length);
arr.forEach((s, i) => console.log(i + '\t0x' + (0x18a + i).toString(16) + '\t' + JSON.stringify(decode(s))));