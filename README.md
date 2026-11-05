# OnSite MVP

OnSite, by team PYRAMID, is a middleware layer on top of a building-materials retailer's existing ERP/WMS. It takes B2B
orders, checks usable stock across 10 stores and 1 hub, routes and splits orders deterministically, reserves stock
atomically at the source system, and coordinates each node's approval, dispatch and delivery. Filtered events flow to
OnSite Central for monitoring. AI has two jobs, and a person checks the result of both: suggesting normalizations of source data, and
reading a pasted order message into draft lines. Stock, routing, reservations and ETAs never come from AI.

| Service | Address | What it is | Database |
|---|---|---|---|
| OnSite Web | http://localhost:3000 | Customer, Staff and Admin interfaces, and the proxy to Local SE | None |
| OnSite Local SE | http://localhost:4000 (`/docs`) | The core backend | `se-db`, port 5433 |
| Sweden Legacy Simulator | http://localhost:5000 (`/docs`) | Simulated ERP/WMS and its dashboard. Runs without OnSite | `sim-db`, port 5434 |
| OnSite Central | http://localhost:6001 (`/docs`) | Event ingestion and monitoring dashboard | `central-db`, port 5435 |

Central uses 6001 rather than the 6000 in the architecture report: browsers and `fetch` refuse to connect to 6000.

- Source of truth: [docs/ONSITE_BAO_CAO_KIEN_TRUC_VA_KE_HOACH_MVP.md](docs/ONSITE_BAO_CAO_KIEN_TRUC_VA_KE_HOACH_MVP.md)
- Final status, test results and limitations: [docs/PHASE3_FINAL_MVP_REPORT.md](docs/PHASE3_FINAL_MVP_REPORT.md)
- How to run and present the demo: [docs/FINAL_DEMO_RUNBOOK.md](docs/FINAL_DEMO_RUNBOOK.md)
- Requirements audit: [docs/PHASE3_REQUIREMENTS_AUDIT.md](docs/PHASE3_REQUIREMENTS_AUDIT.md)
- Round 2 improvements (pilot KPIs, circuit breaker, accepting available stock, AI order reader): [docs/ROUND2_IMPROVEMENTS.md](docs/ROUND2_IMPROVEMENTS.md)
- Earlier reports: [Phase 2](docs/PHASE2_COMPLETION_REPORT.md), [Phase 1](docs/PHASE1_COMPLETION_REPORT.md)

## Configure

`init-env.sh` creates a git-ignored `.env` with random local secrets. If `.env` already exists, it only appends settings
that are missing, and changes nothing else.

```bash
scripts/init-env.sh
```

## Run with Docker

Requires Docker with Compose, and Bash (Git Bash on Windows). It has passed on Linux in CI (`.github/workflows/onsite-mvp-validation.yml`), and has not been tried on Windows: see the report.

```bash
docker compose up --build -d
```

```bash
scripts/reset-demo.sh S1
```

## Run without Docker

Needs PostgreSQL 16 on ports 5433, 5434 and 5435 with the credentials from `.env`, and Node.js 20 or later.

