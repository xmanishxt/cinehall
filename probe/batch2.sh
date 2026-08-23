#!/bin/bash
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
M=tt1375666
T=tt0903747
pand() {
  curl -sS -m 9 -A "$UA" -L -o probe/_o -w "%{http_code}|%{size_download}|%{content_type}" "$2" 2>/dev/null > probe/_s
  local code; code=$(cat probe/_s)
  if [ -s probe/_o ]; then local body; body=$(head -c 120 probe/_o | tr '\n' ' '); else local body="(empty)"; fi
  echo "== $1"; echo "   -> $code"; echo "   $body"; echo
}
grp() { grep -o "$2" probe/_o | head -3 | sed 's/^/   >> /'; }
pand() {
  local L="$1" U="$2"
  curl -sS -m 9 -A "$UA" -L -o probe/_o -w "%{http_code}|%{size_download}|%{content_type}" "$U" 2>/dev/null > probe/_s
  local code; code=$(cat probe/_s)
  echo "== $L"; echo "   -> $code"; grp "$L" 'src=\"[^\"]*|https://[a-z0-9.:/_-]+\.(m3u8|mp4)[^\"<]*|location.href=[^;]*'; echo
}
pand "N01 2embed api (json)"      "https://www.2embed.cc/api?imdb=$M"
pand "N02 2embed api tv"          "https://www.2embed.cc/api?imdb=$T&s=1&e=1"
pand "N03 mvapi tmdb-id"          "https://www.mvapi.com/movie/27205"
pand "N04 mvapi root"             "https://www.mvapi.com/"
pand "N05 gdriveplayer tv"        "https://database.gdriveplayer.us/player.php?imdb=$T&type=tv&season=1&episode=1"
pand "N06 gdriveplayer movie src" "https://database.gdriveplayer.us/player.php?imdb=$M"
grp  "N06 srcs" 'https://[a-z0-9.:/_-]+'
pand "N07 gdrive stream direct"   "https://database.gdriveplayer.us/stream.php?imdb=$M"
pand "N08 vidsrc.to body"         "https://vidsrc.to/embed/movie/$M"
pand "N09 vidsrc.me body"         "https://vidsrc.me/embed/movie/$M"
pand "N10 vidsrc2.to"             "https://vidsrc2.to/embed/movie/$M"
pand "N11 vidsrc.gg"              "https://vidsrc.gg/embed/movie/$M"
pand "N12 vidsrc.su"              "https://vidsrc.su/embed/movie/$M"
pand "N13 vidsrc.fan"             "https://vidsrc.fan/embed/movie/$M"
pand "N14 watchembed"             "https://watch.embedz.xyz/embed/movie/$M"
pand "N15 v2embed"                "https://v2embed.com/embed/movie/$M"
pand "N16 efastplayer"            "https://www.efastplayer.com/embed/$M"
pand "N17 videocdn"               "https://video.videocdn.tv/embed/movie/$M"
pand "N18 sflix"                  "https://sflix.se/embed/movie/$M"
pand "N19 animepahe api"          "https://animepahe.ru/api?m=search&q=naruto"
pand "N20 gogoembed"              "https://gogoanimeembed.net/"
pand "N21 zoro api"               "https://zoro.to/api/v2/search?keyword=naruto"
pand "N22 2embed net"             "https://www.2embed.net/embed/$M"
pand "N23 cdn streaming"          "https://cdn.streaming-player.com/embed/$M"
pand "N24 lookmovie"              "https://lookmovie.xyz/"
pand "N25 movieunleashed"         "https://movieunleashed.xyz/"
