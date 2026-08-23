#!/usr/bin/env python3
"""CineHall Cloudflare deploy — pure REST API (no wrangler; workerd has no Android build).

Usage: CF_TOKEN=<api-token> [CF_ACCOUNT_ID=<id>] python3 deploy.py [--skip-catalog] [--cache-only]

Steps (all idempotent):
  1. KV namespace "cinehall-kv" (create or reuse; id cached in .kv_id)
  2. catalog.json snapshot -> KV key `catalog`
  3. worker.js + ../public/ assets -> Workers script `cinehall` (modules format)
  4. zone cache rules (THE CATCH) — only with --cache-only or when .zone_id exists
"""
import hashlib, json, mimetypes, os, sys, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
CF = "https://api.cloudflare.com/client/v4"
SCRIPT = "cinehall"
KV_TITLE = "cinehall-kv"
COMPAT_DATE = "2026-01-01"
ASSETS_DIR = os.path.join(HERE, "..", "public")
CATALOG = os.path.join(HERE, "..", "data", "catalog.json")

TOKEN = os.environ.get("CF_TOKEN", "").strip()
if not TOKEN:
    sys.exit("❌ CF_TOKEN env var chahiye (SETUP.md Step 2 dekho)")
ACCOUNT = os.environ.get("CF_ACCOUNT_ID", "").strip()


def api(method, path, body=None, raw=None, ctype=None, timeout=120):
    url = CF + path
    data = None
    headers = {"Authorization": "Bearer " + TOKEN}
    if raw is not None:
        data = raw
        headers["Content-Type"] = ctype
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


def get_account_id():
    global ACCOUNT
    if ACCOUNT:
        return ACCOUNT
    _, d = api("GET", "/accounts?per_page=1")
    if d.get("success") and d.get("result"):
        ACCOUNT = d["result"][0]["id"]
        print(f"→ account id (auto): {ACCOUNT}")
        return ACCOUNT
    sys.exit("❌ account id nahi mila — dashboard URL me jo 32-char id hai wo de do:\n"
             "   export CF_ACCOUNT_ID='<dash.cloudflare.com/<YAHAN KI ID>>'  (ya SETUP.md Step 2.5)")


def ensure_kv(aid):
    kv_id = ""
    f = os.path.join(HERE, ".kv_id")
    if os.path.exists(f):
        kv_id = open(f).read().strip()
    if not kv_id:
        _, d = api("GET", f"/accounts/{aid}/storage/kv/namespaces?per_page=50")
        for ns in (d.get("result") or []):
            if ns.get("title") == KV_TITLE:
                kv_id, _ = ns["id"], None
                break
    if not kv_id:
        st, d = api("POST", f"/accounts/{aid}/storage/kv/namespaces", {"title": KV_TITLE})
        if not d.get("success"):
            sys.exit(f"❌ KV create fail: {d}")
        kv_id = d["result"]["id"]
    open(f, "w").write(kv_id)
    print(f"KV namespace: {kv_id}")
    return kv_id


def upload_catalog(aid, nid):
    st, d = api("PUT", f"/accounts/{aid}/storage/kv/namespaces/{nid}/values/catalog",
                raw=open(CATALOG, "rb").read(), ctype="application/json")
    print(("catalog snapshot uploaded ✓" if d.get("success") else f"❌ catalog fail: {d}"))


def build_manifest():
    files = {}
    for name in sorted(os.listdir(ASSETS_DIR)):
        p = os.path.join(ASSETS_DIR, name)
        if os.path.isfile(p):
            b = open(p, "rb").read()
            files[name] = {"hash": hashlib.sha256(b).hexdigest(), "size": len(b)}
    return files


