# OnSite MVP: Final Demo Runbook

**Team:** PYRAMID. **Tested path:** Windows without Docker, using `scripts/run-native.sh`. Docker Compose has not been run, so do not use it for a live demo unless it has first passed on a Docker machine.

## 1. Prerequisites

| Need | Check |
|---|---|
| Node.js 20 or later, Git Bash | `node -v` |
| PostgreSQL 16 on ports 5433, 5434, 5435 with the credentials in `.env` | The app logs say so if not |
| Dependencies installed once | `for app in sweden-simulator onsite-central onsite-local-se web; do (cd apps/$app && npm ci); done` |
| `.env` exists | `scripts/init-env.sh` creates it, and never overwrites existing values |
| Ports 3000, 4000, 5000, 6001 are free | Stop anything else using them |

Close any window that shows `.env`. Never show that file, a terminal printing it, or the browser's storage panel during the recording.

## 2. Start and reset

Run these from the repository root, in Git Bash.

```bash
scripts/run-native.sh up
```

```bash
scripts/run-native.sh reset S1
```

To stop everything:

```bash
scripts/run-native.sh down
```

`reset` stops running services, recreates all three databases, and starts the services again. To run without the live AI provider, for example if Google's service is failing:

```bash
ONSITE_LLM_PROVIDER=mock scripts/run-native.sh up
```

The screen then says the suggestions come from a mock provider rather than a model. Say this aloud if you use it.

## 3. URLs and logins

| Screen | URL | User | Password setting in `.env` |
|---|---|---|---|
| Customer | http://localhost:3000 | `buyer.nordbygg` | `DEMO_PASSWORD` |
| Store B staff | http://localhost:3000 | `staff.store-b` | `DEMO_PASSWORD` |
| Hub staff | http://localhost:3000 | `staff.hub-01` | `DEMO_PASSWORD` |
| Regional admin | http://localhost:3000 | `admin.se` | `DEMO_PASSWORD` |
| Legacy dashboard | http://localhost:5000 | Password only | `SIM_DASHBOARD_PASSWORD` |
| OnSite Central | http://localhost:6001 | Password only | `CENTRAL_ADMIN_PASSWORD` |
| API documentation | `:4000/docs`, `:5000/docs`, `:6001/docs` | None | None |

Sessions are per tab, so each tab can hold a different user. Log in ahead of time, with one tab for each role, and arrange them before recording.

## 4. Demonstration script

### A. Before OnSite

1. As `admin.se`: **Operations → Demo reset**. Choose S1, turn the connection **Off**, type `RESET`, and press the reset button.
2. Open the legacy dashboard. The connection shows **Disconnected** within about 45 seconds.
3. Click **Store B** and **Hub SE-01** to show stock held separately in each location.
4. **Manual process:** press **Open next location** 11 times. Press **Next step** to see "2 of 11 locations show this product", then "On paper there are enough for 100", then the phone-each-store step.

Expected: the simulator works alone, and the page makes no claim about time saved.

### B. Connect OnSite

1. Legacy dashboard → **Demo tools**. Enter `admin.se` and its password, then press **Enable OnSite connection**.
2. The state moves to **Connected**. In Operations, the feed shows as verified.

### C. AI normalization

1. **Demo tools → New product:** SKU `SE-NEW-1`, unit `knippe`, description `Byggcement Extra 35kg knippe`. Press Create.
2. As `staff.store-b`, open **AI review**. Two suggestions appear within seconds. The product is not in the customer's catalog.
3. Approve one suggestion. Refresh the customer's catalog: the product is still hidden.
4. Use **Edit and approve** on the other. The product can now be ordered.
5. Create `SE-NEW-2` with the same unit and a description with no weight. **AI calls** does not change, and **Reused without AI** goes up.

Live Gemini spends a few requests here. Its answers can differ between runs, so do not promise a specific suggestion.

**Check before recording.** In the last check, 2 of 3 calls got HTTP 503 from Google. This makes three short calls:

```bash
cd apps/onsite-local-se && npm run llm:smoke
```

If it keeps failing, restart with `ONSITE_LLM_PROVIDER=mock`, and say on camera that the suggestions come from a mock.

### D. S2: shortage caught early

1. As `admin.se`, reset to **S2** with the connection On.
2. As `buyer.nordbygg`: **Catalog & order**, enter 100 for **Portland cement 25 kg bag**, then **Place order**.

Expected: **Needs review**, at most 90 available, 10 short. Nothing is held and no false confirmation appears.

### E. S1: split order, end to end

1. As `admin.se`, reset to **S1** with the connection On.
2. As the customer, order 100 bags. Expected: **54 from Store B, 46 from the hub**, with the reason for each, and **Awaiting approval**.
3. As `staff.store-b`, open the task and press **Approve**. The order still waits, showing 1 of 2 nodes.
4. As `staff.hub-01`, press **Approve**. The order becomes **Approved**.
5. Each node presses **Dispatch**, then **Confirm delivery**.
6. As the customer: **Delivered**.
7. Legacy dashboard → **Stock ledger**: OUTBOUND 54 and OUTBOUND 46.

