# OnSite MVP: Phase 1 Completion Report

**Team:** PYRAMID. **Date:** 5 November 2026. **Scope:** OnSite Local SE and the Sweden Legacy Simulator.

Phase 1 is functionally complete on the environment available here. All 294 automated tests and the 30-check
real-process smoke test pass on real PostgreSQL 16 and on both Node.js 24 and Node.js 20. **Three things have not been
verified: Docker Compose, Linux containers, and a call to a real AI provider.** See section E.

When this phase started, only Checkpoint 1 existed. No simulator business endpoint, sync, order, auth or AI code had
been written, and none of the five outstanding issues had been fixed.

Nothing has been committed or pushed.

## A. Checkpoint status

| Checkpoint | Completed | Tests | Issues |
|---|---|---|---|
| 1 — Skeleton | Yes, except running compose | 8 skeleton integration tests, seed and crypto unit tests | Compose not run |
| 2 — Simulator & Sync | Yes | 26 simulator integration, 20 sync integration | None open |
| 3 — Orders Core | Yes | 58 integration (T01–T08), state machine and routing unit tests | None open |
| 4 — Fulfilment | Yes | 27 fulfilment and 21 renewal integration (T09, T10, T15, T16) | See E1 and E2 for lost reservations |
| 5 — AI Normalization | Yes, on the mock provider | 34 integration (T11–T14), 7 provider and test-set unit tests | Real provider not called |
| 6 — Hardening | Yes | 23 integration (T17), smoke test | Compose and CORS: see E |

### The five outstanding issues

| Issue | State | How it works now |
|---|---|---|
| 1. Reservation expiry after approval | Fixed | `POST /legacy/reservations/:id/extend`. Local renews only for `APPROVED`/`DISPATCHING` orders, per reservation. The 30-minute deadline stands until the last approval. Approval is checked at the source first. A lost reservation blocks dispatch from that node and is shown as `reservation_health: LOST`. |
| 2. Incorrect inventory staleness | Fixed | Trust comes from `last_successful_sync_at`, source connectivity, cursor continuity (including a feed epoch) and a configurable threshold. `source_updated_at` and `ingested_at` move only when a row really changes. |
| 3. AI test and concurrency | Fixed | T11 counts calls per distinct unknown value (2 for the unit and the pack text). The review row is a committed atomic claim under a lease, and no transaction is open during the LLM call. Interrupted calls are retried up to a limit, then go to a human. |
| 4. Simulator outage endpoint | Done | `POST /legacy/admin/outage`. Other `/legacy/*` endpoints return 503; the admin endpoint stays up. Local degrades and recovers with no restart. |
| 5. Missing endpoints | Done | Every endpoint in section 12.1 exists, is authorized on the server and is documented in Swagger. A test fails on any undocumented `/api` route. |

### Original acceptance tests

| ID | Result | Where | Note |
|---|---|---|---|
| T01–T08 | Pass | `test/integration/orders.test.ts` | |
| T09, T10 | Pass | `test/integration/fulfilment.test.ts` | |
| T11 | Pass | `test/integration/normalization.test.ts` | Corrected per Issue 3: 2 AI calls, 2 reviews, not 1 |
| T12–T14 | Pass | `test/integration/normalization.test.ts` | |
| T15, T16 | Pass | `test/integration/fulfilment.test.ts` | |
| T17 | Pass | `test/integration/hardening.test.ts` | Scans files that would be committed, and for the real `.env` values |

**Difference from the original test setup.** The prompt says integration tests run against the compose stack. Without
Docker, they run Local SE in process and call a real simulator over real HTTP, each with its own real PostgreSQL
database. The separate smoke test covers real processes with real worker timing.

## B. Implemented features

**Simulator:** 11 nodes, catalog, stock and ledger; product and inventory change feeds with snapshots, paging, an epoch
and refusal of invalid cursors; atomic reservations with idempotency keys; commit, release, extend and expiry; receipts;
new products; outage and feed-trim failure switches; Swagger.

**Local SE:**

