# PROMPT — PHASE 1: BUILD THE ONSITE LOCAL SE API

> Paste everything below into your AI coding agent (Claude Code, Cursor, etc.) in an empty folder.
> Also copy `ONSITE_BAO_CAO_KIEN_TRUC_VA_KE_HOACH_MVP.md` into `docs/` of the repo — it is the source of truth.

---

## ROLE

You are a senior backend engineer. Build **Phase 1 of the OnSite MVP**: the **OnSite Local Sweden (SE) backend API**, plus a **minimal Sweden Legacy Simulator** that Local SE depends on. Code must actually run, be tested, and match the spec below exactly. Do not build UI, Central, or Denmark/Norway in this phase.

## CONTEXT (short)

OnSite is a middleware layer on top of a building-materials retailer's existing ERP/WMS in Sweden. It does **not** replace the ERP. Local SE receives B2B orders, checks usable stock across **10 stores (A–J) + 1 hub**, routes and splits orders deterministically, reserves stock **atomically at the source system (the simulator)**, creates one fulfilment task per shipping node, lets each node's staff approve/dispatch/deliver, computes an ETA and an `AT_RISK` flag, normalizes incoming source data with **AI suggestions that always go to a human review queue**, and writes events to a transactional outbox for a future Central service.

## HARD RULES

1. **Stack:** Node.js 20, TypeScript (strict), Fastify, `@fastify/swagger` + `@fastify/swagger-ui`, PostgreSQL 16, `pg` with plain SQL migrations, `zod` or TypeBox for validation, Vitest for tests, Docker Compose. No ORM.
2. **Two separate databases:** `se-db` (Local SE) and `sim-db` (simulator), each with its own user/password. Local SE must **never** connect to `sim-db`; it talks to the simulator only over HTTP.
3. **No secrets in the repo.** Only `.env.example` with placeholders. `.env` is git-ignored. Never log tokens, passwords, API keys, or PII.
4. **AI never writes business data directly.** AI output only creates rows in the review queue. No AI in routing, stock, reservation, pricing, or ETA.
5. **Routing is a pure, deterministic function** with unit tests.
6. **Every state change** goes through a state-machine guard, an optimistic `version` check, writes an `order_events` row, and writes an `outbox_events` row **in the same DB transaction**.
7. Module layering: `routes` (HTTP + validation only) → `service` (business logic, transactions) → `repository` (SQL). No business logic in routes.
8. Work in the checkpoints listed below. After each checkpoint: run migrations, seed, tests, and show me the output. **Do not move on while tests are failing.** If something in this spec is contradictory or impossible, stop and ask instead of guessing.
9. Do not invent features not listed here. Keep it simple and correct.

## REPO LAYOUT

```text
onsite-mvp/
├── README.md
├── .env.example
├── compose.yaml
├── apps/
│   ├── sweden-simulator/
│   │   ├── src/ (server.ts, db.ts, routes/, services/)
│   │   ├── migrations/
│   │   ├── seed/
│   │   └── Dockerfile
│   └── onsite-local-se/
│       ├── src/
│       │   ├── server.ts  config.ts  db.ts  auth.ts  errors.ts
│       │   ├── modules/
│       │   │   ├── catalog/  inventory/  normalization/  orders/
│       │   │   ├── routing/  reservations/  tasks/  eta/
│       │   │   ├── documents/  notifications/  outbox/  metrics/
│       │   └── connectors/  (simulator.ts, llm.ts)
│       ├── migrations/
│       ├── seed/
│       ├── test/  (unit/, integration/)
│       └── Dockerfile
├── scripts/  (reset-demo.sh)
└── docs/
```

## COMPOSE

Services: `sim-db`, `sweden-simulator` (:5000), `se-db`, `onsite-local-se` (:4000). Healthchecks on both DBs; apps wait for healthy DBs. Each app runs its migrations on startup. `scripts/reset-demo.sh` drops and re-seeds both DBs.

