#!/bin/bash
# sweep2.sh — sweep embed candidates for CineHall
# Placeholders: {M}=movie tmdb, {T}=movie tt, {TM}=tv tmdb, {TT}=tv tt, {s},{e}=s01/e01 style
# Verdict: LIVE if body mentions m3u8/video/player/source/iframe; PARK if for-sale; SHELL if plain page
UA='Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
MOV_TMDB=27205; MOV_TT=tt1375666; TV_TMDB=1396; TV_TT=tt0903747
S=1; E=1

# name|movie-url|tv-url (empty tv = movie-style only)
LIST=(
"2embed.org|https://2embed.org/embed/{M}|https://2embed.org/embedtv/{M}-{s}-{e}"
"2embed.net|https://2embed.net/embed/{M}|https://2embed.net/embedtv/{M}-{s}-{e}"
"2embed.si|https://2embed.si/embed/{M}|https://2embed.si/embedtv/{M}-{s}-{e}"
"2embed.site|https://2embed.site/embed/{M}|https://2embed.site/embedtv/{M}-{s}-{e}"
"vidsrc.watch|https://vidsrc.watch/embed/movie/{M}|https://vidsrc.watch/embed/tv/{M}/{s}/{e}"
"vidsrc.ink|https://vidsrc.ink/embed/movie/{M}|https://vidsrc.ink/embed/tv/{M}/{s}/{e}"
"vidsrc.xyz|https://vidsrc.xyz/embed/movie/{M}|https://vidsrc.xyz/embed/tv/{M}/{s}/{e}"
"vidsrc.pm|https://vidsrc.pm/embed/movie/{M}|https://vidsrc.pm/embed/tv/{M}/{s}/{e}"
"vidsrc.icu|https://vidsrc.icu/embed/movie/{M}|https://vidsrc.icu/embed/tv/{M}/{s}/{e}"
"vidsrc.ez|https://vidsrc.ez/embed/movie/{M}|https://vidsrc.ez/embed/tv/{M}/{s}/{e}"
"vidsrc.biz|https://vidsrc.biz/embed/movie/{M}|https://vidsrc.biz/embed/tv/{M}/{s}/{e}"
"vidsrc.work|https://vidsrc.work/embed/movie/{M}|https://vidsrc.work/embed/tv/{M}/{s}/{e}"
"vsembed.ru|https://vsembed.ru/embed/movie/{T}|https://vsembed.ru/embed/tv/{T}/{s}/{e}"
"multiembed.mov|https://multiembed.mov/direct/movie/{M}|https://multiembed.mov/direct/tv/{M}/{s}/{e}"
"multiembed.xyz|https://multiembed.xyz/direct/movie/{M}|https://multiembed.xyz/direct/tv/{M}/{s}/{e}"
"autoembed.cc|https://autoembed.cc/embed/movie/{M}|https://autoembed.cc/embed/tv/{M}/{s}/{e}"
"autoembed.one|https://autoembed.one/embed/movie/{M}|https://autoembed.one/embed/tv/{M}/{s}/{e}"
"embed.su|https://embed.su/embed/movie/{M}|https://embed.su/embed/tv/{M}/{s}/{e}"
"vidbinge.dev|https://vidbinge.dev/embed/movie/{M}|https://vidbinge.dev/embed/tv/{M}/{s}/{e}"
"vidbinge.top|https://vidbinge.top/embed/movie/{M}|https://vidbinge.top/embed/tv/{M}/{s}/{e}"
"moviesapi.club|https://moviesapi.club/movie/{M}|https://moviesapi.club/tv/{M}-{s}-{e}"
"smashystream|https://embed.smashystream.com/playere.php?tmdb={M}|https://embed.smashystream.com/playere.php?tmdb={M}&s={s}&e={e}"
"gdriveplayer.to|https://gdriveplayer.to/embed2.php?id={T}|https://gdriveplayer.to/embed.php?id={T}&s={s}&e={e}"
"vidsrc.lala|https://vidsrc.lala/embed/movie/{M}|https://vidsrc.lala/embed/tv/{M}/{s}/{e}"
"vidsrc.vip|https://vidsrc.vip/embed/movie/{M}|https://vidsrc.vip/embed/tv/{M}/{s}/{e}"
"flvidsrc|https://flvidsrc.xyz/embed/movie/{M}|https://flvidsrc.xyz/embed/tv/{M}/{s}/{e}"
"vwid|https://vwid?PLACEHOLDER"
"vidsrc.zone|https://vidsrc.zone/embed/movie/{M}|https://vidsrc.zone/embed/tv/{M}/{s}/{e}"
)

probe() {
  local n="$1" u="$2" bod code low
  u=${u//\{M\}/$MOV_TMDB}; u=${u//\{T\}/$MOV_TT}; u=${u//\{TM\}/$TV_TMDB}; u=${u//\{TT\}/$TV_T}
  [ "$u" = "https://vwid?PLACEHOLDER" ] && return
  bod=$(curl -s --max-time 12 -A "$UA" -r 0-30000 "$u" 2>/dev/null | head -c 30000)
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 -A "$UA" -L "$u" 2>/dev/null)
  if [ -z "$bod" ] || [ "$code" = "000" ]; then echo "-- $n DEAD ($code)"; return; fi
  local low=$(printf '%s' "$bod" | tr 'A-Z' 'a-z')
  if echo "$low" | grep -qE 'for sale|buy this domain|domain is parked'; then echo "PARK $n ($code)"
  elif echo "$low" | grep -qE 'm3u8|<video|jwplayer|videojs|\bplayer\.js|video_url|playlist|\bsrc\s*[:=]|iframe'; then echo "LIVE $n ($code)"
  else echo "SHELL $n ($code) — $(printf '%s' "$low" | head -c 120 | tr '\n' ' ')"; fi
}

for row in "${LIST[@]}"; do
  name="${row%%|*}"; rest="${row#*|}"
  murl="${rest%%|*}"; turl="${rest#*|}"
  probe "$name (movie)" "$murl"
  [ -n "$turl" ] && probe "$name (tv)" "$turl"
done