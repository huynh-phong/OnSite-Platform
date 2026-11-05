#!/usr/bin/env bash
# Creates a git-ignored .env from .env.example with freshly generated local secrets.
# If .env already exists, it is left as it is, and only settings it does not have yet are appended.
set -euo pipefail
cd "$(dirname "$0")/.."

hex() { openssl rand -hex "$1"; }
se_db_password="$(hex 16)"
sim_db_password="$(hex 16)"
central_db_password="$(hex 16)"

value_for() {
  case "$1" in
    SE_DB_PASSWORD=*) echo "SE_DB_PASSWORD=$se_db_password" ;;
    SIM_DB_PASSWORD=*) echo "SIM_DB_PASSWORD=$sim_db_password" ;;
    CENTRAL_DB_PASSWORD=*) echo "CENTRAL_DB_PASSWORD=$central_db_password" ;;
    SE_DATABASE_URL=*) echo "SE_DATABASE_URL=postgres://onsite_se:$se_db_password@localhost:5433/onsite_se" ;;
    SIM_DATABASE_URL=*) echo "SIM_DATABASE_URL=postgres://sweden_sim:$sim_db_password@localhost:5434/sweden_sim" ;;
    CENTRAL_DATABASE_URL=*) echo "CENTRAL_DATABASE_URL=postgres://onsite_central:$central_db_password@localhost:5435/onsite_central" ;;
    SE_JWT_SECRET=*) echo "SE_JWT_SECRET=$(hex 32)" ;;
    SE_DATA_KEY=*) echo "SE_DATA_KEY=$(openssl rand -base64 32)" ;;
    SIMULATOR_SERVICE_TOKEN=*) echo "SIMULATOR_SERVICE_TOKEN=$(hex 32)" ;;
    SE_CENTRAL_TOKEN=*) echo "SE_CENTRAL_TOKEN=$(hex 32)" ;;
    DEMO_PASSWORD=*) echo "DEMO_PASSWORD=$(hex 8)" ;;
    CENTRAL_ADMIN_PASSWORD=*) echo "CENTRAL_ADMIN_PASSWORD=$(hex 8)" ;;
    SIM_DASHBOARD_PASSWORD=*) echo "SIM_DASHBOARD_PASSWORD=$(hex 8)" ;;
    *) echo "$1" ;;
  esac
}

if [ -f .env ]; then
  added=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      [A-Z]*=*)
        name="${line%%=*}"
        if ! grep -q "^$name=" .env; then
          [ "$added" = 1 ] || printf '\n# Added by init-env.sh\n' >> .env
          value_for "$line" >> .env
          added=1
          echo "Added $name"
        fi
        ;;
    esac
  done < .env.example
  [ "$added" = 1 ] || echo ".env already has every setting; leaving it unchanged."
  exit 0
fi

while IFS= read -r line || [ -n "$line" ]; do
  value_for "$line"
done < .env.example > .env

echo "Created .env. The demo password is the DEMO_PASSWORD value in that file."