Environment variables for Local SE (placeholders in `.env.example`):
`COUNTRY_CODE=SE`, `SE_DATABASE_URL`, `SE_JWT_SECRET`, `SE_DATA_KEY` (32-byte base64), `SE_DATA_KEY_ID=se-key-v1`, `SIMULATOR_BASE_URL=http://sweden-simulator:5000`, `SIMULATOR_SERVICE_TOKEN`, `LLM_PROVIDER=mock|gemini|anthropic|openai`, `LLM_API_KEY`, `LLM_MODEL`, `DEMO_PASSWORD`.

---

## PART A — MINIMAL SWEDEN SIMULATOR (only what Local SE needs)

Independent service with its own DB. Auth: header `Authorization: Bearer ${SIMULATOR_SERVICE_TOKEN}`.

**Tables:** `stores`, `products` (includes a free-text `source_unit` and `source_description`), `inventory(node_id, sku_id, on_hand, reserved, version, updated_at)`, `reservations(id, node_id, sku_id, qty, status ACTIVE|COMMITTED|RELEASED|EXPIRED, expires_at, idempotency_key UNIQUE)`, `stock_ledger` (append-only), `change_feed(seq BIGSERIAL, entity, entity_id, changed_at)`.

**Endpoints:**

| Method | Path | Behaviour |
|---|---|---|
| GET | `/legacy/stores` | 11 nodes |
| GET | `/legacy/products?since_seq=` | Products changed after cursor; returns `next_seq` |
| GET | `/legacy/inventory?since_seq=` | Inventory rows changed after cursor; returns `next_seq` |
| POST | `/legacy/reservations` | Body `{node_id, sku_id, qty, ttl_minutes}`, header `Idempotency-Key`. Atomic conditional update (below). 201 with `{reservation_id, expires_at}` or 409 `INSUFFICIENT_STOCK` |
| POST | `/legacy/reservations/:id/commit` | `on_hand -= qty`, `reserved -= qty`, ledger row `OUTBOUND`, status COMMITTED |
| DELETE | `/legacy/reservations/:id` | `reserved -= qty`, status RELEASED (idempotent) |
| POST | `/legacy/products` | Create a new product (used to trigger normalization) |
| POST | `/legacy/receipts` | Inbound stock, ledger row `INBOUND` |
| POST | `/legacy/admin/outage` | `{enabled: true|false}`; when enabled, all `/legacy/*` except this one return 503 |

**Atomic reservation (must be one SQL statement):**

```sql
UPDATE inventory
   SET reserved = reserved + $qty, version = version + 1, updated_at = now()
 WHERE node_id = $node AND sku_id = $sku
   AND on_hand - reserved - CEIL(on_hand * 0.10) >= $qty
RETURNING version;
```

No row → 409. A background loop every 30 s marks expired ACTIVE reservations as EXPIRED and releases `reserved`. Every inventory change inserts a `change_feed` row.

---

## PART B — ONSITE LOCAL SE

### B1. Auth

- `POST /api/v1/auth/login` → JWT (HS256, `SE_JWT_SECRET`, 8 h) with claims `sub`, `role`, `country`, `store_id?`, `customer_id?`.
- Roles: `customer`, `staff`, `admin`. Seeded users (password from `DEMO_PASSWORD`): `buyer.nordbygg` (customer), `staff.store-b` (SE-STORE-B), `staff.hub-01` (SE-HUB-01), `staff.store-c` (SE-STORE-C), `admin.se`.
- Authorization enforced server-side: staff only see/act on tasks where `task.node_id = token.store_id`; customers only see their own orders. Violations → 403 and an `audit_logs` row. Never trust `store_id` sent by the client.

### B2. Field encryption

AES-256-GCM via `node:crypto` for `customers.contact_enc` and `sites.address_enc`. Random 12-byte nonce, AAD = `country|table|row_id|field`, store `ciphertext`, `nonce`, `tag`, `key_id`. Unit tests: round-trip works; wrong key fails; tampered AAD fails.

