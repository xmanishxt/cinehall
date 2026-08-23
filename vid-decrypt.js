'use strict';
// VidEasy sources API decryptor — replication of obfuscated player logic (chunk 8351)
// Usage: node vid-decrypt.js <payloadFile> [b35ebba4Hex]
const fs = require('fs');

const f = [1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580];
const h = [109,118,109,49]; // "mvm1"
const bFn = e => (e*(e+1)&1)===0;
const IFn = e => (e*(e+1)&1)===1;

function w(e){e>>>=0; e^=e>>>16; e=Math.imul(e,2246822507)>>>0; e^=e>>>13; e=Math.imul(e,3266489909)>>>0; return (e^=e>>>16)>>>0;}
function v(e,t){e>>>=0; t&=31; return t===0 ? e>>>0 : ((e<<t)|(e>>>(32-t)))>>>0;}

function ks(seed, b35){
  if (IFn(seed.length)) {
    // RC4 KSA
    const S = new Array(256);
    for (let i=0;i<256;i++) S[i]=i;
    let j=0;
    for (let i=0;i<256;i++){
      j=(j+S[i]+seed.charCodeAt(i%seed.length))&255;
      const r=S[i]; S[i]=S[j]; S[j]=r;
    }
    let acc=1732584193;
    for (let i=0;i<seed.length;i++) acc = v((acc ^ Math.imul(seed.charCodeAt(i), f[15&i]))>>>0, 5);
    return {S, acc: w(acc)>>>0};
  }
  // even-length seed: 61-entry shuffled table
  const S = new Array(61);
  let a = w((()=>{let t=2166136261; for (let i=0;i<seed.length;i++) t=Math.imul(t^seed.charCodeAt(i),16777619)>>>0; return w(t);})(seed) ^ w((b35>>>0)^2654435769))>>>0;
  for (let e=0;e<8;e++){
    if (bFn(e)){
      const t = a % 61;
      a = v((a + 2654435769)>>>0, 7 + (7 & e));
      S[t] = (a ^ w(a)) >>> 0;
      a = w((a + t)>>>0);
    } else {
      S[e] = f[15 & e];
    }
  }
  return {S, acc: w(2779096485 ^ a)>>>0};
}

function keystream(seed, b35, n){
  const st = ks(seed, b35);
  const out = new Uint8Array(n);
  let counter = 0, e = 0;
  while (e < n){
    const nn = st.acc % 61;
    const i = 0 - Number(nn in st.S);
    const d = st.S[nn] >>> 0;
    const a = (d ^ Math.imul(2654435769, counter+1)>>>0)>>>0;
    let l = (((st.acc ^ a)>>>0) | ((st.acc & a & i)>>>0))>>>0;
    l = (v((l + st.acc)>>>0, 31 & nn) ^ v(st.acc, 31 & Math.imul(nn,7)))>>>0;
    st.acc = w((l + 2654435769)>>>0);
    st.S[nn] = st.acc >>> 0;
    const t = st.acc >>> 0;
    counter++;
    out[e++] = 255 & t;
    if (e < n) out[e++] = (t>>>8) & 255;
    if (e < n) out[e++] = (t>>>16) & 255;
    if (e < n) out[e++] = (t>>>24) & 255;
  }
  return out;
}

function decrypt(payloadB64url, seed, b35Hex){
  const b64 = payloadB64url.replace(/-/g,'+').replace(/_/g,'/');
  const r = new Uint8Array(Buffer.from(b64, 'base64'));
  const ksBytes = keystream(seed, b35Hex, r.length);
  for (let i=0;i<r.length;i++) r[i] ^= ksBytes[i];
  for (let i=0;i<h.length;i++) if (r[i] !== h[i]) throw new Error('decrypt failed: bad seed or tampered payload');
  return Buffer.from(r.subarray(h.length)).toString('utf8');
}

const file = process.argv[2];
const b35 = process.argv[3] || '0';
const payload = fs.readFileSync(file, 'utf8').trim();
const seed = process.argv[4];
if (!seed) { console.error('USAGE: node vid-decrypt.js <file> <b35hex> <seed>'); process.exit(1); }
try {
  const json = decrypt(payload, seed, b35);
  const parsed = JSON.parse(json);
  console.log(JSON.stringify(parsed, null, 2));
} catch (e) {
  console.error('DECRYPT ERROR:', e.message);
  process.exit(1);
}