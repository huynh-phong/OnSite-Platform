# OnSite MVP: Phase 3 Final Report

**Team:** PYRAMID. **Date:** 5 November 2026. **Code state:** uncommitted working tree on top of `96b4b01`.

**Environment for all results below:** Windows 11, Intel i5-12500H, 8 GB RAM, Node.js 20.20.2 unless stated, PostgreSQL 16 running natively, Chromium through Playwright. Nothing here ran in a container or on Linux.

## A. Executive Summary

**Decision: READY WITH LIMITATIONS,** for a demo on a native Windows machine.

The four applications, three databases and all the demo journeys work on this machine. They were exercised in a real browser, and with real processes stopped and restarted. No P0 defect was found. One P1 and several smaller defects were found and fixed.

Three limits matter most:

1. **Docker and Linux have never run.** The workflow is written, but this machine has no Docker. Status: `PENDING_EXTERNAL_EXECUTION`.
2. **Live Gemini is intermittent.** In the final check, 1 of 3 calls succeeded and 2 failed with HTTP 503 from Google. The system handled this as designed. Its accuracy has not been measured.
3. **Performance figures describe one laptop** with small simulated data. They say nothing about production capacity.

## B. Capability Matrix

Evidence for each row is in `docs/PHASE3_REQUIREMENTS_AUDIT.md`. "Verified" means natively, as described above.

| ID | Capability | Status | Severity of what remains |
|---|---|---|---|
| C1 | Source connector | IMPLEMENTED_AND_VERIFIED | None |
| C2 | AI normalization with review queue | IMPLEMENTED_AND_VERIFIED (flow); accuracy not measured | P3 |
| C3 | Catalog and stores | IMPLEMENTED_AND_VERIFIED | None |
| C4 | Inventory read model with freshness | IMPLEMENTED_AND_VERIFIED | None |
| C5 | Safe order intake | IMPLEMENTED_AND_VERIFIED | None |
| C6 | Deterministic routing and split | PARTIAL: routing verified, alternatives for a shortage are limited | P3 |
| C7 | Atomic expiring reservations | IMPLEMENTED_AND_VERIFIED | None |
| C8 | Per-node tasks and approval | IMPLEMENTED_AND_VERIFIED | None |
| C9 | Order documents | IMPLEMENTED_AND_VERIFIED | None |
| C10 | ETA and lateness warning | IMPLEMENTED_AND_VERIFIED | None |
| C11 | Tracking and proof of delivery | IMPLEMENTED_AND_VERIFIED | None |
| C12 | Realtime notifications | IMPLEMENTED_AND_VERIFIED | None |
| C13 | Central event sync | IMPLEMENTED_AND_VERIFIED | None |
| C14 | Central dashboard | IMPLEMENTED_AND_VERIFIED | P3 |
| C15 | Authorization | IMPLEMENTED_AND_VERIFIED | None |
| C16 | Per-country encryption | IMPLEMENTED_AND_VERIFIED | None |
| C17 | Audit, metrics, health | IMPLEMENTED_AND_VERIFIED | None |
| C18 | Failure resilience | IMPLEMENTED_AND_VERIFIED | None |
| C19 | Replication to a new country | INTENTIONALLY_DEFERRED | None |

## C. Architecture

```
Browser ──> OnSite Web :3000 ──/api──> OnSite Local SE :4000 ──> se-db :5433
                                         │         │
                 reserve, commit, feed   │         │ outbox, filtered events, retry
                                         ▼         ▼
             Sweden Simulator :5000 ──> sim-db :5434    OnSite Central :6001 ──> central-db :5435
                                         │
                                         └ Gemini, unknown source values only, server side
```

- Each application owns its database and has separate credentials. Central's credentials were refused by `se-db` when tried directly.
- The architecture was not changed in this phase. Central uses port 6001, because browsers block 6000.
- AI only suggests values for a person to review. It has no path to orders, allocations, reservations or ETA.

## D. Completed Fixes

