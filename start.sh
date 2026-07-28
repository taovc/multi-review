#!/usr/bin/env bash
# Build the prod bundle and (re)start it on PORT (default 5332).
#   ./start.sh                 build, then start in foreground (Ctrl-C to stop)
#   ./start.sh --bg            build, then start in background (detached)
#   ./start.sh --no-build      skip build, just restart the last build
#   ./start.sh --no-build --bg skip build, restart in background
#   ./start.sh --host          listen on all interfaces (shorthand: --h)
#   ./start.sh stop            stop the running server
#   PORT=6000 ./start.sh       use a different port
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${PORT:-5332}"
HOST="${HOST:-127.0.0.1}"
LOG="data/server.log"
PIDFILE="data/server.pid"

BUILD=1
BG=0
CMD=start

usage() {
  cat <<'EOF'
Usage: ./start.sh [options] [stop]

Options:
  --host, --h   Listen on all interfaces (HOST=0.0.0.0)
  --bg, -d      Start in the background
  --no-build    Skip the build and use the existing bundle
  --help, -h    Show this help

Environment:
  HOST          Listen address (default: 127.0.0.1)
  PORT          Listen port (default: 5332)
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --bg|-d)    BG=1 ;;
    --host|--h) HOST=0.0.0.0 ;;
    --help|-h)  usage; exit 0 ;;
    stop)       CMD=stop ;;
    *) echo "unknown arg: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

stop_server() {
  local pids
  pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "==> stopping listener on :$PORT ($pids)"
    kill $pids 2>/dev/null || true
    sleep 1
  else
    echo "==> nothing listening on :$PORT"
  fi
  rm -f "$PIDFILE"
}

if [[ "$CMD" == stop ]]; then
  stop_server
  exit 0
fi

if [[ "$BUILD" == 1 ]]; then
  echo "==> building (pnpm build)"
  pnpm build
fi

stop_server  # free the port before (re)starting

if [[ "$BG" == 1 ]]; then
  echo "==> starting in background on http://$HOST:$PORT"
  nohup env PORT="$PORT" HOST="$HOST" node .output/server/index.mjs > "$LOG" 2>&1 < /dev/null &
  echo $! > "$PIDFILE"
  disown 2>/dev/null || true
  echo "    pid $(cat "$PIDFILE")   log $LOG"
  echo "    logs: tail -f $LOG      stop: ./start.sh stop"
else
  echo "==> starting on http://$HOST:$PORT  (Ctrl-C to stop)"
  exec env PORT="$PORT" HOST="$HOST" node .output/server/index.mjs
fi
