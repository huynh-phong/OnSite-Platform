// Measures this machine, on a disposable stack: latency, sync, backlog recovery and bounded stability, and kills
// real processes to prove independence. Results describe this environment only, not production capacity.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { assertBuilt, buildEnv, logDir, resetDatabases, startService, stopServices, URLS } from './lib.mjs';

const WEB = URLS.web;
const results = { environment: { node: process.version, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memory_gb: Math.round(os.totalmem() / 2 ** 30) } };
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `: ${JSON.stringify(detail)}`}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] * 10) / 10 : null;
};
async function until(name, condition, timeoutMs = 120_000) {
  const start = Date.now();
  for (;;) {
    const value = await condition().catch(() => null);
    if (value) return Date.now() - start;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out: ${name}`);
    await sleep(200);
  }
}

assertBuilt();
const env = await buildEnv();
// Normal sync interval: the point here is to see real freshness.
delete env.INVENTORY_SYNC_SECONDS;
await resetDatabases(env);
const children = {};
for (const name of ['simulator', 'central', 'local-se', 'web']) {
  writeFileSync(path.join(logDir, `${name}.log`), '');
  children[name] = await startService(name, env);
}

async function call(method, url, { token, body, key } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  let json;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return { status: response.status, body: json };
}
const api = (method, url, options) => call(method, `${WEB}/api/v1${url}`, options);
const login = async (username) => (await api('POST', '/auth/login', { body: { username, password: env.DEMO_PASSWORD } })).body.access_token;
const simHeaders = { authorization: `Bearer ${env.SIMULATOR_SERVICE_TOKEN}`, 'content-type': 'application/json' };
const sim = (method, url, body) => fetch(`${URLS.sim}${url}`, { method, headers: simHeaders, ...(body ? { body: JSON.stringify(body) } : {}) });

const centralCookie = async () => {
  const response = await fetch(`${URLS.central}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: env.CENTRAL_ADMIN_PASSWORD }) });
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
};
let cookie = await centralCookie();
const centralGet = async (url) => (await fetch(`${URLS.central}${url}`, { headers: { cookie } })).json();
const centralOffline = (enabled) => fetch(`${URLS.central}/admin/offline`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });

const sqlOn = async (url, text) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(text)).rows;
  } finally {
    await client.end();
  }
};

