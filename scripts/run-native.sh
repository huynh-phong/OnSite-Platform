#!/usr/bin/env bash
# Runs the stack without Docker: both apps as plain Node processes against PostgreSQL 16 servers you
# already have on the ports in .env (5433 and 5434). For machines without Docker; compose is the normal way.
#
#   scripts/run-native.sh up      build, then start both apps
#   scripts/run-native.sh down    stop both apps
#   scripts/run-native.sh reset [S1|S2]
#
# Logs go to .native/ (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"
state="$root/.native"
mkdir -p "$state"

load_env() {
  set -a; . ./.env; set +a
  # The value in .env is the container address.
  export SIMULATOR_BASE_URL="http://localhost:5000"
  export LOG_LEVEL="${LOG_LEVEL:-info}"
}

stop_one() {
  local log="$state/$1.log"
  [ -f "$log" ] || return 0
  # The app logs its real process id. In Git Bash, $! would be a different number from the Windows one.
  local pid
  pid="$(grep -o '"pid":[0-9]*' "$log" | head -1 | cut -d: -f2 || true)"
  [ -n "$pid" ] || return 0
  if command -v taskkill >/dev/null 2>&1; then
    taskkill //F //PID "$pid" >/dev/null 2>&1 || true
  else
    kill "$pid" 2>/dev/null || true
  fi
}

wait_for() {
  for _ in $(seq 1 60); do
    curl -fsS "$1" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "Timed out waiting for $1" >&2
  return 1
}

case "${1:-}" in
  up)
    load_env
    (cd apps/sweden-simulator && npm run --silent build)
    (cd apps/onsite-local-se && npm run --silent build)
    (cd apps/sweden-simulator && PORT=5000 exec node dist/server.js >"$state/simulator.log" 2>&1 </dev/null) &
    wait_for http://localhost:5000/health
    (cd apps/onsite-local-se && PORT=4000 exec node dist/server.js >"$state/local-se.log" 2>&1 </dev/null) &
    wait_for http://localhost:4000/api/v1/health
    echo "Stack is up. If the databases are empty: scripts/run-native.sh reset"
    ;;
  down)
    stop_one local-se
    stop_one simulator
    echo "Stack stopped."
    ;;
  reset)
    load_env
    ONSITE_NATIVE=1 scripts/reset-demo.sh "${2:-S1}"
    ;;
  *)
    echo "Usage: scripts/run-native.sh up|down|reset [S1|S2]" >&2
    exit 2
    ;;
esac