- **Security:** JWT login with server-side authorization by role, node and owner; AES-256-GCM field encryption; append-only audit log.
- **Inventory:** catalog and stock sync through the change feed, usable-stock rule, and the trust rule from Issue 2.
- **Orders:** idempotent creation, deterministic routing with reasons, the multi-node reservation saga, table-driven state machines, optimistic locking.
- **Tasks:** one per node; approval, rejection with reallocation, expiry, cancellation, dispatch, proof of delivery, OTIF.
- **ETA:** Europe/Stockholm dispatch slots with daylight saving handled, `AT_RISK` alerts, ETA history.
- **AI normalization:** mapping lookup, one review per distinct unknown value, atomic claim, mock and Anthropic providers, strict output validation, staff approve, edit and reject, replay of waiting records, cache metrics, and a 50-example evaluation.
- **Operations:** SSE, transactional outbox with sender, health, metrics, and crash recovery of interrupted allocations and AI calls.

**AI evaluation result.** This is the real output for the **mock** provider, over the 50 labelled examples:

```text
Provider: mock (mock-rules-v1)
Accuracy: 98.0%   Edit-needed: 0.0%   Invalid output: 2.0%   Unavailable: 0.0%
```

This is **not evidence of AI quality**. The mock is keyword rules written in the same effort as the test set. No real
model has been measured. To get a real figure, set `LLM_PROVIDER=anthropic` and an API key, then run the evaluation.

## C. API inventory

Swagger: `http://localhost:4000/docs` and `http://localhost:5000/docs`. All routes below are documented, and a test
enforces this for `/api`.

### Local SE (`/api/v1`)

| Method and path | Who may call it |
|---|---|
| `POST /auth/login` | Public |
| `GET /health` | Public |
| `GET /stores` | Any logged-in user |
| `GET /products` | Any logged-in user. Staff and admins also get stock per node and may use `?include_pending=true` |
| `GET /sites` | Customer (own sites), admin |
| `POST /orders` | Customer. Requires an `Idempotency-Key` header |
| `GET /orders` | Any logged-in user, scoped: customer own, staff own node, admin all |
| `GET /orders/{id}` | Customer own, staff with a task at their node, admin |
| `POST /orders/{id}/cancel` | Customer own before approval; admin also once `APPROVED` |
| `GET /orders/{id}/confirmation` | As `GET /orders/{id}`, once approved |
| `GET /staff/tasks?status=` | Staff (own node), admin (all) |
| `GET /staff/tasks/{id}/picklist` | Staff (own node), admin |
| `POST /staff/tasks/{id}/approve`, `/reject`, `/dispatch`, `/deliver` | Staff of that node only. Body has `version` |
| `GET /staff/normalization-reviews?status=` | Staff, admin |
| `POST /staff/normalization-reviews/{id}/approve`, `/reject` | Staff, admin |
| `GET /stream` | Any logged-in user, with events scoped. Token in the header or `?token=` |
| `GET /metrics` | Admin |
| `POST /admin/connector/enable`, `/disable` | Admin |

Refusals return 401 or 403 and write an audit row. Errors always have the form
`{ "error": { "code", "message", "request_id" } }`.

### Simulator (all `/legacy/*` need the service token)

| Method and path | Purpose |
|---|---|
| `GET /health` | Public |
| `GET /legacy/stores` | 11 nodes |
| `GET /legacy/products?since_seq=`, `POST /legacy/products` | Feed, and new products |
| `GET /legacy/inventory?since_seq=` | Feed. Cursor 0 is a full snapshot |
| `POST /legacy/receipts`, `GET /legacy/transactions` | Inbound stock, and the ledger |
| `POST /legacy/reservations`, `GET /legacy/reservations/{id}` | Atomic reserve, and status |
| `POST /legacy/reservations/{id}/commit`, `/extend` | Outbound, and renewal |
| `DELETE /legacy/reservations/{id}`, `DELETE /legacy/reservations?idempotency_key=` | Release, by id or by client key |
| `GET`, `POST /legacy/admin/outage` | Outage switch, available during an outage |
| `POST /legacy/admin/expire-sweep`, `POST /legacy/admin/feed/trim` | Controlled failure tools |

### Changes from the written spec

Most are approved by Issue 1 or needed for it; the rest are small additions for Phase 2 or for safety.

