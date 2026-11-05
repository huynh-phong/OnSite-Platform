# OnSite MVP: Round 2 Improvements

**Team:** PYRAMID. **Date:** 5 November 2026. **Base:** commit `921fd13`.

The Round 2 judges score engineering quality, architecture, AI usage with human validation, and technical reasoning aligned with the Round 1 problem. The Phase 3 MVP was solid, but four things the Round 1 proposal promised were missing or only partly built. This round closes those gaps. Each one is tied to a Round 1 slide, and each is covered by tests.

| # | Round 1 promise | Before | Now |
|---|---|---|---|
| 1 | Go/no-go gate: OTIF +3 pp, status calls −30%, adoption >90% (slides 2 and 9) | Central showed OTIF only | Central shows all three gate KPIs, measured from events |
| 2 | Risk 3: a node that misses heartbeats for over 5 minutes is isolated and the order rerouted (slide 10) | Only a whole-source outage was handled | Per-node circuit breaker: routing avoids the node, and its unapproved work moves to the next node |
| 3 | Shortages are caught at order time, with options for the customer | `NEEDS_REVIEW` was final, so the customer had to start again (capability C6, PARTIAL) | The customer can accept what can be supplied now, and the order continues |
| 4 | AI parses contractor emails into draft orders (slide 8) | AI only normalized source data | AI reads a pasted message into draft lines. Deterministic guardrails apply, and a person confirms every line |

There are also three small fixes: requested delivery times in the past are refused, a Fastify deprecation warning is removed, and the history label "Eta changed" now reads "ETA changed".

## 1. Pilot go/no-go KPIs on Central

**Where:** `apps/onsite-central/src/services/dashboard.ts` (`pilot_kpis`), and the "Pilot go/no-go KPIs (Round 1)" card in `apps/web/src/central/App.tsx`.

| KPI | Measured as | Why this measure |
|---|---|---|
| OTIF | Delivered on time and in full ÷ delivered | Unchanged, still labelled simulated |
| Status calls −30% | Orders whose customer got a delay warning before the requested time | Each proactive warning answers a call before it is made. It is a count, not a claim about calls avoided |
| Adoption >90% | Node tasks decided in OnSite ÷ (decided + missed the approval deadline) | A task that expires unanswered is work that did not happen in OnSite |

- Everything is counted from Central's inbox, where the primary key has already removed redelivered events. Local SE sends nothing new.
- An approved task that later expires, because its sibling node never answered, is not counted as missed.
- A task moved off an offline node by the circuit breaker counts as neither decided nor missed. Its event carries `reason: NODE_OFFLINE`, a code allowed by Central's payload allow-list.
- An adoption rate below 90% is shown as a warning.

**Tests:** 2 in `central.test.ts` (each KPI counted once, redeliveries ignored, edge cases above), 1 in `web/test/infra.test.tsx`.

## 2. Per-node circuit breaker

**Where:** `apps/onsite-local-se/src/modules/nodes/node-health.service.ts`, `catalog.repository.ts` (`recordHeartbeats`, `listOfflineNodeIds`), `allocation.service.ts` (routing), `tasks.service.ts` (`rerouteFromOfflineNode`). Simulator: `stores.link_down_since`, `POST /legacy/admin/stores/{id}/link`, and the "Store server link" card under Demo tools.

**How it works**

1. Each store's own server reports to the ERP. In the simulator, dropping a store's link freezes its `last_heartbeat_at`.
2. Every `NODE_HEARTBEAT_CHECK_SECONDS` (10), Local SE reads the heartbeats and records them with the time of the read.
3. A node is **offline** when, at the last read, it had been silent for longer than `NODE_HEARTBEAT_TIMEOUT_SECONDS`. The default is 300, the 5 minutes from Round 1. The demo `.env` uses 60.
4. Routing treats an offline node's stock as untrusted, so new orders go around it.
5. Tasks still waiting for an offline node's approval are released and re-planned, by the same code path a staff rejection uses. The customer's ETA is recalculated, and a delay warning fires if it is now late.

**Decisions**

| Decision | Reason |
|---|---|
| Silence is measured as the source saw it (`checked_at − last_heartbeat_at`), not as `now − last_heartbeat_at` | If Local SE cannot read the source, which is a source outage, every node would otherwise look offline and the next order would be refused. The freshness check already handles a source outage |
| A failed read changes nothing, and no task is moved | Not hearing the source is not evidence that one node went quiet |
| Approved parts are not moved | People at that node already promised the stock. Moving it silently would break that promise |
| The move reuses the rejection path | One tested way to release, re-plan and reserve. The event is recorded with actor `system` |
| A node never heard of is not offline | So a fresh reset never starts with every node isolated |

**Tests:** 9 in `node-health.test.ts`. They cover routing around a silent node, moving a pending part, a split order, an approved part left alone, no other source (review), recovery, a source outage not taking nodes offline, and the metrics. There are also 3 in the simulator's `simulator.test.ts`.

## 3. Accepting what can be supplied now

**Where:** `POST /api/v1/orders/{id}/accept-available`, `OrdersService.acceptAvailable`, `AllocationService.availableNow`, migration `004_accept_available.sql`, and the "Accept the 90 available" button on the customer's order.

1. Only the customer who owns the order can accept, only for an order under review because of stock (`INSUFFICIENT_STOCK` or `RESERVATION_CONFLICT`), and only at the current version.
2. The routing planner computes, line by line, what can be supplied now. The figure from order time is not reused.
3. Each line is cut to that quantity, and `requested_quantity` keeps what was first asked for. The order then goes through normal allocation: reserve, then approval by each node.
4. In-full is judged against the quantity the customer agreed to.

