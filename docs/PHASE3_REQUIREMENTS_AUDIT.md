# OnSite MVP: Phase 3 Requirements Audit

**Team:** PYRAMID. **Audited against:** architecture report v3.0 (`docs/ONSITE_BAO_CAO_KIEN_TRUC_VA_KE_HOACH_MVP.md`), capabilities C1–C19 and test cases TC01–TC22.

**How to read the status.** `IMPLEMENTED_AND_VERIFIED` means working evidence on **native Windows with PostgreSQL 16**, on Node.js 24 and 20. None of it was run in Linux containers. Docker verification is tracked in section 3. Test counts are in `docs/PHASE3_FINAL_MVP_REPORT.md`, section F.

**Evidence abbreviations.** *Browser* = Playwright in Chromium (`apps/e2e/tests`). *Integration* = Vitest against real PostgreSQL. *Smoke* = `scripts/e2e-smoke.mjs` against running processes. *Measure* = `apps/e2e/stack/measure.mjs`, which also stops real processes.

## 1. Capabilities C1–C19

Paths for Local SE are under `apps/onsite-local-se/src/modules` unless shown otherwise.

| ID | Capability | Implementation | Verification evidence | Status | Severity | Corrective action |
|---|---|---|---|---|---|---|
| C1 | Source connector | `inventory/`, simulator client, connector admin API; `apps/sweden-simulator` | `sync.test.ts`; Browser: connector off and on; Smoke | IMPLEMENTED_AND_VERIFIED | None | Simulator only by design. Production connector types are not built |
| C2 | AI normalization with review queue | `normalization/`, LLM providers | `normalization.test.ts`, `llm-provider.test.ts`; Browser D with mock; live Gemini smoke | IMPLEMENTED_AND_VERIFIED | P3 | Quality unknown: live accuracy not measured, needs authorization for 50 calls |
| C3 | Catalog and stores | `catalog/`, seed data | `seed-data.test.ts`; Browser A; rejected value stays hidden in Browser D | IMPLEMENTED_AND_VERIFIED | None | None |
| C4 | Inventory read model with freshness | `inventory/freshness.ts`, `usable.ts` | `rules.test.ts`, `sync.test.ts`; Browser F; Measure | IMPLEMENTED_AND_VERIFIED | None | None |
| C5 | Safe B2B order intake | `orders/` | `orders.test.ts` (idempotency, conflict); Browser A and B | IMPLEMENTED_AND_VERIFIED | None | **Fixed:** cart survived a placed order |
| C6 | Deterministic routing and split | `routing/` | `routing.test.ts`; Browser B (54 + 46), C (short by 10) | PARTIAL | P3 | Routing is verified. Of the alternatives the design lists, the screen gives the available quantity and advice to place a new order. There is no "accept 90" action, another-date option or other-source suggestion. Documented limitation |
| C7 | Atomic expiring reservations | `reservations/`; simulator | `orders.test.ts`, `renewal.test.ts`, `simulator.test.ts`, concurrency cases; Measure (no negative stock, none left active) | IMPLEMENTED_AND_VERIFIED | None | One rare multi-line commit case is listed in the final report, section J |
| C8 | Per-node tasks and approval | `tasks/` | `fulfilment.test.ts`; Browser B, G; stale-screen test | IMPLEMENTED_AND_VERIFIED | None | None |
| C9 | Order documents | `documents/` | `fulfilment.test.ts`; Browser B (confirmation), G (refused for another customer) | IMPLEMENTED_AND_VERIFIED | None | Tax invoice out of scope by design |
| C10 | ETA and proactive lateness warning | `eta/` | `rules.test.ts` (including daylight saving); Browser B (far site warning) | IMPLEMENTED_AND_VERIFIED | None | Travel parameters are simulated |
| C11 | Tracking and proof of delivery | `orders/`, `tasks/`, `apps/web/src/web/customer.tsx` | Browser B: full and short delivery, ledger | IMPLEMENTED_AND_VERIFIED | None | None |
| C12 | Realtime notifications | `notifications/`, `apps/web/src/web/sse.ts` | `fulfilment.test.ts`; Browser B (screens update with no reload); Smoke | IMPLEMENTED_AND_VERIFIED | None | Per-process fan-out is a known limit |
| C13 | Central event sync | `outbox/`; `apps/onsite-central` | `central.test.ts` in both apps; Browser E; Measure (Central process killed) | IMPLEMENTED_AND_VERIFIED | None | None |
| C14 | Central dashboard | `apps/onsite-central`, `apps/web/src/central` | `central.test.ts`; Browser B, E | IMPLEMENTED_AND_VERIFIED | P3 | The state reads "no recent activity" rather than "offline", because there is no heartbeat. Documented |
| C15 | Authorization | `auth/`, route guards | `hardening.test.ts`, `skeleton.test.ts`; Browser G (7 tests) | IMPLEMENTED_AND_VERIFIED | None | Demo-grade passwords, and no login rate limit |
| C16 | Per-country encryption | `apps/onsite-local-se/src/crypto.ts` | `crypto.test.ts`; Browser G (ciphertext at rest) | IMPLEMENTED_AND_VERIFIED | None | Key from the environment. KMS is deferred by design |
| C17 | Audit, metrics, health | `audit/`, `metrics/` | `hardening.test.ts`; Browser G (refusals audited); Measure | IMPLEMENTED_AND_VERIFIED | None | None |
| C18 | Failure resilience | Workers, outbox, `freshness.ts` | Browser E, F; `central.test.ts`, `renewal.test.ts`; Measure (Central, simulator and Local killed and restarted) | IMPLEMENTED_AND_VERIFIED | None | None |
| C19 | Replication to a new country | `COUNTRY_CODE` config, country checks. Denmark and Norway shown as not deployed | Design only. Foreign-country tokens refused in Browser G | INTENTIONALLY_DEFERRED | None | Excluded from this phase by instruction |

