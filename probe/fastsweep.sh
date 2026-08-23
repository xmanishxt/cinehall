#!/bin/bash
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
sweep() {
  local code size ct
  code=$(curl -sS -m 5 -A "$UA" -o probe/_x -w "%{http_code}" "$1" 2>/dev/null)
  size=$(stat -c%s probe/_x 2>/dev/null || echo 0)
  ct=$(head -c 1 probe/_x >/dev/null 2>&1; file -b probe/_x 2>/dev/null | cut -c1-30)
  echo "$code|$size|$1"
}
export -f sweep; export UA
cat <<'EOF' | xargs -P 10 -I{} bash -c 'sweep {}' 2>/dev/null
https://vidsrc.nz/embed/movie/tt1375666
https://vidsrc.io/embed/movie/tt1375666
https://vidsrc.st/
https://vidsrc.nl/embed/movie/tt1375666
https://vidsrc.work/embed/movie/tt1375666
https://vidsrc.bz/embed/movie/tt1375666
https://embedwish.com/
https://embed.collide.co/embed/movie/27205
https://webyte.xyz/movie/tt1375666
https://moviesapi.to/movie/tt1375666
https://vidembed.cc/
https://www.vidbinge.dev/embed/movie/tt1375666
https://2embed.biz/embed/tt1375666
https://2embed.ai/embed/tt1375666
https://embed.cc/embed/tt1375666
https://www.cinestarhd.ru/
https://player.smashystream.com/playerc.php
https://embed.smashystream.com/playerc.php
https://www.goblinlist.xyz/embed/movie/tt1375666
https://embed.lifeserver.xyz/embed/movie/tt1375666
https://goplayer.one/embed/tt1375666
https://embed.timehave.xyz/movie/tt1375666