### B3. Database (`se-db`) — create via migrations

`stores`, `users`, `customers`, `sites(lat, lng, address_enc…)`, `products(sku_id, name, category, base_unit, pack_size_verified, status ACTIVE|PENDING_REVIEW)`, `inventory_view(node_id, sku_id, on_hand, reserved, source_updated_at, ingested_at, source_version)`, `sync_cursors`, `orders`, `order_items`, `allocations(routing_reason)`, `reservations(external_ref, status, expires_at)`, `fulfilment_tasks(status, approved_by, approved_at, dispatched_at, delivered_at, delivered_qty, reject_reason, version)`, `shipments(dispatch_slot, eta, eta_inputs JSONB)`, `order_events` (append-only), `idempotency_records`, `outbox_events(event_id UNIQUE, aggregate_id, aggregate_version, event_type, payload, status PENDING|DELIVERED|DEAD, retry_count, next_attempt_at)`, `inbox_events(source_system, source_event_id UNIQUE together)`, `normalization_mappings`, `normalization_review_queue`, `pending_normalized_records`, `audit_logs`.

Required constraints: `quantity > 0`; unique `(principal_id, key)` on idempotency; unique `(source_system, field, raw_value_hash)` on mappings; **partial unique** `(source_system, field, raw_value_hash) WHERE status='PENDING'` on the review queue; FKs allocation→item, reservation→allocation, task→order; indexes on `fulfilment_tasks(node_id,status)`, `outbox_events(status,next_attempt_at)`, `reservations(status,expires_at)`.

### B4. Order and task state machines (exact)

```text
Order:
SUBMITTED → ALLOCATING → AWAITING_APPROVAL → APPROVED → DISPATCHING → DISPATCHED → DELIVERED
ALLOCATING → NEEDS_REVIEW
AWAITING_APPROVAL → NEEDS_REALLOCATION → ALLOCATING
AWAITING_APPROVAL → EXPIRED
CANCELLED from: SUBMITTED, ALLOCATING, AWAITING_APPROVAL, NEEDS_REVIEW, NEEDS_REALLOCATION (release all reservations)

Task:
PENDING_APPROVAL → APPROVED → DISPATCHED → DELIVERED
PENDING_APPROVAL → REJECTED | EXPIRED
```

Derived rules: order `APPROVED` only when **all** active tasks are APPROVED; `DISPATCHING` when ≥1 task DISPATCHED; `DISPATCHED` when all are; `DELIVERED` when all DELIVERED. Any task REJECTED → release that node's reservation → order `NEEDS_REALLOCATION` → re-run allocation for the missing quantity, excluding the rejecting node.

Implement as a table-driven transition map with unit tests for every allowed and every forbidden transition.

### B5. Inventory sync and usable stock

- Worker every 10 s: pull `/legacy/inventory?since_seq=` and `/legacy/products?since_seq=`, upsert, store cursor. Products and source units pass through normalization (B8) first.
- `safety = ceil(on_hand × 0.10)`; `usable = max(0, on_hand − reserved − safety)`.
- A row is **STALE** if `now − ingested_at > 60 s` **or** the last sync attempt failed. Stale rows are never used to commit.
- Inventory from records still pending normalization is **excluded** from usable.

### B6. Routing (pure function `planAllocation(input) → plan`)

Input: order lines, site lat/lng, requested time, inventory snapshot, node configs, excluded nodes. Algorithm:

1. Filter nodes: active, not excluded, not stale, `usable > 0` for the SKU.
2. If a single node can cover the full line → pick the earliest ETA; tie-break: the customer's sales store, then shorter distance, then `node_id`.
3. Else split: sort candidates by ETA (same tie-breaks), take greedily until covered, max **3** sources per line.
4. If still short → return `{status: 'SHORTAGE', fulfillable_qty}`.
5. Every allocation includes a human-readable `routing_reason` (e.g. `"Closest to site (6.2 km), usable 54"`).