| # | Severity | Problem | Root cause | Files | Resolution | Tests |
|---|---|---|---|---|---|---|
| 1 | P1 | Demo reset sometimes returned HTTP 500 | `TRUNCATE` in the seed deadlocked with running background workers, confirmed in the Local log | `demo.service.ts`, `workers.ts` | Workers pause during a reset. The seed retries on deadlock. A second reset at the same time gets 409 | `workers.test.ts` (4), 3 in `central.test.ts`; Browser reset test |
| 2 | P2 | Cart kept its items after an order was placed, inviting a duplicate | The clearing effect never ran after navigating away | `customer.tsx` | Cart is cleared directly on success | 1 in `customer.test.tsx` |
| 3 | P2 | `run-native.sh reset` logged errors with services running | Tables were dropped under running workers | `run-native.sh` | Stops the services, resets, restarts them | Used for Smoke: 0 error-level log lines |
| 4 | P2 | Pages scrolled sideways on phone widths | The grid column `1fr` could not shrink below its table's width | `styles.css` | Columns can shrink, and tables scroll inside their card | `z-screens.spec.ts` (8 screens at 1280 and 390 px) |
| 5 | P2 | Customer's lateness warning showed a raw UTC timestamp | Reason text used `toISOString()` | `eta.service.ts` | Shows Swedish time | Assertions added in `fulfilment.test.ts` |
| 6 | P2 | central-db healthcheck variables would expand on the host, not in the container | Single `$` in `compose.yaml` | `compose.yaml` | Uses `$$`, like the other two | **Not run:** needs Docker |
| 7 | P2 | Docker reset dropped tables under running workers | Same as #3 | `reset-demo.sh` | Stops services, resets using one-off containers, restarts | **Not run:** needs Docker |

**Also added:** `ONSITE_LLM_PROVIDER=mock` for `run-native.sh`, to run without live AI whatever `.env` says.

**Test defects, not product defects.** The first full Playwright run gave 25 passed and 2 failed. Both were corrected and neither needed a product change:

- *Stale screen:* the live update could remove the button between the visibility check and the click. The test now tolerates that timing, and also asserts that the server refuses the old version with 409.
- *Far site:* the test assumed Store B, but the earliest node for a far site depends on the time of day. It now uses the node actually assigned. A new unit test checks S1 every 15 minutes for 14 days, across the October daylight-saving change, and always gets Store B 54 + hub 46.

## E. Browser E2E Results

**Automated, Playwright in real Chromium,** browser timezone set to Vietnam, disposable `*_e2e` databases, mock AI. Any uncaught page error or console error fails a test, except "Failed to load resource" from deliberately refused requests.

**Final run on the final code: 27 passed, 0 failed, 0 skipped, in 3.2 minutes. All four service logs had 0 error-level entries.** This is one clean full run. The earlier run is described in section D.

| Scenario | Tests | Covers | Result |
|---|---|---|---|
| A Customer | 4 | Login, catalog, search, order building, Swedish time from a Vietnam browser, wrong password, logout, expired session | Passed |
| B S1 fulfilment | 6 | Order, split 54 + 46, two approvals, dispatch, delivery, ledger, Central; rejection; cancellation; two products; stale screen; lateness warning | Passed |
| C S2 | 1 | Short by 10, nothing held, no false acceptance | Passed |
| D AI, mock | 2 | Nothing applies before approval, correction, reuse with no AI call, rejection | Passed |
| E Central outage | 2 | Local continues, events wait, catch-up without double counting, redelivered events | Passed |
| F Simulator outage | 1 | Unsafe commitments refused, staff warned, recovers by itself | Passed |
| G Authorization | 7 | Between customers and nodes, roles, forged and foreign tokens, dashboards, no credential in the browser, ciphertext at rest | Passed |
| Others | 4 | Connector off and on, legacy manual process, UI reset S2/S1/S1, screen layout | Passed |

**API, not browser:** `scripts/e2e-smoke.mjs`, 45 checks through the web proxy on the normal ports.

**Manual:** Phase 3 screens were reviewed by eye from saved screenshots only. **The runbook has not been rehearsed in full by a person, and no video exists.** Live Gemini in the browser was last seen in Phase 2. Scenario D in this phase used the mock.

## F. Test Results

| Type | Passed | Failed | Skipped | Environment | Note |
|---|---|---|---|---|---|
| Unit, integration, frontend: Local SE | 289 | 0 | 0 | Node 20, final code | Full rerun after the last production change |
| Unit, integration: Simulator | 54 | 0 | 0 | Node 20 | Code unchanged since this run |
| Unit, integration: Central | 31 | 0 | 0 | Node 20 | Code unchanged since this run |
| Frontend: Web | 75 | 0 | 0 | Node 20 | Code unchanged since this run |
| **Subtotal on Node 20** | **449** | **0** | **0** | | |
| Same suites on Node 24 | 448 | 0 | 0 | Node 24.16 | Before the last Local changes (warning text, one added test). Those were not repeated on Node 24 |
| Browser E2E | 27 | 0 | 0 | Chromium, Node 20 | |
| Smoke, real processes | 45 checks | 0 | 0 | Node 20, mock AI | |
| Measurement checks | 15 checks | 0 | 0 | Node 20, mock AI | Before the warning-text change only |
| TypeScript | 5 apps | 0 | | Node 20 | |
| **Docker CI** | **Not run** | | | No Docker here | `PENDING_EXTERNAL_EXECUTION` |

