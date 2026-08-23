#!/data/data/com.termux/files/usr/bin/bash
# CineHall Cloudflare deploy — one-shot: KV + catalog + worker+assets + cache rules
# Pure REST API via python3 (wrangler/workerd has no Android build — cannot run here).
# Usage: CF_TOKEN=<api-token> [CF_ACCOUNT_ID=<id>] bash deploy.sh [--skip-catalog] [--cache-only]
set -e
cd "$(dirname "$0")"
[ -z "$CF_TOKEN" ] && { echo "❌ CF_TOKEN env var chahiye (SETUP.md dekho)"; exit 1; }
exec python3 deploy.py "$@"