Distance = haversine km. Must be deterministic. Unit tests must include scenarios S1 and S2 below.

### B7. Reservation saga

For each allocation call simulator `POST /legacy/reservations` with `Idempotency-Key = {order_id}:{allocation_id}`, `ttl_minutes = 30`. On any 409: release already-held reservations, re-sync inventory for those SKUs, re-plan, retry (max 2 retries) → then `NEEDS_REVIEW`. On 503/timeout: release held ones, order `NEEDS_REVIEW` with reason `SOURCE_UNAVAILABLE`. Worker every 30 s: expire Local reservations past `expires_at` with task still `PENDING_APPROVAL` → call DELETE on simulator → task/order `EXPIRED`.

### B8. AI data normalization with review queue (core feature)

Fields normalized in Phase 1: `product.unit` (allowed: `bag`, `piece`, `pallet`, `sheet`, `m`, `m2`, `m3`, `kg`, `roll`), `product.category` (allowed: `cement`, `timber`, `gypsum_board`, `insulation`, `other`), `product.pack_size_kg` (number, must be quoted from the source text as evidence).

Flow for each incoming value:

1. `raw_norm = lowercase(trim(collapse_whitespace(raw)))`; `hash = sha256(raw_norm)`; key = `(source_system, field, hash)`.
2. If an `APPROVED` mapping exists → apply deterministically. **No AI call.**
3. Else if a `PENDING` review row exists → attach the record to it (`pending_record_count += 1`). **No AI call.**
4. Else → call the LLM **once**, insert one `PENDING` review row with `ai_suggestion`, `confidence`, `ai_reason`, `model_version`. Use `INSERT … ON CONFLICT DO NOTHING` on the partial unique index so concurrent records cannot cause two AI calls.
5. Records waiting for review sit in `pending_normalized_records`; the product stays `PENDING_REVIEW` (hidden from customers) and any related stock is excluded from usable.
6. On approve (as-is or with an edited value): insert `APPROVED` mapping (versioned), mark review `APPROVED`, re-process all attached records in `received_at` order. On reject: mark `REJECTED`, records stay for manual handling.

LLM connector (`connectors/llm.ts`):
- Provider chosen by `LLM_PROVIDER`; implement `mock` (deterministic keyword rules, used in tests and as default) and **one** real provider. API key read only from env, only on the server.
- Prompt sends **only** the raw value, field name, product description, and the allowed values list. **Never** customer data, prices, or stock.
- Response must be JSON `{suggested_value, confidence, reason, evidence?}` validated with a schema; `suggested_value` must be in the allowed list. Invalid output, timeout (10 s) or provider error → create the review row with `ai_suggestion = null` and `ai_reason = "AI unavailable – manual review"`. Never block the order flow.

Metrics counters: `ai_calls_total`, `normalization_cache_hits_total`, `normalization_records_total`, outcomes `accepted_as_is | edited | rejected | invalid_output`.

Also create `seed/normalization-testset.json` with **50 labelled examples** (Swedish/English free-text units, descriptions, pack sizes) and a script `npm run eval:normalization` that runs the configured provider over the set and prints accuracy, edit-needed rate, invalid-output rate. Do not fabricate results — print what the run produces.

### B9. Orders API

`POST /api/v1/orders` (customer): body `{sales_store_id, site_id, requested_delivery_at, items:[{sku_id, quantity, unit}]}`, header `Idempotency-Key` required.
- Same key + same body hash → return the stored response. Same key + different body → 409 `IDEMPOTENCY_CONFLICT`.
- Order ID format `SE-ORD-000001` (DB sequence), created at intake.
- Flow: SUBMITTED → ALLOCATING → plan → saga → AWAITING_APPROVAL (tasks created, one per node) or NEEDS_REVIEW. Response 201 with status, allocations with reasons, `inventory_as_of`, `reservation_expires_at`, `version`. For `NEEDS_REVIEW` include `fulfillable_qty` and reason.

