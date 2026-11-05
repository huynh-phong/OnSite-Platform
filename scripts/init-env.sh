#!/usr/bin/env bash
# Creates a git-ignored .env from .env.example with freshly generated local secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env already exists; leaving it unchanged."
  exit 0
fi

hex() { openssl rand -hex "$1"; }
se_db_password="$(hex 16)"
sim_db_password="$(hex 16)"
jwt_secret="$(hex 32)"
data_key="$(openssl rand -base64 32)"
service_token="$(hex 32)"
demo_password="$(hex 8)"

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    SE_DB_PASSWORD=*) echo "SE_DB_PASSWORD=$se_db_password" ;;
    SIM_DB_PASSWORD=*) echo "SIM_DB_PASSWORD=$sim_db_password" ;;
    SE_DATABASE_URL=*) echo "SE_DATABASE_URL=postgres://onsite_se:$se_db_password@localhost:5433/onsite_se" ;;
    SIM_DATABASE_URL=*) echo "SIM_DATABASE_URL=postgres://sweden_sim:$sim_db_password@localhost:5434/sweden_sim" ;;
    SE_JWT_SECRET=*) echo "SE_JWT_SECRET=$jwt_secret" ;;
    SE_DATA_KEY=*) echo "SE_DATA_KEY=$data_key" ;;
    SIMULATOR_SERVICE_TOKEN=*) echo "SIMULATOR_SERVICE_TOKEN=$service_token" ;;
    DEMO_PASSWORD=*) echo "DEMO_PASSWORD=$demo_password" ;;
    *) echo "$line" ;;
  esac
done < .env.example > .env

echo "Created .env. The demo password is the DEMO_PASSWORD value in that file."
