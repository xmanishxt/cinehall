#!/bin/bash
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
M=tt1375666; T=tt0903747
doc() {
  curl -sS -m 12 -A "$UA" -L -o "probe/docs/$1" -w "%{http_code}|%{size_download}" "$2" >/dev/null 2>&1
  echo "doc $1 ($(stat -c%s probe/docs/$1 2>/dev/null || echo 0) bytes)"
}
doc gdrive-movie "https://database.gdriveplayer.us/player.php?imdb=$M"
doc gdrive-tv    "https://database.gdriveplayer.us/player.php?imdb=$T&type=tv&season=1&episode=1"
doc vidsrc-su    "https://vidsrc.su/embed/movie/$M"
doc vidsrc-to    "https://vidsrc.to/embed/movie/$M"
doc vidsrc-me    "https://vidsrc.me/embed/movie/$M"
doc twembed-api  "https://www.2embed.cc/api?imdb=$M"
doc animepahe    "https://animepahe.ru/api?m=search&q=naruto"
pand() {
  curl -sS -m 9 -A "$UA" -L -o probe/_o -w "%{http_code}|%{size_download}|%{content_type}" "$2" 2>/dev/null > probe/_s
  echo "== $1 => $(cat probe/_s)"
}
pand "O1 vidsrc.su tv"      "https://vidsrc.su/embed/tv/$T/1/1"
pand "O2 vidlink movie"     "https://vidlink.pro/embed/movie/27205"
pand "O3 vidlink tv"        "https://vidlink.pro/embed/tv/1396/1/1"
pand "O4 membed"            "https://membed.net/stream/tt1375666-1-1"
pand "O5 moviesapi movie"   "https://moviesapi.club/tt1375666"
pand "O6 moviesapi tv"      "https://moviesapi.club/tv/tt0903747-1-1"
pand "O7 embedder.best"     "https://embedder.best/e/tt1375666"
pand "O8 embed.tape"        "https://embed.tape.services/..."
pand "O9 123moviesx"        "https://123moviesx.online/watch/tt1375666"
pand "O10 rektplayer"       "https://rektplayer.xyz/embed/movie/tt1375666"
