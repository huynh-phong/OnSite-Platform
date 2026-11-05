# OnSite MVP: Local Sweden API (Phase 1)

OnSite, by team PYRAMID, is a middleware layer on top of a building-materials retailer's existing ERP/WMS. It takes B2B
orders, checks usable stock across 10 stores and 1 hub, routes and splits orders deterministically, reserves stock
atomically at the source system, and coordinates each node's approval, dispatch and delivery. AI has one job:
suggesting normalizations of source data, which a human always reviews.

This repo holds **OnSite Local SE** (`apps/onsite-local-se`, port 4000) and the **Sweden Legacy Simulator**
(`apps/sweden-simulator`, port 5000). Each has its own PostgreSQL database, and they talk only over HTTP.

- Source of truth: [docs/ONSITE_BAO_CAO_KIEN_TRUC_VA_KE_HOACH_MVP.md](docs/ONSITE_BAO_CAO_KIEN_TRUC_VA_KE_HOACH_MVP.md)
- Status, test results, API inventory and known issues: [docs/PHASE1_COMPLETION_REPORT.md](docs/PHASE1_COMPLETION_REPORT.md)

## Run with Docker

Requires Docker with Compose, and Bash (Git Bash on Windows). This path has not been run yet: see the report.

```bash
scripts/init-env.sh
```

```bash
docker compose up --build -d
```

```bash
scripts/reset-demo.sh S1
```

`init-env.sh` writes a git-ignored `.env` with random local secrets. `reset-demo.sh [S1|S2]` drops and re-seeds both
databases with an inventory scenario, which is how you switch between S1 and S2:

| Scenario | Store B | Hub | Order of 100 bags of `SE-CEM-025` |
|---|---|---|---|
| S1 | 60 on hand, 54 usable | 60 on hand, 54 usable | Split 54 + 46, `AWAITING_APPROVAL` |
| S2 | 60 on hand, 54 usable | 40 on hand, 36 usable | `NEEDS_REVIEW`, fulfillable 90 |

## Run without Docker

For a machine without Docker. Needs PostgreSQL 16 on the ports and with the credentials from `.env` (5433 and 5434),
then Node.js 20 or later:

```bash
(cd apps/sweden-simulator && npm ci) && (cd apps/onsite-local-se && npm ci)
```

```bash
scripts/run-native.sh up
```

```bash
scripts/run-native.sh reset S1
```

```bash
scripts/run-native.sh down
```

Logs go to `.native/`.

| Service | URL |
|---|---|
| Local SE health | http://localhost:4000/api/v1/health |
| Local SE Swagger | http://localhost:4000/docs |
| Simulator health | http://localhost:5000/health |
| Simulator Swagger | http://localhost:5000/docs |

## Demo accounts

The password for all of them is the `DEMO_PASSWORD` value in your `.env`.

| User | Role | Scope |
|---|---|---|
| `buyer.nordbygg` | customer | Nordbygg AB, sites `SE-SITE-001` (near) and `SE-SITE-002` (far) |
| `staff.store-b` | staff | `SE-STORE-B` |
| `staff.hub-01` | staff | `SE-HUB-01` |
| `staff.store-c` | staff | `SE-STORE-C` |
| `admin.se` | admin | All of Sweden |

## The full order flow with curl

Load `.env` first, so that `$DEMO_PASSWORD` and `$SIMULATOR_SERVICE_TOKEN` are set, and give the sync worker 10 seconds
after a reset.

```bash
set -a; . ./.env; set +a; API=http://localhost:4000/api/v1
```

```bash
login() { curl -s "$API/auth/login" -H 'content-type: application/json' -d "{\"username\":\"$1\",\"password\":\"$DEMO_PASSWORD\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token'; }
```

```bash
BUYER=$(login buyer.nordbygg); STAFF_B=$(login staff.store-b); STAFF_HUB=$(login staff.hub-01)
```

Place an order. On S1, 100 bags split 54 at Store B and 46 at the hub:

```bash
curl -s "$API/orders" -H "authorization: Bearer $BUYER" -H "idempotency-key: $(date +%s)" -H 'content-type: application/json' -d '{"sales_store_id":"SE-STORE-B","site_id":"SE-SITE-001","requested_delivery_at":"2030-01-15T12:00:00+01:00","items":[{"sku_id":"SE-CEM-025","quantity":100,"unit":"bag"}]}'
```

Each node sees its own task. Note the `task_id` and `version` of each:

```bash
curl -s "$API/staff/tasks?status=PENDING_APPROVAL" -H "authorization: Bearer $STAFF_B"
```

Then, for Store B and likewise for the hub with `$STAFF_HUB`, using the version returned by the previous step each time:

```bash
curl -s "$API/staff/tasks/TASK_ID/approve" -H "authorization: Bearer $STAFF_B" -H 'content-type: application/json' -d '{"version":1}'
```

```bash
curl -s "$API/staff/tasks/TASK_ID/dispatch" -H "authorization: Bearer $STAFF_B" -H 'content-type: application/json' -d '{"version":2}'
```