def upload_worker(aid, kv_id):
    """Modules-format multipart upload: metadata + worker.js + one part per asset file."""
    worker = open(os.path.join(HERE, "worker.js"), "rb").read()
    meta = {
        "main_module": "worker.js",
        "compatibility_date": COMPAT_DATE,
        "bindings": [{"type": "kv_namespace", "name": "KV", "namespace_id": kv_id}],
        "vars": {"WARM_KEY": "cinehall-warm-2026"},
        "assets": {"binding": "ASSETS", "run_worker_first": True,
                   "directory": "../public", "manifest": build_manifest()},
    }
    boundary = "----cinehall" + os.urandom(8).hex()
    parts = []
    def part(name, filename, ctype, data):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n".encode() + data + b"\r\n")
    part("metadata", "metadata", "application/json", json.dumps(meta).encode())
    part("worker.js", "worker.js", "application/javascript+module", worker)
    for fname in sorted(meta["assets"]["manifest"]):
        ctype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
        part(fname, fname, ctype, open(os.path.join(ASSETS_DIR, fname), "rb").read())
    body = b"".join(parts) + f"--{boundary}--\r\n".encode()
    headers = {"Authorization": "Bearer " + TOKEN, "Content-Type": f"multipart/form-data; boundary={boundary}"}
    req = urllib.request.Request(f"{CF}/accounts/{aid}/workers/scripts/{SCRIPT}", data=body, headers=headers, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            d = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")
        sys.exit(f"❌ upload fail HTTP {e.code}: {msg[:1200]}")
    if not d.get("success"):
        sys.exit(f"❌ upload fail: {json.dumps(d)[:1200]}")
    print("worker deployed ✓")


CACHE_RULES = {
    "rules": [
        {"expression": '(http.request.uri.path starts_with "/api/hls")',
         "description": "cinehall hls video — 30d edge cache",
         "action": "set_cache_settings",
         "action_parameters": {"cache": True,
                               "edge_ttl": {"mode": "respect_origin_header", "default": 2592000},
                               "serve_stale": {"serve_stale": True, "revalidate": True}}},
        {"expression": "(true)",
         "description": "cinehall everything — respect origin cache-control",
         "action": "set_cache_settings",
         "action_parameters": {"cache": True,
                               "edge_ttl": {"mode": "respect_origin_header", "default": 3600},
                               "serve_stale": {"serve_stale": True, "revalidate": True}}},
    ]
}


def set_cache_rules(aid):
    zone_id = open(os.path.join(HERE, ".zone_id")).read().strip() if os.path.exists(os.path.join(HERE, ".zone_id")) else ""
    if not zone_id:
        sys.exit("⚠️  zone nahi mila — testing domain Cloudflare me add karne ke baad: python3 deploy.py --cache-only\n"
                 "   (ya .zone_id file me zone id daal do)")
    st, d = api("PUT", f"/zones/{zone_id}/rulesets/http_request_cache_settings", CACHE_RULES)
    if d.get("success"):
        print(f"✅ cache rules live ({len(d.get('result', {}).get('rules', []))} rules) — THE CATCH active")
    else:
        print(f"❌ cache rules fail: {json.dumps(d.get('errors', d))[:600]}")


def zones_lookup():
    """Try to find zones the token can see; returns zone id or ''."""
    st, d = api("GET", "/zones?per_page=5")
    if d.get("success") and d.get("result"):
        for z in d["result"]:
            print(f"  zone found: {z['name']} ({z['id']})")
        open(os.path.join(HERE, ".zone_id"), "w").write(d["result"][0]["id"])
        return d["result"][0]["id"]
    return ""


def main():
    args = sys.argv[1:]
    skip_catalog = "--skip-catalog" in args
    cache_only = "--cache-only" in args
    aid = get_account_id()
    if not cache_only:
        nid = ensure_kv(aid)
        if not skip_catalog and os.path.exists(CATALOG):
            upload_catalog(aid, nid)
        elif not os.path.exists(CATALOG):
            print("⚠️  catalog.json nahi mila — worker pehli baar khud build karega (slow start)")
        upload_worker(aid, nid)
    if cache_only or os.path.exists(os.path.join(HERE, ".zone_id")) or zones_lookup():
        set_cache_rules(aid)
    print("✔ done. test: https://cinehall.<account>.workers.dev/api/health")
    print("  custom domain: deploy.sh me routes comment hatao ya CF dashboard me custom domain add karo")


if __name__ == "__main__":
    main()