Also: `GET /orders/:id` (status, shipments, ETA, `at_risk`, event history), `POST /orders/:id/cancel`.

### B10. Tasks API (staff)

`GET /staff/tasks?status=`, `GET /staff/tasks/:id/picklist`, `POST /staff/tasks/:id/approve|reject|dispatch|deliver`. Body includes `version`; mismatch → 409 `VERSION_CONFLICT`. `reject` needs `reason`. `dispatch` calls simulator commit. `deliver` body `{delivered_qty, note}`; `delivered_qty < allocated` marks the shipment short.

### B11. ETA and AT_RISK

```text
ready_at       = approved_at + prep_minutes (STORE 60, HUB 90)
dispatch_at    = first slot ≥ ready_at among 07:00, 09:00, 11:00, 13:00, 15:00 Europe/Stockholm (next day if none)
travel_minutes = haversine_km(node, site) / 40 × 60 + 15
shipment_eta   = dispatch_at + travel_minutes
order_eta      = max(shipment_eta)
at_risk        = order_eta > requested_delivery_at
```

Before approval, show a provisional ETA assuming approval now. Store `eta_inputs` JSON for explainability. Worker every 60 s recomputes for open orders; when `at_risk` flips to true, write an `order.at_risk` event + outbox row and push an SSE notification. All parameters live in `config.ts`.

### B12. Documents

`GET /staff/tasks/:id/picklist` and `GET /orders/:id/confirmation` return JSON with: order ID, task ID, customer company, sales store, shipping node, SKU, name, qty, unit, unit price, line total (simulated), site address (decrypted only for authorized roles), requested time, ETA, status, approver, approved_at. Label clearly: `"document_type": "picking_list" | "order_confirmation"`, `"not_a_tax_invoice": true`.

### B13. SSE notifications

`GET /api/v1/stream` (token via `Authorization` header or `?token=`). Events: `task.assigned`, `task.updated`, `order.updated`, `order.at_risk`, `review.created`. Scoped: staff receive only their node's events, customers only their orders. SSE is a hint only; data is always fetched via REST.

### B14. Outbox

Every business transaction writes an outbox row with a **filtered payload — no PII** (status, counts, flags, timestamps only). In Phase 1 the sender worker exists but `CENTRAL_INGEST_URL` may be unset: then rows stay `PENDING` and `/metrics` reports `outbox_pending` and `outbox_oldest_age_s`. When set, send with exponential backoff + jitter, `SELECT … FOR UPDATE SKIP LOCKED`, mark `DELIVERED` on 2xx, `DEAD` after 10 non-retryable failures.

### B15. Health, metrics, docs, errors

- `GET /api/v1/health` → `{status, db, simulator, central}`.
- `GET /api/v1/metrics` (admin) → JSON with API p50/p95 latency, inventory freshness per node, outbox stats, reservation conflicts, AI counters, `early_shortage_detected`, `at_risk_count`, `otif_rate` (from delivered orders).
- Swagger UI at `/docs` with every endpoint and schema.
- Uniform error body `{error:{code, message, request_id}}`. Every request has a `request_id` in logs.

---

## SEED DATA (must be reproducible)

- Stores `SE-STORE-A` … `SE-STORE-J` and hub `SE-HUB-01`, realistic coordinates within one Swedish region (e.g. around Göteborg), prep minutes per type.
- ~20 SKUs in 4 categories; key SKU `SE-CEM-025` "Portland cement 25 kg bag", unit bag, pack 25 kg, price 89 SEK.
- Customer `Nordbygg AB` with two sites (one ~6 km from Store B, one far enough that ETA can become AT_RISK).
- Inventory scenario switch `seed/inventory-scenarios.json`:
  - **S1:** Store B on_hand 60, Hub 60 (usable 54 / 54) → order of 100 bags splits **54 (B) + 46 (Hub)**.
  - **S2:** Store B 60, Hub 40 (usable 54 / 36) → order of 100 bags → `NEEDS_REVIEW`, `fulfillable_qty = 90`.
  - All other stores 0 for `SE-CEM-025` so the scenarios are clean.
