# OnSite MVP: Phase 2 Completion Report

**Team:** PYRAMID. **Date:** 5 November 2026. **Scope:** Web interfaces, legacy dashboard, OnSite Central, Gemini, integration.

All four services run together on real PostgreSQL 16 and pass 440 automated tests and a 41-check real-process smoke test,
on Node.js 24 and 20. A live Gemini provider produces real suggestions. **Still not verified: Docker Compose and Linux
containers, and Gemini's accuracy.** Clicking through dispatch and delivery in a real browser also remains to be done; see E and G.

Nothing has been committed or pushed.

## A. Implementation status

| Component | Status | Tests | Known issues |
|---|---|---|---|
| Customer Web | Done | Component tests, S1 placed in a real browser | None open |
| Staff Web | Done | Component tests, approval and AI review seen in a real browser | Dispatch and delivery tested by component test and API, not clicked in a browser |
| Sweden Legacy Dashboard | Done | 25 gateway tests with real PostgreSQL, component tests, read in a real browser | Controls tested by component test and API, not clicked in a browser |
| OnSite Central | Done | 31 service tests, 10 Local-to-Central integration tests, read in a real browser | Port changed: see B |
| Gemini Integration | Done, live calls work | 6 provider tests against a stand-in, live smoke | Accuracy not measured; Google's service sometimes returns 503 |
| System Integration | Done natively | 41-check smoke test | Compose not run |

### Checkpoints

| Checkpoint | Result |
|---|---|
| P2-1 Integration preparation | Done. Gemini works. Same-origin proxy used, so no CORS opening |
| P2-2 Customer and Staff web | Done |
| P2-3 Legacy dashboard | Done |
| P2-4 Central | Done, including outage and catch-up |
| P2-5 System integration | Done natively. Compose updated, not run |

### Changes outside the brief, which you may want to review

| Change | Reason |
|---|---|
| **Central runs on port 6001, not 6000** | Port 6000 is on the web's blocked-port list. Browsers and `fetch` refuse it, so Central could not have worked there. This was found by the smoke test |
| **`.env`: `LLM_PROVIDER` changed from `mock` to `gemini`, and missing settings appended** | To enable your configured key. No existing value was overwritten other than that line, and the key was never printed |
| New Local SE routes: `GET /system/status`, `GET /staff/normalization-reviews/stats`, `POST /admin/demo/reset` | Staff warnings, AI metrics, and S1/S2 reset. The reset is admin only, needs a typed confirmation, and is off unless `DEMO_RESET_ENABLED=true` |
| New simulator route: `POST /legacy/admin/reset` | For the demo reset. Needs the service token and a confirmation |
| Dockerfiles build from the repository root | The simulator and Central images need the dashboards from `apps/web` |
| Times are entered and shown in Swedish time | Slots and deadlines are Swedish, and a browser in Vietnam would otherwise show a different time from the one entered |
| New `admin.se` web area, **Operations** | Connector, metrics, and demo reset needed a home |

## B. Final architecture

```text
Browser ──> OnSite Web :3000 ── /api proxy ──> OnSite Local SE :4000 ──> se-db :5433
                                                  │         │
                                 HTTP + token     │         │ HTTP + token, retried from outbox
                                                  v         v
Browser ──> Simulator + dashboard :5000     OnSite Central + dashboard :6001 <── Browser
                 │                                  │
                 v                                  v
              sim-db :5434                     central-db :5435

Local SE ──> Gemini (only unknown product values, server side)
```

- Each service has its own database and credentials. No service reads another's database. Tests check that Local SE has no route to `sim-db` in its config or code, and Central holds no such settings at all.
- **Browser to Local SE:** same origin through the web server, which forwards only the headers the API needs and refuses a token in a URL. The JWT is kept in `sessionStorage` and sent as a header.
- **Live updates:** SSE read with `fetch`, because `EventSource` cannot send an Authorization header. Events only trigger a reload from REST.
- **Dashboards:** the simulator and Central each serve their own, so each works without the others. They use a signed HttpOnly cookie. The service tokens never reach a browser: the simulator's gateway makes the service calls on the server.
- **Central** is not on the order path. Orders complete with it down.