If nothing is available now, the request is refused (`NOTHING_AVAILABLE`). It is also refused if one line has nothing available (`LINE_UNAVAILABLE`), because dropping a whole line is a new order. A source problem under review (`SOURCE_UNAVAILABLE`) cannot be accepted this way.

The state machine gains exactly one transition, `NEEDS_REVIEW → ALLOCATING`. S2 now runs end to end: 90 accepted, 54 + 36 reserved, two approvals, delivery, OTIF true.

**Tests:** 6 in `accept-available.test.ts`, 3 in `web/test/customer.test.tsx`, and the transition table in `rules.test.ts`.

## 4. AI reads a pasted order (a draft only)

**Where:** `POST /api/v1/orders/parse`, `modules/intake/order-draft.ts` (guardrails), `order-intake.service.ts`, `parseOrder` in each provider in `connectors/llm.ts`, and the "Paste an order message" card on **Catalog & order**.

**What the AI may and may not do**

| AI does | AI never does |
|---|---|
| Pick a catalog `sku_id` for each line it finds | Decide stock, price, routing, reservation or ETA |
| Copy the quantity as written | Convert units or pack sizes |
| Quote the exact words each line came from | Place, change or store an order |

**Guardrails, in code, before anything reaches the screen**

1. **Contact details are removed first.** E-mail addresses, Swedish phone numbers and personal identity numbers are replaced before the text is sent. The provider never sees them, and the screen says how many were removed.
2. **Each line must quote the message word for word.** A line whose quote is not in the text is dropped and counted, which stops invented lines.
3. **The quantity must be written in that quote,** as a whole number from 1 to 1,000,000.
4. **The product must be in the active catalog.** An unknown SKU becomes "choose a product".
5. **Units are never converted.** If the message says "pall" and the product is sold per sheet, the line is flagged and its quantity left as written. The person decides. "st" (pieces) matches any counted unit one to one, the same rule the inventory read model uses.
6. **Confidence below 0.7 is flagged,** the Round 1 threshold.
7. **Only lines with no flag are ticked.** The person ticks the rest after checking. The ticked lines go into the normal cart, and stock and prices are checked when the order is placed.
8. **On a timeout, an error or nonsense output,** the screen says so and points to the catalog. Nothing is half-done.

Round 1 proposed auto-merging matches with a score above 95%. In the MVP, every AI suggestion waits for a person, both here and in normalization. This is deliberate. Auto-approval can come later, once accuracy has been measured on real data. Today it has not been measured.

The mock provider (`LLM_PROVIDER=mock`) reads with fixed keyword rules and a small Swedish-to-catalog word list, so the demo works without a key. The screen names the model that read the message. Gemini and Anthropic use structured output with the catalog SKUs as an enum.

**Tests:** 12 in `test/unit/order-draft.test.ts` (redaction, every guardrail, the mock reader on the golden-journey message), 5 in `intake.test.ts` (end to end, nothing ordered or reserved, no phone number sent, fallbacks), 2 in `web/test/customer.test.tsx`.

## 5. Small fixes

| Fix | Where | Test |
|---|---|---|
| A requested delivery more than 5 minutes in the past is refused with `DELIVERY_IN_PAST`, instead of being accepted and flagged at risk | `orders.service.ts` | `orders.test.ts` |
| `requestIdLogLabel` replaced by `logController`, removing Fastify's FSTDEP024 warning at startup | four `app.ts` files | Typecheck, startup log |
| History label "Eta changed" now reads "ETA changed" | `customer.tsx` | — |

## 6. Configuration

| Variable | Default | Demo `.env` |
|---|---|---|
| `NODE_HEARTBEAT_TIMEOUT_SECONDS` | 300 (Round 1: 5 minutes) | 60, so the effect fits in a recording. Say so on camera |
| `NODE_HEARTBEAT_CHECK_SECONDS` | 10 | — |

`scripts/init-env.sh` adds the new setting to an existing `.env` without touching anything else.

## 7. New demo scenes

Add these to `docs/FINAL_DEMO_RUNBOOK.md`, section 4.

**D+. S2, then accept what is available.** After the S2 order shows 10 short, press **Accept the 90 available**. Expected: **Awaiting approval**, 54 from Store B and 36 from the hub, and the item line reads "You accepted this instead of 100".

**H. AI reads a pasted order.** As the customer, open **Catalog & order** and paste:

```
Hej! Ring mig på 070-123 45 67. Vi behöver 20 säckar Byggcement 25kg och 2 pall gips 13mm 900x2400. Leverans tis 07:00.
```

Press **Read with AI**. Expected: one contact detail removed; cement 20, ticked; gypsum 2, not ticked, flagged "You wrote 'pall'; this is sold per sheet". Correct the gypsum quantity by hand, tick it, then press **Add 2 checked lines to the order**. Nothing is ordered until **Place order**.

**I. Circuit breaker.** Reset S1. As the customer, order 30 bags of cement: it goes to Store B, **Awaiting approval**. On the legacy dashboard → **Demo tools → Store server link**, press **Drop link** for Store B. Within about 70 seconds, with the demo timeout, the order is rerouted to the hub. **Operations → Inventory by node** shows Store B **Offline: isolated**. Press **Restore**, and Store B is back within 10 seconds.

**F+. Pilot KPIs.** On Central, after scene E, the **Pilot go/no-go KPIs (Round 1)** card shows OTIF, delay warnings sent, and tasks handled in OnSite.

## 8. What is still true from the Phase 3 report

Everything in `docs/PHASE3_FINAL_MVP_REPORT.md`, section J, still applies: simulated data, AI accuracy not measured, performance from one laptop, Docker verified only on Linux CI. The new AI reader's accuracy is not measured either, and the demo uses the mock reader unless a provider key is configured.