```bash
curl -s "$API/staff/tasks/TASK_ID/deliver" -H "authorization: Bearer $STAFF_B" -H 'content-type: application/json' -d '{"version":3,"delivered_qty":54}'
```

Track it, as the customer:

```bash
curl -s "$API/orders/SE-ORD-000001" -H "authorization: Bearer $BUYER"
```

See what was shipped, at the simulator:

```bash
curl -s "http://localhost:5000/legacy/transactions?sku_id=SE-CEM-025" -H "authorization: Bearer $SIMULATOR_SERVICE_TOKEN"
```

## The AI flow

The seed includes `SE-CEM-STD-025` with a free-text unit and description, and Store C reports stock in `st`, so three
reviews are waiting after the first sync. A new product triggers the same flow:

```bash
curl -s http://localhost:5000/legacy/products -H "authorization: Bearer $SIMULATOR_SERVICE_TOKEN" -H 'content-type: application/json' -d '{"sku_id":"SE-NEW-1","name":"Ny cement","source_unit":"knippe","source_category":"cement","source_description":"Ny cement utan vikt","unit_price_sek":99}'
```

```bash
curl -s "$API/staff/normalization-reviews?status=PENDING" -H "authorization: Bearer $STAFF_B"
```

```bash
curl -s "$API/staff/normalization-reviews/REVIEW_ID/approve" -H "authorization: Bearer $STAFF_B" -H 'content-type: application/json' -d '{"value":"piece"}'
```

The product is now visible to customers, and the same value never costs another AI call. One review exists per
distinct unknown value, so a product with an unknown unit and an unknown pack-size text needs two approvals.

`LLM_PROVIDER=mock` is the default. For a real provider, set `LLM_PROVIDER=anthropic` and `LLM_API_KEY` in `.env`
(`LLM_MODEL` is optional). The key stays on the server, and the provider receives only the value, the field, the product
description and the allowed values.

## Simulating failures

Turn on a source outage. Every other `/legacy/*` endpoint returns 503 until it is turned off, and Local SE recovers
by itself:

```bash
curl -s http://localhost:5000/legacy/admin/outage -H "authorization: Bearer $SIMULATOR_SERVICE_TOKEN" -H 'content-type: application/json' -d '{"enabled":true}'
```

Admins can also disconnect the connector with `POST /api/v1/admin/connector/disable` and `.../enable`.

## Test

Tests create their own `*_test` databases on the PostgreSQL servers from `.env` and leave the demo data alone. The
database user needs permission to create databases. Unit tests need no database.

```bash
cd apps/onsite-local-se && npm run test:unit
```

```bash
cd apps/onsite-local-se && npm test
```

```bash
cd apps/sweden-simulator && npm test
```

Black-box check of a running, freshly reset stack, with real processes and real worker timing:

```bash
SMOKE_LOG_FILES=.native/local-se.log,.native/simulator.log node scripts/e2e-smoke.mjs
```

Measure the configured AI provider over the 50 labelled examples in `seed/normalization-testset.json`:

```bash
cd apps/onsite-local-se && npm run eval:normalization
```

## Configuration

`.env.example` lists the required settings. Optional ones, with defaults:

| Variable | Default | Meaning |
|---|---|---|
| `INVENTORY_SYNC_SECONDS` | 10 | How often the change feed is checked |
| `INVENTORY_STALE_AFTER_SECONDS` | 60 | Stock is not committed if the feed was not verified this recently |
| `INVENTORY_SAFETY_RATIO` | 0.10 | Safety stock. The simulator's own check is fixed at 0.10: change both together |
| `RESERVATION_TTL_MINUTES` | 30 | Approval deadline, and the length of each renewal |
| `RESERVATION_RENEWAL_SECONDS` | 60 | How often approved reservations are checked |
| `RESERVATION_RENEW_WITHIN_MINUTES` | 15 | Renew when less than this is left |
| `SOURCE_TIMEOUT_MS` | 3000 | Timeout on calls to the source |
| `LLM_TIMEOUT_SECONDS` | 10 | After this, a review goes to a human with no suggestion |
| `LLM_CLAIM_LEASE_SECONDS` | 60 | After this, an interrupted AI call may be retried |
| `CENTRAL_INGEST_URL`, `SE_CENTRAL_TOKEN` | empty | Empty means outbox events stay `PENDING` |

## What is simulated

- The ERP/WMS: the simulator stands in for it, so "atomic reservation" is proven in a simulated environment only.
- All stores, customers, sites, coordinates and prices in the seed are made up. Business metrics are labelled simulated.
- Travel speed (40 km/h), unloading (15 minutes), preparation times and dispatch slots are configured assumptions.
- ETAs are estimates. Picking lists and order confirmations are not tax invoices.
- The `mock` AI provider is keyword rules, not a model. Its evaluation numbers say nothing about AI quality.
- There is no real payment, invoicing, GPS, SMS or OnSite Central in this phase.