**Not run, and why:**

| Item | Reason |
|---|---|
| Docker Compose, Linux containers, CI workflow | This machine has no Docker. Publishing the workflow needs authorization |
| Gemini 50-example evaluation | Paid calls, needs explicit authorization |
| Anthropic provider, live | Tested only against a stand-in |

## G. Performance

**Method:** `apps/e2e/stack/measure.mjs`, disposable databases, default settings. One laptop, sequential requests, no load test. These numbers are not capacity figures.

| Measure | Result | How |
|---|---|---|
| Order submission | p50 60.9 ms, p95 76.6 ms, max 181 ms | 40 sequential orders through the web proxy |
| Local API latency | p50 57.8 ms, p95 131.7 ms | Local's own metrics, 46 samples |
| Stock change visible through Local | p50 6.8 s, max 9.2 s | 5 receipts, 10 s sync interval |
| Age of verified stock | p50 5.5 s, max 9.6 s | Sampled every second for 25 s |
| Local to Central lag, after a burst | p50 3.6 s, p95 6.3 s | 200 events right after the 40 orders |
| Local to Central lag, one order | 621–788 ms | 6 events from one order, seen once, so indicative only |
| Backlog recovery | 50 events in 2.6 s | 5 s outage. Backoff grows with longer outages |
| AI cache hits, mock | 253 of 286 records (88%) | Synthetic, from repeated seeds. Not a real-world rate |
| Gemini latency | 1.7 s for the one success | One sample. Failed calls gave up after 3.0 s and 5.2 s |

**Bounded stability: 10 cycles** of reset, S1 order, two approvals, two dispatches and two deliveries, all with the same result.

- Local SE memory: 91 MB at the start, peak 106 MB, 78 MB at the end. There is no upward trend across these 10 cycles, which is too short to rule out a slow leak.
- No crashes, no unhandled rejections, no error-level log lines. No reservation left active, no negative stock, no duplicate orders.

**Processes actually stopped and restarted:**

| Stopped | Result |
|---|---|
| Central | Local keeps taking orders and events wait. After restart, Central catches up |
| Simulator | Local stays up and promises no stock. After restart, orders work with no restart of Local |
| Local | The web server explains the outage, and the simulator and Central keep working. After restart, the old token and order are still good |

## H. Security

| Check | Result |
|---|---|
| Real Gemini key value in repository files, native logs, E2E results, Gemini output | 0 matches each. The check was done by comparison, and the value was never printed |
| Key-shaped strings in tracked and new files | 0 |
| `.env` | Not tracked, and ignored |
| Production dependency audit, all apps | 0 vulnerabilities, **but see below** |
| Authorization and privacy | Browser G and integration tests pass. Refusals are audited |
| Demo reset | Off by default in code. **`.env.example` and the demo `.env` turn it on,** so do not reuse them outside a demo |

**Dependency findings hidden by the production-only audit:**

| Package | Severity | Exposure | Decision |
|---|---|---|---|
| `vitest`, `tinypool`, `@vitest/mocker` | 2 critical, 1 moderate | Test tooling only, never shipped. Fix is a major upgrade | Not upgraded this close to the deadline. Do not expose the test runner on a network |
| `react-router`, `react-router-dom` 6.30 | Moderate | **Declared as a dev dependency, but bundled into the browser code,** so the production audit misses it. The two advisories are an open redirect through `<Link>` and `useNavigate` with crafted values, and SSR hydration. This app has no SSR and its links are internal | Accepted for the MVP. Fix needs a major upgrade. Before production, upgrade and move it to `dependencies` |

No penetration test was performed.

## I. Deployment Verification