## C. Frontend features

One Vite project and design system, three builds. Each area has its own colour and purpose.

| Area | Screens | APIs |
|---|---|---|
| **Customer** `/customer` | Overview with at-risk warnings; catalog with search and filter; order form; order list; order detail with progress, split, routing reasons, batches, history, shortage explanation, cancellation and confirmation | `/stores`, `/products`, `/sites`, `/orders`, `/orders/{id}`, `/cancel`, `/confirmation`, `/system/status`, `/stream` |
| **Staff** `/staff` | Task board by what needs doing; task with picking list, approval progress, approve, reject, dispatch, deliver; history; AI review with approve, edit, reject and counters; warnings for stale stock, outage, renewal failure, lost reservation, late ETA, and the manual-intervention case | `/staff/tasks`, `/picklist`, `/approve`, `/reject`, `/dispatch`, `/deliver`, `/staff/normalization-reviews`, `/stats`, `/orders/{id}`, `/health` |
| **Admin** `/admin` | Connector on and off; three delays shown separately; outbox, AI and business metrics; demo reset; all orders; read-only tasks; AI review | `/metrics`, `/admin/connector/*`, `/admin/demo/reset`, `/system/status` |
| **Legacy** `:5000` | Stores and hub; stock per location; guided manual process using live stock; catalog with raw values; ledger; connection state; tools for receipts, new products, outage, reset, and connecting OnSite | `/ui-api/*` |
| **Central** `:6001` | Country state; KPIs; sync lag; orders by status; event history; outage switch | `/dashboard`, `/events`, `/admin/offline` |

**Order submission:** each submission gets an idempotency key. A retry of the same order after a lost connection reuses it, so no duplicate can appear; a changed order gets a new one. The button is disabled while one is in flight.

**Connection state** on the legacy dashboard comes from real behaviour: whether something has read the inventory feed in the last 30 seconds. The dashboard's own reads don't count. **Enable OnSite Connection** logs in to Local SE with admin credentials you type, which are not stored, and calls its connector API. It does not install anything.

**The manual process** is a walk-through over live stock. It deliberately claims no timings or historical performance, and no `legacy_orders` were invented.

## D. Central implementation

- **Ingestion:** `POST /ingest/events` authenticates with the service token and validates the schema. 2xx acknowledges, including duplicates. 4xx means refused for good. 503 during an outage means retry, which Local's sender already does with backoff and jitter.
- **Deduplication:** primary key `(origin_country, event_id)` with `ON CONFLICT DO NOTHING`, in one transaction per event. Twenty concurrent copies of an event give one row, one `applied` and nineteen `duplicate`.
- **Ordering:** the projection only moves to a higher `aggregate_version`. A late event is kept on record but cannot undo a newer state. Delivering a whole order in reverse, concurrently, still ends on the final state.
- **Privacy:** payloads pass an allow-list, and string values must look like codes or timestamps, so free text placed in an allowed field is dropped too. No table has a column for customer data. Tests send names, addresses and notes and check that nothing is stored.
- **KPIs:** computed from stored projections. OTIF shows nothing until something is delivered, rather than a made-up zero, and is labelled simulated.
- **Lag:** `applied_at - occurred_at`, stored per event, with latest, p50 and p95. The screen says that it is measured on this machine, and that it is separate from API latency and inventory freshness, which are shown on Operations. No artificial delay is implemented.
- **Outage and recovery:** the outage is ingestion-only, so the dashboard stays up. Verified with real processes: Local completes orders, the outbox grows, recovery drains it, totals are right, and duplicates stay at zero.

## E. AI verification