**Totals:** 17 IMPLEMENTED_AND_VERIFIED, 1 PARTIAL, 1 INTENTIONALLY_DEFERRED, 0 MISSING, 0 IMPLEMENTED_NOT_VERIFIED.

## 2. Test cases TC01–TC22

| TC | Case | Evidence | Result |
|---|---|---|---|
| TC01 | OnSite off, simulator keeps working | Browser: connector off; Measure: Local killed | Passed |
| TC02 | Connect and first sync | Browser: connector on; `sync.test.ts` | Passed |
| TC03 | 30 bags, Store B sufficient | `orders.test.ts` | Passed |
| TC04 | S1 split 54 + 46 | Browser B; Smoke; Measure (10 cycles) | Passed |
| TC05 | S2, needs review | Browser C; Smoke | Passed |
| TC06 | Concurrent orders on last stock | `orders.test.ts`, `simulator.test.ts` | Passed |
| TC07 | Repeated `Idempotency-Key` | `orders.test.ts` | Passed |
| TC08 | Store B calls hub task | Browser G; audit checked | Passed |
| TC09 | Hub rejects | `fulfilment.test.ts`; Browser B (no other source) | Passed |
| TC10 | Reservation expires | `renewal.test.ts`, `orders.test.ts` | Passed |
| TC11 | Approve, dispatch, deliver, ledger | Browser B; Smoke | Passed |
| TC12 | ETA after requested time | Browser B | Passed |
| TC13 | New free-text product | Browser D | Passed |
| TC14 | Same unknown value five times | `normalization.test.ts` | Passed |
| TC15 | Reuse after approval | Browser D | Passed |
| TC16 | AI bad output or timeout | `normalization.test.ts`, `llm-provider.test.ts` | Passed |
| TC17 | Central off, orders continue | Browser E; Measure | Passed |
| TC18 | Central back, no duplicates | Browser E; Measure | Passed |
| TC19 | Simulator down | Browser F; Measure | Passed |
| TC20 | Central credentials against `se-db` | Direct connection attempt, refused; contact data is ciphertext (Browser G) | Passed on the native servers |
| TC21 | Reset gives the same result | Browser: UI reset S2, S1, S1; Measure: 10 cycles | Passed |
| TC22 | No secrets in repo, video, submission | Repository scanned. **Video and submission files do not exist yet** | Partial: repeat for those files |

## 3. Non-functional and deployment items

| Item | Evidence | Status | Severity |
|---|---|---|---|
| Three independent databases | Three servers with separate credentials; TC20 | IMPLEMENTED_AND_VERIFIED natively | None |
| Native Windows startup | `scripts/run-native.sh` used for Smoke | IMPLEMENTED_AND_VERIFIED | None |
| Docker Compose, Linux containers | `compose.yaml`, four Dockerfiles, workflow written. **Never run** | IMPLEMENTED_NOT_VERIFIED: `PENDING_EXTERNAL_EXECUTION` | P1 only if Docker is needed for the demo |
| CI workflow | YAML parses, lockfiles pass `npm ci --dry-run`, `init-env.sh` tested in a clean folder. **Never run** | IMPLEMENTED_NOT_VERIFIED: `PENDING_EXTERNAL_EXECUTION` | P2 |
| Live Gemini connectivity | Final check: 1 of 3 calls succeeded, 2 got HTTP 503 from Google. See final report, section I | Works, intermittently | P2 for the live demo: check before recording |
| Gemini accuracy | Not run: needs authorization | Not measured | P3 |
| Anthropic provider | Tested only against a stand-in | IMPLEMENTED_NOT_VERIFIED | P3 |
| Submission files | Not created in this phase | Out of this phase's scope | Team must complete them |

## 4. Defects found in Phase 3

No P0 was found. Details and tests are in the final report, section D.

| # | Severity | Defect | Status |
|---|---|---|---|
| 1 | P1 | Demo reset sometimes failed with HTTP 500 (database deadlock with background workers) | Fixed |
| 2 | P2 | Cart kept its items after an order was placed, inviting a duplicate order | Fixed |
| 3 | P2 | `run-native.sh reset` logged errors when dropping tables under running services | Fixed |
| 4 | P2 | Pages scrolled sideways on phone widths | Fixed |
| 5 | P2 | Customer's lateness warning showed a raw UTC timestamp | Fixed |
| 6 | P2 | `compose.yaml`: central-db healthcheck variables were expanded on the host instead of in the container | Fixed, not run |
| 7 | P2 | `reset-demo.sh`: in Docker mode, it dropped tables under running workers, as in defect 3 | Fixed, not run |