| Change | Reason |
|---|---|
| Order: `APPROVED → CANCELLED`, admin only | Issue 1 names cancellation, and it is the only way out for an approved order that lost stock |
| Task: new `CANCELLED`, and `APPROVED → EXPIRED` | A cancelled or expired order must close its tasks |
| `GET /orders`, `GET /sites` | The Phase 2 customer interface needs them |
| `GET /orders/{id}/confirmation` returns 409 before approval | Per section C9: a confirmation exists once the order is `APPROVED` |
| Reservation statuses `PENDING` and `RELEASING` | So that a crash or outage cannot lose track of held stock |
| `LLM_PROVIDER` accepts `mock` or `anthropic` only | The spec requires one real provider. `gemini` and `openai` now fail at startup rather than silently doing nothing |
| Health probes the simulator with a real business call | Its `/health` still answers during a simulated outage |
| Authentication runs before validation | An anonymous caller learns nothing about request schemas |
| `@fastify/swagger-ui` upgraded from 5 to 6 | Clears a high-severity `npm audit` advisory on `@fastify/static` |

## D. Tests

| | Simulator | Local SE | Total |
|---|---:|---:|---:|
| Unit | 3 | 74 | 77 |
| Integration | 26 | 191 | 217 |
| **Passed** | **29** | **265** | **294** |
| Failed | 0 | 0 | 0 |
| Skipped | 0 | 0 | 0 |

| Item | Result |
|---|---|
| Environment | Windows 11, no administrator rights |
| Node.js 24.16.0 | 294 of 294 passed |
| Node.js 20.20.2 | 294 of 294 passed on the final code. The version was confirmed with `node -v` and from the running server process |
| Real PostgreSQL | Yes: 16.15 portable binaries, two separate servers, for all integration tests |
| Real-process smoke test (`scripts/e2e-smoke.mjs`) | 30 of 30 on Node 20: built servers, real workers, real HTTP, full S1 flow, AI flow, outage and recovery, SSE, and a scan of both logs for secrets |
| Typecheck | Clean in strict mode, both apps |
| `npm audit --omit=dev` | 0 vulnerabilities, both apps |
| Docker | **Not run.** `docker` is not installed on this machine |

## E. Known issues

### Unverified deployment requirements

1. **Docker Compose has never been run.** `compose.yaml`, both Dockerfiles and `scripts/reset-demo.sh` in its default
   Docker mode are untested. The definition of done in the original prompt asks for `docker compose up`, so **this must
   be run once on a machine with Docker before the demo.**
2. **Linux and Alpine are untested.** Node 20 was verified on Windows, not on the `node:20-alpine` image.
3. **The real AI provider has never been called.** No API key was available. The Anthropic provider is covered only
   against a local stand-in server, which checks the request shape and failure handling. The API's actual responses and
   the model's accuracy are unmeasured.

### Confirmed defects and limitations

| ID | Issue | Effect |
|---|---|---|
| E1 | If a reservation is lost **after dispatch has started** on a split order, there is no way forward: that task can't dispatch, and `DISPATCHING` orders can't be cancelled | Stuck order, shown as `LOST`. Needs manual handling in the source system |
| E2 | A task with several reservations (a multi-line order) commits them one at a time. If a later one is lost, the earlier ones stay committed and the task stays `APPROVED` | Rare. Blocked and visible, not oversold, but needs manual handling |
| E3 | `NEEDS_REVIEW` is final except for cancelling, as the spec's state table says. There is no "retry" or "accept 90" action | The customer places a new order |
| E4 | `INVENTORY_SAFETY_RATIO` is configurable in Local SE, but the simulator's check is fixed at 0.10 | Change both together. Per-store and per-SKU ratios from the report are not implemented |
| E5 | Fastify logs a deprecation warning for `requestIdLogLabel` at startup | Harmless until Fastify 6 |

### Incomplete compared with the wider architecture report

These are outside the Phase 1 prompt but appear in the architecture report:

- **No CORS is configured.** A React app served from another origin cannot call the API until it is added or proxied.
- The seed has 1 customer, as the Phase 1 prompt says. Section 14.2 mentions 3.
- The simulator has no `legacy_orders` table or "before connection" screen data.
- The `inbox_events` table exists but is unused, because the change feed uses cursors.
- Inventory has no "stock adjustment" endpoint at the simulator, only receipts and reservations.
- SSE fan-out is per process, and multiple Local SE instances have not been tested.
- Login has no rate limit, and tokens cannot be revoked, as expected for the MVP (section 13.2).

