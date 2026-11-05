#!/usr/bin/env bash
# Runs the whole system without Docker: four plain Node processes, against PostgreSQL 16 servers you already
# have on the ports in .env (5433, 5434 and 5435). For machines without Docker; compose is the normal way.
#
#   scripts/run-native.sh up      build, then start everything
#   scripts/run-native.sh down    stop everything
#   scripts/run-native.sh reset [S1|S2]
#   ONSITE_LLM_PROVIDER=mock scripts/run-native.sh up     without calling the live AI provider
#
# Logs go to .native/ (git-ignored).
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"
state="$root/.native"
mkdir -p "$state"

load_env() {
  set -a; . ./.env; set +a
  # ONSITE_LLM_PROVIDER=mock runs without the live AI provider, whatever .env says.
  if [ -n "${ONSITE_LLM_PROVIDER:-}" ]; then export LLM_PROVIDER="$ONSITE_LLM_PROVIDER"; fi
  # The values in .env are the container addresses.
  export SIMULATOR_BASE_URL="http://localhost:5000"
  export LOCAL_SE_URL="http://localhost:4000"
  export CENTRAL_INGEST_URL="${CENTRAL_INGEST_URL:-http://localhost:6001/ingest/events}"
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

start() { # name, directory, port, entry
  (cd "$2" && PORT="$3" exec node "$4" >"$state/$1.log" 2>&1 </dev/null) &
}

start_all() {
    start simulator apps/sweden-simulator 5000 dist/server.js
    wait_for http://localhost:5000/health
    start central apps/onsite-central 6001 dist/server.js
    wait_for http://localhost:6001/health
    start local-se apps/onsite-local-se 4000 dist/server.js
    wait_for http://localhost:4000/api/v1/health
    start web apps/web 3000 dist-server/index.js
    wait_for http://localhost:3000/health
}

stop_all() {
  stop_one web
  stop_one local-se
  stop_one central
  stop_one simulator
}

case "${1:-}" in
  up)
    load_env
    (cd apps/web && npm run --silent build)
    (cd apps/sweden-simulator && npm run --silent build)
    (cd apps/onsite-central && npm run --silent build)
    (cd apps/onsite-local-se && npm run --silent build)
    start_all
    echo "Up. Web: http://localhost:3000   Simulator: http://localhost:5000   Central: http://localhost:6001"
    echo "If the databases are empty: scripts/run-native.sh reset"
    ;;
  down)
    stop_all
    echo "Stack stopped."
    ;;
  reset)
    load_env
    # Dropping schemas under running workers only produces errors, so the services stop for it.
    running=0
    curl -fsS -m 2 http://localhost:4000/api/v1/health >/dev/null 2>&1 && running=1
    [ "$running" = 1 ] && { stop_all; sleep 1; }
    ONSITE_NATIVE=1 scripts/reset-demo.sh "${2:-S1}"
    if [ "$running" = 1 ]; then
      start_all
      echo "Services restarted."
    fi
    ;;
  *)
    echo "Usage: scripts/run-native.sh up|down|reset [S1|S2]" >&2
    exit 2
    ;;
esac
