#!/data/data/com.termux/files/usr/bin/bash
# Atto Cuan di HP: jalankan loop di latar belakang (siklus 15 menit + digest 07:00 + heartbeat 08:00 WIB).
cd "$HOME/atto" || exit 1
termux-wake-lock 2>/dev/null
if [ -f loop.pid ] && kill -0 "$(cat loop.pid)" 2>/dev/null; then
  echo "sudah jalan, pid $(cat loop.pid)"
  exit 0
fi
nohup node sentinel.mjs loop >> loop.log 2>&1 &
echo $! > loop.pid
echo "started pid $(cat loop.pid), log: ~/atto/loop.log"
