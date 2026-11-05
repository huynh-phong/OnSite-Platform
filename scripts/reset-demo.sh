#!/usr/bin/env bash
# Drops and re-seeds all three databases. Usage: scripts/reset-demo.sh [S1|S2]   (default S1)
# Runs inside the compose stack. With ONSITE_NATIVE=1 it runs the built apps directly, using .env.
set -euo pipefail
cd "$(dirname "$0")/.."

scenario="${1:-S1}"
case "$scenario" in
  S1|S2) ;;
  *) echo "Unknown scenario '$scenario'. Use S1 or S2." >&2; exit 2 ;;
esac

if [ "${ONSITE_NATIVE:-0}" = "1" ]; then
  set -a; . ./.env; set +a
  (cd apps/sweden-simulator && node dist/cli/reset.js "$scenario")
  (cd apps/onsite-local-se && node dist/cli/reset.js)
  (cd apps/onsite-central && node dist/cli/reset.js)
else
  # The services stop first: dropping tables under running workers can deadlock.
  docker compose stop onsite-web onsite-local-se onsite-central sweden-simulator
  docker compose up -d --wait sim-db se-db central-db
  docker compose run --rm --no-deps sweden-simulator node dist/cli/reset.js "$scenario"
  docker compose run --rm --no-deps onsite-local-se node dist/cli/reset.js
  docker compose run --rm --no-deps onsite-central node dist/cli/reset.js
  docker compose up -d --wait
fi

echo "Demo reset complete with inventory scenario $scenario."