| Kind | Result |
|---|---|
| **Mock provider tests** | All 34 normalization integration tests run on a test provider built on the mock, including every failure mode. They say nothing about AI quality. The earlier 98% is mock-rule output and is **not** Gemini's accuracy |
| **Real Gemini connectivity** | **Works.** Through the official `@google/genai` SDK, on model alias `gemini-flash-lite-latest`. The running stack produced real suggestions: `säck` → bag, `st` → piece, and 25 kg from `byggcement std 25kg säck` with quoted evidence, all then waiting for a human. An unknown value, `knippe`, got `piece` with confidence 0.5 |
| **Real Gemini accuracy** | **Not measured.** The 50-example evaluation was not run, because it needs your authorization for the calls. Run `npm run eval:normalization` with `LLM_PROVIDER=gemini` for a real figure for the AI Journal |
| **Anthropic provider** | Kept, and tested against a stand-in only. Never called for real |

**Findings from the live calls:**

- `gemini-2.5-flash` returns 404 ("no longer available to new users").
- `gemini-flash-latest` and `gemini-3.8-flash` did not answer within 45 seconds when tried here, which is why the default is `gemini-flash-lite-latest`.
- Google returned a temporary 503 on one of three calls, so a temporary error now gets one quick retry. If that fails too, the review goes to a human with no suggestion, and orders are unaffected.

Gemini's role is limited to suggesting values. It has no path to routing, stock, reservations, ETA or approval, and a test checks that placing an order makes no AI call.

## F. Test results

| Suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Sweden Simulator | 54 | 0 | 0 |
| OnSite Central | 31 | 0 | 0 |
| OnSite Web (frontend and proxy) | 74 | 0 | 0 |
| OnSite Local SE | 281 | 0 | 0 |
| **Total** | **440** | **0** | **0** |

| Item | Result |
|---|---|
| Phase 1 regression | All 294 still pass. Local SE 265 + 16 new; simulator 29 + 25 new. One assertion was extended, not weakened: the list of documented routes now includes the new ones, and the secret scan covers the new secret names |
| Unit tests | Local SE 74 + 6 Gemini = 80; simulator 3 |
| Integration tests | Local SE 201; simulator 51; Central 31 (real PostgreSQL; Local-to-Central over real HTTP) |
| Frontend tests | 67 component and client tests, 7 proxy tests |
| End-to-end, real processes | `scripts/e2e-smoke.mjs`: **41 of 41**, with live Gemini, through the web proxy, including full S1, AI flow, simulator outage, SSE, Central outage and recovery, and a scan of all four logs for secrets |
| Real browser | Login, catalog, S1 order with the 54 + 46 split, staff board, picking list, approving one node, and the AI queue with live suggestions, seen on screen. Central and the legacy dashboard read back correctly with no console errors. **Not clicked in a browser:** second-node approval, dispatch, delivery, and the dashboard controls |
| Node.js | 24.16.0 and 20.20.2, version confirmed |
| PostgreSQL | 16.15 portable, three separate servers |
| `npm audit --omit=dev` | 0 vulnerabilities in all four apps |
| Docker and Linux | **Not run.** Docker is not installed on this machine |

## G. Remaining limitations

### Unverified integrations

1. **Docker Compose has never run.** `compose.yaml` and all four Dockerfiles were rewritten and are untested, as is `reset-demo.sh` in Docker mode. **Run this on a Docker machine before relying on it. If there isn't one, the native scripts are the tested way to run the demo.**
2. **Linux and Alpine** are untested.
3. **Gemini accuracy** is unmeasured.
4. **Anthropic provider** has never been called for real.

### Confirmed defects

| Issue | Effect |
|---|---|
| A lost reservation after dispatch has started on a split order has no automatic way forward | The interface shows a manual-intervention warning. No automatic recovery was invented |
| A multi-line task commits its reservations one by one, and a later one can be lost after earlier ones committed | Rare. Blocked and visible, not oversold |
| `scripts/run-native.sh reset` while services run logs a few errors while the schema is recreated | Harmless and self-correcting. The demo reset on Operations avoids it |
| Fastify logs a deprecation warning for `requestIdLogLabel` at startup | Harmless until Fastify 6 |

### Intentional MVP limitations

