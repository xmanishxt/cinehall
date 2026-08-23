# CineHall → Cloudflare (₹0, no card) — SETUP

## Step 1 — Cloudflare account (2 min)
1. https://dash.cloudflare.com/sign-up → **email + password** se account banao (free plan, **card nahi chahiye**)
2. Email verify karo

## Step 2 — API token (2 min)
1. dash.cloudflare.com → top-right profile icon → **My Profile** → **API Tokens** → **Create Token**
2. Template **"Edit Cloudflare Workers"** chuno, **+ Add More** → **Zone: Cache Rules** → Edit (zone: All zones)
3. **Create** → token copy karo (sirf ek baar dikhega — kisi file me save mat karo, bas ye wala variable):

```bash
export CF_TOKEN='paste-token-yahan'
```

## Step 3 — Deploy (5 min)
```bash
cd ~/work/CineHall/cf
bash deploy.sh
```
- Ye: KV namespace banaata hai, catalog.json ka snapshot upload karta hai, worker deploy karta hai
- End me **workers.dev URL** milega (catalog `cinehall.<account>.workers.dev`) — abhi se site live hai is pe!

## Step 4 — Cache rules (baad me, domain ke baad)
Domain kal kharid ke Cloudflare me add karne ke baad (nameserver update), doosri baar:
```bash
bash deploy.sh --cache-only
```
Ye 2 cache rules laga deta hai (THE CATCH — hits edge se serve hote hain, worker burn nahi hota).

## Step 5 — Custom domain (domain ke baad)
Domain ke nameservers Cloudflare pe move karne ke baad, **Worker dashboard me** (workers.dev → `cinehall` → Settings → Domains & Routes → Add) custom domain add karo — koई re-deploy nahi chahiye:
```
cinehall.xyz
```
(ya dashboard me zone → Workers Routes se `cinehall.xyz/*` route bhi chalega)

---

## Test endpoints (deploy ke baad)
- https://cinehall.<account>.workers.dev/api/health
- https://cinehall.<account>.workers.dev/api/search?q=inception
- https://cinehall.<account>.workers.dev/api/guard  (X-Guard-Key: WARM_KEY)
- https://cinehall.<account>.workers.dev/api/warm?quick=1  (X-Warm-Key: WARM_KEY)

## Local dev (Termux pe, bina deploy kiye — wrangler/workerd Android pe nahi chalta)
```bash
cd ~/work/CineHall/cf
node test-node.mjs          # 13 live tests (harness mocks caches/env/ctx)
node test-node.mjs health   # sirf ek filter karke bhi chala sakte ho
```

## Notes / drops
- `/api/mflix/*` aur `/api/torrent/*` edge pe nahi aate (child_process/ffmpeg chahiye) — wo features phone-server pe rah gaye
- Torrentio route bhi drop (curl dependency) — zaroorat ho toh bolo, plain-fetch version bana dunga
- vip.1x2.space Node TLS fingerprint block karta tha; CF ka outbound TLS alag hai — deploy ke baad `/api/stream` se verify karna, fail ho toh batao (fallback ready hai)