const rssMb = () => {
  const rss = {};
  for (const [name, child] of Object.entries(children)) {
    try {
      if (process.platform === 'win32') {
        const line = execFileSync('tasklist', ['/FI', `PID eq ${child.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
        rss[name] = Math.round(Number(line.split('","')[4]?.replace(/[^\d]/g, '')) / 1024);
      } else {
        rss[name] = Math.round(Number(readFileSync(`/proc/${child.pid}/statm`, 'utf8').split(' ')[1]) * 4096 / 2 ** 20);
      }
    } catch {
      rss[name] = null;
    }
  }
  return rss;
};

const [buyer, staffB, staffHub, admin] = await Promise.all(['buyer.nordbygg', 'staff.store-b', 'staff.hub-01', 'admin.se'].map(login));
const requested = new Date(Date.now() + 7 * 86400_000).toISOString();
const order = (sku, quantity, unit = 'bag') => ({ sales_store_id: 'SE-STORE-B', site_id: 'SE-SITE-001', requested_delivery_at: requested, items: [{ sku_id: sku, quantity, unit }] });
const place = (body) => api('POST', '/orders', { token: buyer, key: randomUUID(), body });
await until('catalog', async () => (await api('GET', '/products', { token: buyer })).body.length === 20);

console.log('Order submission');
const durations = [];
const N = 40;
for (let i = 0; i < N; i += 1) {
  const started = performance.now();
  const response = await place(order('SE-CEM-040', 1));
  durations.push(performance.now() - started);
  if (response.body.status !== 'AWAITING_APPROVAL') throw new Error(`Unexpected order result: ${JSON.stringify(response.body).slice(0, 200)}`);
}
results.order_submission_ms = { samples: N, method: 'Sequential POST /orders through the web proxy, one reservation each', p50: pct(durations, 50), p95: pct(durations, 95), max: Math.round(Math.max(...durations)) };

const metrics = (await api('GET', '/metrics', { token: admin })).body;
results.local_api_latency_ms = { method: 'Local SE own /metrics over all requests so far', p50: metrics.api.p50_ms, p95: metrics.api.p95_ms, samples: metrics.api.samples };

console.log('Inventory freshness');
const changeDelays = [];
for (let i = 0; i < 5; i += 1) {
  const before = (await api('GET', '/products', { token: staffB })).body.find((p) => p.sku_id === 'SE-CEM-CON-025').usable_by_node.find((n) => n.node_id === 'SE-STORE-A').usable;
  await sim('POST', '/legacy/receipts', { node_id: 'SE-STORE-A', sku_id: 'SE-CEM-CON-025', qty: 20, reference: 'measure' });
  changeDelays.push(await until('stock change to reach Local', async () => {
    const list = (await api('GET', '/products', { token: staffB })).body;
    return list.find((p) => p.sku_id === 'SE-CEM-CON-025').usable_by_node.find((n) => n.node_id === 'SE-STORE-A').usable > before;
  }, 30_000));
  await sleep(1000 + i * 1300);
}
const ages = [];
for (let i = 0; i < 25; i += 1) {
  ages.push((await api('GET', '/system/status', { token: staffB })).body.verified_age_s);
  await sleep(1000);
}
results.inventory = {
  method: 'Default 10 s sync. A receipt at the simulator until visible through Local (5 samples); feed-verified age sampled once a second for 25 s',
  change_visible_ms: { p50: pct(changeDelays, 50), max: Math.max(...changeDelays), samples: changeDelays },
  verified_age_s: { p50: pct(ages, 50), max: Math.max(...ages) },
};

console.log('Local to Central');
await until('outbox to drain', async () => (await api('GET', '/metrics', { token: admin })).body.outbox.outbox_pending === 0);
const dash = await centralGet('/dashboard');
results.central_sync_lag_ms = { method: 'applied_at - occurred_at over the last events, 2 s sender interval', ...dash.central_sync_lag_ms };

console.log('Backlog recovery');
await centralOffline(true);
for (let i = 0; i < 10; i += 1) await place(order('SE-CEM-MOR-025', 1));
await sleep(5000);
const backlog = (await api('GET', '/metrics', { token: admin })).body.outbox.outbox_pending;
await centralOffline(false);
const recovery = await until('backlog to drain', async () => (await api('GET', '/metrics', { token: admin })).body.outbox.outbox_pending === 0, 300_000);
const afterRecovery = await centralGet('/dashboard');
results.outbox_backlog_recovery = { method: '10 orders placed with ingestion off, 5 s outage, then time until nothing was pending', pending_events: backlog, recovery_ms: recovery, note: 'Includes exponential backoff with jitter, which grows with the length of the outage' };
check('backlog drained with no duplicates', afterRecovery.countries[0].duplicate_events_ignored === 0 && afterRecovery.kpis.total_orders === N + 10, afterRecovery.kpis);

const stats = (await api('GET', '/staff/normalization-reviews/stats', { token: staffB })).body;
results.ai = { provider: stats.provider, ai_calls_total: stats.ai_calls_total, cache_hits: stats.normalization_cache_hits_total, records: stats.normalization_records_total, hit_rate: stats.normalization_cache_hit_rate, note: 'Mock provider. Live Gemini was not called by this script' };

console.log('Stability: repeated S1 flow');
const memory = [rssMb()];
const CYCLES = 10;
for (let cycle = 0; cycle < CYCLES; cycle += 1) {
  const reset = await api('POST', '/admin/demo/reset', { token: admin, body: { scenario: 'S1', confirm: 'RESET' } });
  if (reset.status !== 200) throw new Error(`Reset failed: ${JSON.stringify(reset.body)}`);
  await until('catalog', async () => (await api('GET', '/products', { token: buyer })).body.length === 20);
  const created = await place(order('SE-CEM-025', 100));
  if (JSON.stringify(created.body.allocations?.map((a) => a.quantity)) !== '[54,46]') throw new Error(`Cycle ${cycle}: wrong split`);
  const taskOf = async (token) => (await api('GET', '/staff/tasks', { token })).body.find((task) => task.order_id === created.body.order_id);
  for (const action of ['approve', 'dispatch', 'deliver']) {
    for (const [token, qty] of [[staffB, 54], [staffHub, 46]]) {
      const task = await taskOf(token);
      const done = await api('POST', `/staff/tasks/${task.task_id}/${action}`, { token, body: { version: task.version, ...(action === 'deliver' ? { delivered_qty: qty } : {}) } });
      if (done.status !== 200) throw new Error(`Cycle ${cycle} ${action}: ${JSON.stringify(done.body)}`);
    }
  }
  const final = (await api('GET', `/orders/${created.body.order_id}`, { token: buyer })).body;
  if (final.status !== 'DELIVERED') throw new Error(`Cycle ${cycle}: ended ${final.status}`);
  memory.push(rssMb());
}
results.stability = { method: `${CYCLES} cycles of reset, S1 order, two approvals, two dispatches, two deliveries`, cycles_completed: CYCLES, rss_mb_start: memory[0], rss_mb_end: memory.at(-1), rss_mb_by_cycle_local_se: memory.map((m) => m['local-se']) };
check(`${CYCLES} full cycles completed with the same result`, true);
const reservations = await sqlOn(env.SIM_DATABASE_URL, `SELECT status, count(*)::int AS n FROM reservations GROUP BY status`);
check('no reservation left active after the last delivery', !reservations.some((row) => row.status === 'ACTIVE'), reservations);
const negative = await sqlOn(env.SIM_DATABASE_URL, 'SELECT 1 FROM inventory WHERE on_hand < 0 OR reserved < 0 OR reserved > on_hand');
check('no negative or impossible stock', negative.length === 0, negative);

console.log('Independence: stopping real processes');
const placed = await place(order('SE-CEM-040', 1));

children.central.kill();
await sleep(1000);
const withoutCentral = await place(order('SE-CEM-040', 1));
check('Central process stopped: Local still takes orders', withoutCentral.body.status === 'AWAITING_APPROVAL', withoutCentral.body);
await sleep(4000);
const pendingNoCentral = (await api('GET', '/metrics', { token: admin })).body.outbox.outbox_pending;
check('Central process stopped: events wait', pendingNoCentral > 0, pendingNoCentral);
children.central = await startService('central', env);
cookie = await centralCookie();
await until('events to arrive after Central restarts', async () => (await api('GET', '/metrics', { token: admin })).body.outbox.outbox_pending === 0, 300_000);
const projected = await sqlOn(env.CENTRAL_DATABASE_URL, `SELECT status FROM order_projection WHERE order_id = '${withoutCentral.body.order_id}'`);
check('Central restarted: it caught up from durable state', projected[0]?.status === 'AWAITING_APPROVAL', projected);

children.simulator.kill();
await sleep(1000);
check('Simulator process stopped: Local stays up and says so', (await api('GET', '/health')).body.simulator === 'down');
const withoutSim = await place(order('SE-CEM-040', 1));
check('Simulator process stopped: no stock is promised', withoutSim.body.status === 'NEEDS_REVIEW' && withoutSim.body.review_reason === 'SOURCE_UNAVAILABLE', withoutSim.body);
children.simulator = await startService('simulator', env);
await until('trust to return after the simulator restarts', async () => (await api('GET', '/system/status', { token: staffB })).body.inventory_trusted === true, 60_000);
const afterSim = await place(order('SE-CEM-040', 1));
check('Simulator restarted: orders work, with no restart of Local', afterSim.body.status === 'AWAITING_APPROVAL', afterSim.body);

children['local-se'].kill();
await sleep(1000);
const webDown = await api('GET', '/stores', { token: buyer });
check('Local process stopped: the web server explains it', webDown.status === 502 && webDown.body.error.code === 'LOCAL_SE_UNAVAILABLE', webDown);
check('Local process stopped: the simulator keeps working', (await sim('GET', '/legacy/stores')).status === 200);
check('Local process stopped: Central keeps working', (await centralGet('/dashboard')).kpis.total_orders > 0);
children['local-se'] = await startService('local-se', env);
const restored = await api('GET', `/orders/${placed.body.order_id}`, { token: buyer });
check('Local restarted: the old token and order are still good', restored.status === 200 && restored.body.status === 'AWAITING_APPROVAL', restored.body);
await until('stock trust after Local restarts', async () => (await api('GET', '/system/status', { token: staffB })).body.inventory_trusted === true, 60_000);

const levels = {};
for (const name of ['web', 'local-se', 'simulator', 'central']) {
  const lines = readFileSync(path.join(logDir, `${name}.log`), 'utf8').split('\n');
  levels[name] = {
    errors: lines.filter((line) => line.includes('"level":50')).map((line) => { try { const j = JSON.parse(line); return j.msg + ': ' + (j.err?.message ?? ''); } catch { return line.slice(0, 120); } }),
    crashes: lines.filter((line) => /Uncaught|UnhandledPromiseRejection/.test(line)).length,
  };
}
results.log_errors = levels;
check('no crash or unhandled rejection in any service', Object.values(levels).every((level) => level.crashes === 0), levels);
results.checks = checks;

await stopServices(Object.values(children));
const out = path.resolve('test-results/measurements.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
process.exit(checks.every((entry) => entry.ok) ? 0 : 1);
