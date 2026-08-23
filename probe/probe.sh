#!/bin/bash
# probe.sh — probe streaming-source APIs quickly (from CineHall dir)
# usage: ./probe.sh "label" "url" [maxbytes]
L="$1"; U="$2"; M="${3:-0}"
code=$(curl -sS -m 8 -A "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36" -o /tmp/p.out -w "%{http_code}|%{size_download}|%{content_type}" "$U" 2>/dev/null)
if [ "$M" -gt 0 ]; then head -c $M /tmp/p.out | tr '\n' ' ' | head -c 200; echo; fi
echo "$L => $code"