- Simulator product with free-text source data for the AI demo, e.g. `source_unit: "säck"`, `source_description: "Byggcement Std 25kg säck"`, and Store C reporting units as `"st"`.

---

## TESTS REQUIRED (Vitest; integration tests run against the compose stack)

Unit: state machines (all transitions), routing (S1, S2, single-node, tie-breaks, stale exclusion, max 3 sources), ETA (slot rollover, at_risk), usable formula, encryption, normalization key builder, LLM output validation.

Integration:

| ID | Scenario | Expected |
|---|---|---|
| T01 | Order 30 bags, Store B enough | 1 task at B, 1 reservation, AWAITING_APPROVAL |
| T02 | S1, 100 bags | 54 + 46, 2 tasks, 2 reservations |
| T03 | S2, 100 bags | NEEDS_REVIEW, fulfillable 90, no active reservation left |
| T04 | 20 concurrent orders for the last units | Total reserved ≤ usable; never negative |
| T05 | Same Idempotency-Key twice; then different body | 1 order; then 409 |
| T06 | staff.store-b acts on Hub task | 403 + audit row |
| T07 | Hub rejects | Hub reservation released, NEEDS_REALLOCATION, re-plan |
| T08 | Reservation expires (use short TTL in test) | Task + order EXPIRED, stock usable again |
| T09 | Approve both → dispatch → deliver | Order DELIVERED, simulator ledger has OUTBOUND rows, OTIF computed |
| T10 | Far site / late slot | at_risk = true, event in outbox |
| T11 | New product "säck" | 1 AI call, 1 PENDING review, product hidden from customers |
| T12 | Same unknown value 5 times before review | Still 1 AI call, pending_record_count = 5 |
| T13 | Approve, then send same value again | Applied instantly, ai_calls unchanged, cache hits +1 |
| T14 | LLM returns invalid JSON / times out | Review row with null suggestion; ordering still works |
| T15 | Simulator outage on | Inventory STALE, new orders NEEDS_REVIEW (SOURCE_UNAVAILABLE) |
| T16 | Every business change | Has matching order_events + outbox_events rows; outbox payload has no PII |
| T17 | Repo scan | No secrets; `.env` ignored |

---

## CHECKPOINTS (stop and report after each)

1. **Skeleton:** compose, both DBs, both apps start, `/health` OK, Swagger at `/docs`, migrations + seed run, reset script works.
2. **Simulator + sync:** simulator endpoints, atomic reservation, change feed; Local inventory/product sync, usable + stale logic. Unit tests green.
3. **Orders core:** auth, state machines, routing, saga, idempotency, tasks, documents. T01–T08 green.
4. **Fulfilment:** dispatch/deliver, ETA, AT_RISK, SSE, outbox. T09, T10, T15, T16 green.
5. **AI normalization:** module, review API, mock + one real provider, eval script. T11–T14 green.
6. **Hardening:** metrics, audit, error format, README (how to run, demo accounts, how to switch S1/S2, curl examples for the full order flow), T17. All tests green.

## DEFINITION OF DONE

- `docker compose up` + `scripts/reset-demo.sh` gives a working stack from scratch.
- The full flow works via Swagger/curl: login → place order (S1) → both nodes approve → dispatch → deliver → order DELIVERED, with correct simulator ledger.
- S2 is detected as a shortage at order time.
- The AI flow works: new product → PENDING review → approve → product ACTIVE → repeat value costs no AI call.
- All unit and integration tests pass; output shown.
- No secrets anywhere in the repo.
- README states clearly what is simulated (simulator, distances, speeds, slots, prices, AI mock provider).

Start with Checkpoint 1.