- `NEEDS_REVIEW` is final, as the state table says: there is no "accept 90". The screen tells the customer to place a new order.
- The JWT lives in `sessionStorage`, so an XSS flaw could read it. A strict Content-Security-Policy reduces this. An HttpOnly session would be stronger for production.
- Central's country state says "no recent activity" rather than "offline", because it cannot tell a quiet Local from a stopped one without a heartbeat.
- The Central outage is ingestion-only, and no artificial network delay exists.
- The dashboards use one shared password each, and there is no login rate limit.
- SSE fan-out is per process.
- The safety ratio is one global setting, and the simulator's check is fixed at 0.10.

### Deferred until after Round 2

Denmark and Norway; `legacy_orders` history; stock adjustments; per-store safety ratios; KMS; OIDC.

## H. Demo instructions

**Before you start:** start PostgreSQL if the machine has restarted, then bring up the stack. Passwords are in `.env`. Stop anything else on ports 3000, 4000, 5000 and 6001.

```bash
scripts/run-native.sh up
```

```bash
scripts/run-native.sh reset S1
```

**Before OnSite.** Log in to http://localhost:3000 as `admin.se`. Under Operations → Demo reset, choose S1, connection **Off**, type RESET, and reset. Then open http://localhost:5000 and show the stores, stock, and **Manual process**. It shows **Disconnected** within 30 seconds.

**Connect OnSite.** On the legacy dashboard go to Demo tools, enter the `admin.se` login, and press **Enable OnSite connection**. The state moves to **Connecting**, then **Connected**. Operations shows the feed verified.

**AI normalization.**
1. Demo tools → New product: SKU `SE-NEW-1`, unit `knippe`, description `Byggcement Extra 35kg knippe`, then Create.
2. Log in as `staff.store-b`, go to AI review. Two suggestions appear within seconds, marked as from a live model. The product is hidden from the customer.
3. Approve or correct both. The product becomes orderable.
4. Create `SE-NEW-2` with the same unit and a description with no weight. AI calls stay the same, and "Reused without AI" goes up.

**S2, early shortage.** As `admin.se`, reset to S2, connection On. As `buyer.nordbygg`: Catalog, 100 bags of Portland cement 25 kg, Place order. It shows **Needs review**, at most 90, 10 short, nothing held, with no false confirmation.

**S1, split order.**
1. As `admin.se`, reset to S1, connection On.
2. As `buyer.nordbygg`, order 100 bags. It shows 54 from Store B, 46 from the hub, with reasons, and **Awaiting approval**.
3. As `staff.store-b`, open the task and Approve. It shows 1 of 2 nodes, and the order is still waiting.
4. As `staff.hub-01`, Approve. The order becomes **Approved**.
5. Each node presses Dispatch, then Confirm delivery.
6. As the customer: **Delivered**, on time and in full.
7. Legacy dashboard → Stock ledger: OUTBOUND 54 and 46.

Use separate browser windows or private windows for each login: sessions are per tab, so each tab can hold a different user.

**Central resilience.**
1. Log in to http://localhost:6001. Show the events and the lag.
2. Press **Simulate Central outage**.
3. As the customer, place an order: it works.
4. Operations → Events to Central: **Waiting to send** grows.
5. Press **Restore ingestion**. Waiting drains, and the total goes up by one. **Duplicates ignored** does not count anything twice.

**Security and reliability.**
- Staff of another node: open a hub task's address while logged in as `staff.store-b`. It is refused, and the attempt is audited.
- Source outage: legacy Demo tools → Start outage. Staff see a red warning, and a new order goes to **Needs review**. Press Recover: it heals by itself.
- Swagger: `:4000/docs`, `:5000/docs`, `:6001/docs`.

**Run all tests:**

```bash
for app in sweden-simulator onsite-central web onsite-local-se; do (cd apps/$app && npm test); done
```

**Automated walk-through of the whole system,** on a freshly reset stack:

```bash
SMOKE_LOG_FILES=.native/local-se.log,.native/simulator.log,.native/central.log,.native/web.log node scripts/e2e-smoke.mjs
```

**Switch off the live AI** by setting `LLM_PROVIDER=mock` in `.env` and restarting. The interface then says clearly that suggestions are not from a model.
