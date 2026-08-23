#!/data/data/com.termux/files/usr/bin/bash
# CineHall launcher — start/restart the streaming server
cd "$(dirname "$0")" || exit 1

PID=$(pgrep -f 'node ./server.js' | head -1)
if [ -n "$PID" ]; then
  echo "CineHall already running (PID $PID) → http://localhost:3000"
  exit 0
fi

nohup node ./server.js > boot.log 2>&1 &
sleep 1
echo "CineHall started → http://localhost:3000"
echo "Logs: boot.log  |  Stop: kill $(pgrep -f 'node ./server\.js' | head -1)"