```bash
for app in sweden-simulator onsite-central onsite-local-se web; do (cd apps/$app && npm ci); done
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

`up` builds and starts all four services. `reset` stops any running services, recreates the databases, and starts them
again. Logs go to `.native/`. To run without the live AI provider, whatever `.env` says:

```bash
ONSITE_LLM_PROVIDER=mock scripts/run-native.sh up
```

## Logins

Passwords are in your `.env`.

| Where | User | Password setting | Scope |
|---|---|---|---|
| OnSite Web | `buyer.nordbygg` | `DEMO_PASSWORD` | Customer: Nordbygg AB |
| OnSite Web | `staff.store-b` | `DEMO_PASSWORD` | Staff: `SE-STORE-B` |
| OnSite Web | `staff.hub-01` | `DEMO_PASSWORD` | Staff: `SE-HUB-01` |
| OnSite Web | `staff.store-c` | `DEMO_PASSWORD` | Staff: `SE-STORE-C` |
| OnSite Web | `admin.se` | `DEMO_PASSWORD` | Admin: all of Sweden |
| Simulator dashboard | (password only) | `SIM_DASHBOARD_PASSWORD` | Simulator |
| Central dashboard | (password only) | `CENTRAL_ADMIN_PASSWORD` | Central |

## Scenarios

| Scenario | Store B | Hub | Order of 100 bags of `SE-CEM-025` |
|---|---|---|---|
| S1 | 60 on hand, 54 usable | 60 on hand, 54 usable | Split 54 + 46, `AWAITING_APPROVAL` |
| S2 | 60 on hand, 54 usable | 40 on hand, 36 usable | `NEEDS_REVIEW`, fulfillable 90. The customer may accept 90: 54 + 36 |

Switch with **Operations → Demo reset** as `admin.se`, which resets all three systems together (needs
`DEMO_RESET_ENABLED=true`), or with `scripts/run-native.sh reset S2`. Step-by-step demo instructions are in the
[demo runbook](docs/FINAL_DEMO_RUNBOOK.md).

## AI provider

| `LLM_PROVIDER` | Key | Note |
|---|---|---|
| `mock` | None | Keyword rules, not a model. The interface says so |
| `gemini` | `GEMINI_API_KEY` | Default model `gemini-flash-lite-latest`. Change with `LLM_MODEL` |
| `anthropic` | `LLM_API_KEY` | Default model `claude-opus-5-5`. Change with `LLM_MODEL` |

The key stays on the server. The provider receives only the value, the field, the product description and the allowed
values. Every suggestion waits for a human, and an approved value is reused with no further AI call.

Check connectivity with three short calls:

```bash
cd apps/onsite-local-se && npm run llm:smoke
```

## Test

Tests use their own databases on the servers from `.env`, and leave the demo data alone.

```bash
for app in sweden-simulator onsite-central web onsite-local-se; do (cd apps/$app && npm test); done
```

Black-box check of a running, freshly reset stack, with real processes and real worker timing:

```bash
SMOKE_LOG_FILES=.native/local-se.log,.native/simulator.log,.native/central.log,.native/web.log node scripts/e2e-smoke.mjs
```

Browser tests in real Chromium, on spare ports with disposable `*_e2e` databases and the mock AI provider. Build the apps
first. They leave the demo data alone:

```bash
cd apps/e2e && npm ci && npx playwright install chromium && npm test
```

Measure latency, sync, backlog recovery and stability on this machine, including stopping real processes:

```bash
cd apps/e2e && npm run measure
```

Measure the AI provider over 50 labelled examples. This makes 50 calls to the configured provider, which may cost money:

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
| `CENTRAL_INGEST_URL` | Central in compose and native runs | Empty in other setups means outbox events stay `PENDING` |
| `NODE_HEARTBEAT_TIMEOUT_SECONDS` | 300 | Circuit breaker: a node whose store server has been silent this long gets no new orders, and parts waiting for its approval move to other nodes. `.env.example` sets 60 for the demo |
| `NODE_HEARTBEAT_CHECK_SECONDS` | 10 | How often heartbeats are read |
| `DEMO_RESET_ENABLED` | `false` in the code | Lets an admin wipe all demo data. `.env.example` turns it on: never do that outside a demo |

## What is simulated

- The ERP/WMS: the simulator stands in for it, so "atomic reservation" is proven in a simulated environment only.
- All stores, customers, sites, coordinates and prices in the seed are made up. Business figures are labelled simulated, and KPIs are not real-world results.
- Travel speed (40 km/h), unloading (15 minutes), preparation times and dispatch slots are configured assumptions.
- ETAs are estimates. Picking lists and order confirmations are not tax invoices.
- Denmark and Norway appear on Central only as future expansion. They are not deployed.
- There is no real payment, invoicing, GPS or SMS.