### F. Central resilience

1. Log in to Central. Show the Sweden row, the event history and the lag. Denmark and Norway are labelled as not deployed.
2. Press **Simulate Central outage**.
3. As the customer, place another order. It works normally.
4. As `admin.se`, **Operations → Events to Central:** **Waiting to send** grows.
5. Press **Restore ingestion**. The waiting count drains, the totals rise once, and **Duplicates ignored** does not inflate the figures.

### G. Optional extras

- **Refused access:** as `staff.store-b`, open the address of a hub task. It is refused.
- **Source outage:** legacy **Demo tools → Start outage**. Staff see a warning and a new order goes to **Needs review**, with no stock promised. Press **Recover**, and it heals by itself.

## 5. If something goes wrong

| Symptom | Likely cause | Action |
|---|---|---|
| A service will not start, or database connection errors appear | PostgreSQL is not running | Start PostgreSQL, then `scripts/run-native.sh up` |
| "Address already in use" | A previous stack is still running | `scripts/run-native.sh down`, then `up` |
| Screens are in a confusing state | Earlier steps left data behind | Operations → Demo reset, or `scripts/run-native.sh reset S1` |
| "A reset is already running" | Two resets were requested | Wait a few seconds and look at the result |
| Order goes to **Needs review** with source unavailable | Outage still on, or stock not yet verified | Legacy **Recover**, wait up to 15 seconds |
| Central shows no data after an outage | Ingestion still off | Press **Restore ingestion**. Backoff can take a little while after a long outage |
| AI shows no suggestion, or says a person must decide | Gemini is slow or returning errors | This is the designed behaviour, so show it. Or restart with `ONSITE_LLM_PROVIDER=mock` |
| Customer order number is not 000001 | No reset before the take | Reset, and re-record |

Check logs in `.native/` (git-ignored). They contain no secrets, but do not show them on screen without reason.

## 6. What must not be shown as production-ready

- **Simulated data:** stores, customers, prices, stock, distances and travel times. OTIF is labelled simulated. Do not quote it as a business result.
- **Gemini accuracy:** not measured. Do not state a percentage. The 98% from Phase 1 came from the mock.
- **Performance figures:** one laptop with small data, not capacity. Do not imply production scale.
- **Docker and Linux:** not run unless the CI workflow has passed. See the final report.
- **Denmark and Norway:** design only.
- **Security:** demo secrets from environment variables, not a key vault. Logins and demo reset are demo-grade. Encryption covers selected fields with a key from the environment.
- **Not built:** payment, tax invoices, real ERP, SMS or GPS, and public deployment.

## 7. Seven-minute narration (English)

Timings are targets. Rehearse with a timer and cut the optional parts first.

**0:00–0:45 Part 1: the problem.**
"Building-materials retailers in Sweden run stock across stores and a hub, each with its own view in a legacy system. A large B2B order often needs more than one location, and staff piece it together by hand. OnSite is middleware on top of that system. It does not replace it."

**0:45–1:30 Part 2: before integration.**
Show the disconnected legacy dashboard and the manual process.
"This simulator stands in for the existing ERP and warehouse system. It runs by itself. To answer one order, somebody opens eleven locations. And what's on paper may not be what is safely available."

**1:30–2:00 Part 3: connect OnSite.**
Press Enable OnSite connection.
"Connecting needs no change to the source. OnSite reads its API and change feed, and the state goes to Connected."

**2:00–3:00 Part 4: AI normalization.**
Create the product, show the suggestions, approve, show reuse.
"Source data is messy. Here 'knippe' is a free-text unit. AI suggests a standard value, with its confidence, but nothing applies until a person approves it, and the product stays hidden until then. An approved value is reused with no further call. AI has no path to orders, stock, reservations or delivery estimates."

**3:00–3:45 Part 5: S2, shortage.**
Order 100 with only 90 safely available.
"Here the safe stock is 90. Instead of a promise it can't keep, the customer sees straight away that 10 are short. Nothing is held."

**3:45–5:15 Part 6: S1, split order.**
Run the order through both approvals, dispatch and delivery, then show the ledger.
"With enough stock, the same order splits 54 and 46, and shows why. Stock is reserved atomically in the source. Each node approves only its own part, and the order moves on only when both have. The ledger in the source system shows exactly what left, which is 54 and 46."

**5:15–6:15 Part 7: Central resilience.**
Run the outage and recovery.
"Central monitors, but orders never depend on it. I switch off its ingestion, and Sweden keeps taking orders while events wait in a durable outbox. When it comes back they're delivered, and repeats are ignored, so nothing is counted twice."

**6:15–7:00 Part 8: engineering proof and limits.**
Show the test summary from the final report.
"This is backed by automated tests and by real-browser tests of these same journeys, plus process kills and reset checks. Let me be plain about the limits. The data is simulated. The figures come from one laptop. We have not measured AI accuracy, and the Docker path is prepared but needs a Docker machine to prove it. This is an MVP that shows the flow works. It is not a production system."