| Item | Status | Evidence |
|---|---|---|
| Native Windows | **Verified** | `run-native.sh` up, reset, down. Smoke 45/45 |
| Node 20 | **Verified** | Section F |
| Node 24 | Verified, apart from the last small Local changes | Section F |
| Docker Compose | **`PENDING_EXTERNAL_EXECUTION`, never run** | Files reviewed, 2 defects fixed by reading only |
| Linux containers | **`PENDING_EXTERNAL_EXECUTION`, never run** | Lockfiles contain Linux packages. `init-env.sh` tested in a clean folder, on Windows |
| CI workflow | **`PENDING_EXTERNAL_EXECUTION`, never run** | YAML parses, `npm ci --dry-run` passes for all 5 apps. Not published |
| Gemini connectivity | **Works, intermittently** | See below |
| Gemini accuracy | **Not measured** | 50-example evaluation needs authorization |

**Live Gemini check:** `npm run llm:smoke`, three short calls, model `gemini-flash-lite-latest`.

| Call | Result |
|---|---|
| category `mineralull` | Correct: insulation, 1.7 s |
| unit `säck` | Failed, HTTP 503 from Google, after 5.2 s |
| pack size of `byggcement std 25kg säck` | Failed, HTTP 503 from Google, after 3.0 s |

Request count: **3 calls. Up to 5 HTTP requests,** because the client retries once on a 503. Phase 2 had also seen occasional 503s, so plan for them.

## J. Known Limitations

**Critical blockers:** none for the native demo.

**Nonblocking defects**

- A lost reservation after dispatch has started on a split order has no automatic path forward. The screen warns that manual action is needed.
- A multi-line task commits reservations one by one, and a later one can be lost after earlier ones were committed. Rare, blocked and visible, not oversold.
- A requested delivery date in the past is accepted and flagged as at risk, rather than refused.
- On a phone, the catalog table scrolls sideways inside its card, so the product name can be out of view next to the quantity. The demo is on desktop.
- The order history shows the label "Eta changed", a cosmetic capitalization issue.
- Fastify logs a deprecation warning at startup.

**Intentional MVP limitations**

- All data is simulated: stores, customers, prices, stock, distances, travel times and OTIF.
- `NEEDS_REVIEW` is final. There is no "accept 90", and the screen advises placing a new order.
- Tokens are in `sessionStorage`. Dashboards use one shared password each, and there is no login rate limit.
- SSE fan-out is per process. Central reports "no recent activity" rather than "offline", since there is no heartbeat.
- Encryption keys come from the environment, not a key vault.

**Future development:** Denmark and Norway, KMS, OIDC, real connectors, payments, tax invoices, public deployment, production-scale performance testing.

## K. Demo Readiness

**GO for a native Windows demo,** on these conditions:

1. Rehearse `docs/FINAL_DEMO_RUNBOOK.md` once, in full, with a timer. **No person has done this yet.**
2. Run `npm run llm:smoke` shortly before recording. If Google keeps returning 503, use `ONSITE_LLM_PROVIDER=mock` and say so on camera.
3. Check that no secrets are visible in the recording.

**NO-GO for claiming** Docker or Linux works, any Gemini accuracy figure, production readiness, or that the performance figures describe capacity.

**To close the Docker gap:** run `docker compose up --build -d`, `scripts/reset-demo.sh S1` and `node scripts/e2e-smoke.mjs` on a machine with Docker, or authorize publishing the workflow to GitHub. Expect that first run to possibly uncover problems, since it has never been executed.

## Acceptance Checklist

| Item | Status |
|---|---|
| All four applications reliable, three independent databases, real APIs | Yes, natively |
| S1 54 + 46, S2 short by 10, independent approvals, dispatch and delivery end to end | Yes |
| Ledger consistent, AI needs human approval, mapping reuse | Yes |
| Central reliable, its outage does not stop Local, no duplicates after recovery | Yes |
| Simulator outage prevents unsafe commitments; authorization | Yes |
| Browser workflows verified, automated tests pass | Yes, automated |
| No critical security findings | None in shipped code. 2 critical in test tooling only, see H |
| Reset reproducible, native startup functional | Yes |
| Docker status accurate, limitations documented, runbook and report complete | Yes |

## Submission Support

**Verified capabilities:** section B, and the journeys in section E.

**Actual architecture:** section C.

**User-journey evidence:** run Playwright to regenerate results and screens in `apps/e2e/test-results`, which is git-ignored. These are test artifacts, not a demo video.

**AI use in the product:** Gemini suggests values for unknown source data, and a person approves, corrects or rejects each one. Verified: the flow, the failure handling and reuse with no further call. Not verified: accuracy.

**Narration and demo instructions:** `docs/FINAL_DEMO_RUNBOOK.md`.

**Not done here:** the four submission files, the AI Journal and the video have **not** been created or verified in this phase. The team must produce them from real sources, and repeat the secret scan on them (TC22).