## F. Phase 2 readiness

| Consumer | Available now | Needs first |
|---|---|---|
| **React Customer Interface** | Login, `GET /stores`, `/products`, `/sites`; `POST /orders`; `GET /orders`, `/orders/{id}`, `/confirmation`; cancel; SSE (`order.updated`, `order.at_risk`) | CORS or a proxy. Generate an `Idempotency-Key` per submit |
| **React Staff Interface** | Login; `GET /staff/tasks`, picklist; approve, reject, dispatch, deliver with `version`; normalization review queue; SSE (`task.assigned`, `task.updated`, `review.created`). `reservation_health` for the warning state | CORS or a proxy. Handle 409 `VERSION_CONFLICT`, `RESERVATION_LOST`, and 503 `SOURCE_UNAVAILABLE` |
| **Sweden Simulator Dashboard** | `GET /legacy/stores`, `/products`, `/inventory`, `/transactions`; outage switch; receipts; new products | The service token must not reach a browser: put a small server or proxy in front. There are no `legacy_orders` yet |
| **OnSite Central** | Outbox sender: `POST` to `CENTRAL_INGEST_URL` with bearer `SE_CENTRAL_TOKEN`, at least once, backoff and jitter, `DEAD` after 10 refusals | Central itself. Deduplicate on `event_id`, order by `aggregate_version` |
| **Central KPI Dashboard** | Event payload fields below, and `GET /api/v1/metrics` for Local's own figures | Central's projection and dashboard |

**Outbox event contract:**

```json
{
  "event_id": "uuid",
  "event_type": "order.approved.v1",
  "origin_country": "SE",
  "aggregate_type": "order",
  "aggregate_id": "SE-ORD-000125",
  "aggregate_version": 7,
  "occurred_at": "2026-11-08T09:12:40.000Z",
  "payload": {
    "status": "APPROVED",
    "sales_store_id": "SE-STORE-B",
    "shipment_count": 2,
    "line_count": 1,
    "at_risk": false,
    "early_shortage_detected": false,
    "otif": null,
    "eta": "2026-11-08T12:30:00.000Z",
    "requested_delivery_at": "2026-11-09T06:00:00.000Z",
    "created_at": "2026-11-08T08:59:52.000Z"
  }
}
```

Task events add `node_id` and `task_status`. A test checks that payloads never carry names, addresses, contacts or
free-text notes. Event types are `order.<status>.v1`, `task.<status>.v1`, `order.at_risk.v1`, `order.at_risk_cleared.v1`,
`order.eta_changed.v1`, and `reservation.lost.v1`, `.renewal_failed.v1`, `.renewal_recovered.v1`.

## G. Commands

Commands are from the repository root, in Git Bash on Windows.

### Run with Docker (unverified)

```bash
scripts/init-env.sh
```

```bash
docker compose up --build -d
```

```bash
scripts/reset-demo.sh S1
```

### Run without Docker

PostgreSQL 16 must already be on ports 5433 and 5434, with the users and databases from `.env`.

```bash
(cd apps/sweden-simulator && npm ci) && (cd apps/onsite-local-se && npm ci)
```

```bash
scripts/run-native.sh up
```

```bash
scripts/run-native.sh down
```

### Seed and reset

Each drops and re-seeds both databases. `S1` and `S2` choose the inventory scenario.

```bash
scripts/run-native.sh reset S1
```

```bash
scripts/run-native.sh reset S2
```

### Test

```bash
cd apps/sweden-simulator && npm test
```

```bash
cd apps/onsite-local-se && npm test
```

```bash
cd apps/onsite-local-se && npm run test:unit
```

```bash
cd apps/onsite-local-se && npm run test:integration
```

A freshly reset, running stack is needed for the smoke test:

```bash
SMOKE_LOG_FILES=.native/local-se.log,.native/simulator.log node scripts/e2e-smoke.mjs
```

### Evaluate the AI provider

Uses the mock unless `LLM_PROVIDER` and `LLM_API_KEY` are set in the shell.

```bash
cd apps/onsite-local-se && npm run eval:normalization
```
