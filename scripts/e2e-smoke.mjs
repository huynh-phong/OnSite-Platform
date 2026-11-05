#!/usr/bin/env node
// Black-box check of the running stack over HTTP, with real processes and real worker timing.
// Usage: node scripts/e2e-smoke.mjs   (reads .env; expects a freshly reset S1 stack)
// Overrides: LOCAL_SE_URL, SIMULATOR_URL, SMOKE_LOG_FILES (comma-separated logs to scan for secrets)
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(path.join(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);
// Through the web server, as a browser would. Everything below therefore also tests the proxy.
const LOCAL = process.env.LOCAL_SE_URL ?? 'http://localhost:3000';
const CENTRAL = process.env.CENTRAL_URL ?? 'http://localhost:6001';
const SIM = process.env.SIMULATOR_URL ?? 'http://localhost:5000';
const simHeaders = { authorization: `Bearer ${env.SIMULATOR_SERVICE_TOKEN}`, 'content-type': 'application/json' };

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  }
}
async function call(method, url, { token, body, headers } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}
const local = (method, url, options) => call(method, `${LOCAL}/api/v1${url}`, options);
const sim = (method, url, body) => call(method, `${SIM}${url}`, { headers: simHeaders, ...(body === undefined ? {} : { body }) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(name, condition, timeoutMs = 45_000) {
  const start = Date.now();
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${name}`);
    await sleep(500);
  }
}
const login = async (username) => {
  const response = await local('POST', '/auth/login', { body: { username, password: env.DEMO_PASSWORD } });
  if (response.status !== 200) throw new Error(`Login failed for ${username}: ${response.status}`);
  return response.body.access_token;
};

console.log('Health');
const health = await local('GET', '/health');
check('Local SE, DB and simulator are up; Central configured', health.body.status === 'ok' && health.body.central === 'configured', health.body);
check('Swagger is served on the services', (await call('GET', 'http://localhost:4000/docs/json')).status === 200 && (await call('GET', `${SIM}/docs/json`)).status === 200 && (await call('GET', `${CENTRAL}/docs/json`)).status === 200);
check('The web app and both dashboards are served', ((await call('GET', `${LOCAL}/customer`)).body + '').includes('root') && ((await call('GET', `${SIM}/`)).body + '').includes('root') && ((await call('GET', `${CENTRAL}/`)).body + '').includes('root'));

const [buyer, staffB, staffHub, admin] = await Promise.all(['buyer.nordbygg', 'staff.store-b', 'staff.hub-01', 'admin.se'].map(login));

console.log('The sync worker fills the catalog');
const products = await until('products to sync', async () => {
  const response = await local('GET', '/products', { token: buyer });
  return response.body.length === 20 && response.body[0].availability === 'AVAILABLE' ? response.body : null;
});
check('20 ACTIVE products, the AI demo product hidden', products.length === 20 && !products.some((p) => p.sku_id === 'SE-CEM-STD-025'));

console.log('S1: the whole flow');
const requested = new Date(Date.now() + 7 * 86400_000).toISOString();
const orderBody = {
  sales_store_id: 'SE-STORE-B',
  site_id: 'SE-SITE-001',
  requested_delivery_at: requested,
  items: [{ sku_id: 'SE-CEM-025', quantity: 100, unit: 'bag' }],
};
const key = randomUUID();
const created = await local('POST', '/orders', { token: buyer, headers: { 'idempotency-key': key }, body: orderBody });
check('order is AWAITING_APPROVAL', created.body.status === 'AWAITING_APPROVAL', created.body);
check(
  'split 54 (B) + 46 (hub)',
  JSON.stringify(created.body.allocations?.map((a) => [a.node_id, a.quantity])) === JSON.stringify([['SE-STORE-B', 54], ['SE-HUB-01', 46]]),
  created.body.allocations,
);
const retry = await local('POST', '/orders', { token: buyer, headers: { 'idempotency-key': key }, body: orderBody });
check('the same Idempotency-Key returns the same order', retry.body.order_id === created.body.order_id);
const orderId = created.body.order_id;

const taskOf = async (token) => (await local('GET', `/staff/tasks`, { token })).body.find((task) => task.order_id === orderId);
let taskB = await taskOf(staffB);
let taskHub = await taskOf(staffHub);
check('each node sees only its own task', taskB.node_id === 'SE-STORE-B' && taskHub.node_id === 'SE-HUB-01');
const forbidden = await local('POST', `/staff/tasks/${taskHub.task_id}/approve`, { token: staffB, body: { version: taskHub.version } });
check('Store B staff get 403 on the hub task', forbidden.status === 403);

const step = async (token, task, action, extra = {}) => {
  const response = await local('POST', `/staff/tasks/${task.task_id}/${action}`, { token, body: { version: task.version, ...extra } });
  if (response.status !== 200) throw new Error(`${action} failed: ${JSON.stringify(response.body)}`);
  return { ...task, version: response.body.version, order_status: response.body.order_status };
};
taskB = await step(staffB, taskB, 'approve');
check('one approval leaves the order waiting', taskB.order_status === 'AWAITING_APPROVAL');
taskHub = await step(staffHub, taskHub, 'approve');
check('all approvals make it APPROVED', taskHub.order_status === 'APPROVED');
const confirmation = await local('GET', `/orders/${orderId}/confirmation`, { token: buyer });
check('order confirmation is available, not a tax invoice', confirmation.body.not_a_tax_invoice === true && confirmation.body.shipments?.length === 2);
const picklist = await local('GET', `/staff/tasks/${taskB.task_id}/picklist`, { token: staffB });
check('picking list has the decrypted address', picklist.body.document_type === 'picking_list' && Boolean(picklist.body.site_address));

taskB = await step(staffB, taskB, 'dispatch');
check('first dispatch: DISPATCHING', taskB.order_status === 'DISPATCHING');
taskHub = await step(staffHub, taskHub, 'dispatch');
check('second dispatch: DISPATCHED', taskHub.order_status === 'DISPATCHED');
taskB = await step(staffB, taskB, 'deliver', { delivered_qty: 54 });
taskHub = await step(staffHub, taskHub, 'deliver', { delivered_qty: 46 });
check('delivered', taskHub.order_status === 'DELIVERED');
const done = await local('GET', `/orders/${orderId}`, { token: buyer });
check('OTIF is true', done.body.otif === true, done.body.otif);
const ledger = await sim('GET', '/legacy/transactions?sku_id=SE-CEM-025&limit=100');
const outbound = ledger.body.filter((row) => row.type === 'OUTBOUND');
check('the simulator ledger has the OUTBOUND rows', outbound.length === 2 && outbound.reduce((sum, row) => sum + row.qty, 0) === 100, outbound);

console.log('The AI flow');
const sku = `SE-SMOKE-${Date.now()}`;
const unit = `knippe${Date.now()}`;
await sim('POST', '/legacy/products', {
  sku_id: sku,
  name: 'Smoke product',
  source_unit: unit,
  source_category: 'cement',
  source_description: 'Smoke product without weight',
  unit_price_sek: 10,
});
const review = await until('a review to appear', async () => {
  const response = await local('GET', '/staff/normalization-reviews?status=PENDING', { token: staffB });
  return response.body.find((candidate) => candidate.raw_value === unit && candidate.ai_status !== 'QUEUED' && candidate.ai_status !== 'IN_PROGRESS');
});
check('new product is pending review, hidden from customers', !(await local('GET', '/products', { token: buyer })).body.some((p) => p.sku_id === sku));
const approved = await local('POST', `/staff/normalization-reviews/${review.review_id}/approve`, { token: staffB, body: { value: 'piece' } });
check('approval succeeds', approved.status === 200, approved.body);
check('product is ACTIVE for customers', (await local('GET', '/products', { token: buyer })).body.some((p) => p.sku_id === sku));
const before = (await local('GET', '/metrics', { token: admin })).body.ai;
await sim('POST', '/legacy/products', {
  sku_id: `${sku}-2`,
  name: 'Smoke product 2',
  source_unit: unit,
  source_category: 'cement',
  source_description: 'Smoke product two without weight',
  unit_price_sek: 10,
});
await until('the second product to sync', async () => (await local('GET', '/products', { token: buyer })).body.some((p) => p.sku_id === `${sku}-2`));
const after = (await local('GET', '/metrics', { token: admin })).body.ai;
check('the same value costs no AI call and is a cache hit', after.ai_calls_total === before.ai_calls_total && after.normalization_cache_hits_total > before.normalization_cache_hits_total, { before, after });

console.log('Outage and recovery, without restarting anything');
await sim('POST', '/legacy/admin/outage', { enabled: true });
await until('health to show the outage', async () => (await local('GET', '/health')).body.simulator === 'down');
await until('stock to stop being trusted', async () => (await local('GET', '/metrics', { token: admin })).body.inventory.trusted === false);
const duringOutage = await local('POST', '/orders', { token: buyer, headers: { 'idempotency-key': randomUUID() }, body: { ...orderBody, items: [{ sku_id: 'SE-CEM-040', quantity: 5, unit: 'bag' }] } });
check('a new order goes to NEEDS_REVIEW (SOURCE_UNAVAILABLE)', duringOutage.body.status === 'NEEDS_REVIEW' && duringOutage.body.review_reason === 'SOURCE_UNAVAILABLE', duringOutage.body);
await sim('POST', '/legacy/admin/outage', { enabled: false });
await until('stock to be trusted again', async () => (await local('GET', '/metrics', { token: admin })).body.inventory.trusted === true);
const afterOutage = await local('POST', '/orders', { token: buyer, headers: { 'idempotency-key': randomUUID() }, body: { ...orderBody, items: [{ sku_id: 'SE-CEM-040', quantity: 5, unit: 'bag' }] } });
check('orders work again after recovery', afterOutage.body.status === 'AWAITING_APPROVAL', afterOutage.body);

console.log('SSE');
const controller = new AbortController();
const refusedInUrl = await fetch(`${LOCAL}/api/v1/stream?token=${staffB}`);
check('the web proxy refuses a token in a URL', refusedInUrl.status === 400);
const stream = await fetch(`${LOCAL}/api/v1/stream`, { headers: { authorization: `Bearer ${staffB}` }, signal: controller.signal });
check('the stream opens as text/event-stream', stream.headers.get('content-type')?.includes('text/event-stream'));
const reader = stream.body.getReader();
const seen = (async () => {
  let text = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done: ended } = await reader.read();
    if (ended) return text;
    text += decoder.decode(value);
    if (text.includes('event: task.assigned')) return text;
  }
})();
await local('POST', '/orders', { token: buyer, headers: { 'idempotency-key': randomUUID() }, body: { ...orderBody, items: [{ sku_id: 'SE-CEM-CON-025', quantity: 5, unit: 'bag' }] } });
const received = await Promise.race([seen, sleep(5000).then(() => '')]);
check('a task.assigned event arrives', received.includes('event: task.assigned'));
controller.abort();

console.log('Central');
const centralLogin = await fetch(`${CENTRAL}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: env.CENTRAL_ADMIN_PASSWORD }) });
const cookie = (centralLogin.headers.get('set-cookie') ?? '').split(';')[0];
const centralGet = async (url) => (await fetch(`${CENTRAL}${url}`, { headers: { cookie } })).json();
const centralPost = (url, body) => fetch(`${CENTRAL}${url}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const projected = await until('the delivered order to reach Central', async () => {
  const dashboard = await centralGet('/dashboard');
  return dashboard.kpis.delivered_orders >= 1 ? dashboard : null;
});
check('Central received the delivered order, with its OTIF', projected.kpis.simulated_otif_rate === 1, projected.kpis);
check('Central measured a sync lag', projected.central_sync_lag_ms.latest !== null);
const before2 = (await local('GET', '/metrics', { token: admin })).body.business.orders_total;
await until('the outbox to drain', async () => (await local('GET', '/metrics', { token: admin })).body.outbox.outbox_pending === 0);
const receivedBefore = (await centralGet('/dashboard')).countries[0].events_received;

console.log('Central outage and recovery');
await centralPost('/admin/offline', { enabled: true });
const whileDown = await local('POST', '/orders', { token: buyer, headers: { 'idempotency-key': randomUUID() }, body: { ...orderBody, items: [{ sku_id: 'SE-CEM-040', quantity: 2, unit: 'bag' }] } });
check('Local still takes orders with Central down', whileDown.body.status === 'AWAITING_APPROVAL', whileDown.body);
await sleep(3000);
const stuck = (await local('GET', '/metrics', { token: admin })).body.outbox.outbox_pending;
check('events wait in the outbox', stuck > 0, stuck);
await centralPost('/admin/offline', { enabled: false });
await until('the outbox to drain after recovery', async () => (await local('GET', '/metrics', { token: admin })).body.outbox.outbox_pending === 0, 90_000);
const caughtUp = await centralGet('/dashboard');
check('Central caught up on the new order', caughtUp.kpis.total_orders === before2 + 1, { before2, kpis: caughtUp.kpis });
check('nothing was counted twice', caughtUp.countries[0].events_received >= receivedBefore + stuck && caughtUp.countries[0].duplicate_events_ignored === 0, caughtUp.countries[0]);

console.log('S2 and repeatable reset');
const reset = (scenario) => local('POST', '/admin/demo/reset', { token: admin, body: { scenario, confirm: 'RESET' } });
const resetS2 = await reset('S2');
check('the demo reset works', resetS2.status === 200 && resetS2.body.central === 'reset', resetS2.body);
await until('the catalog after the reset', async () => (await local('GET', '/products', { token: buyer })).body.length === 20);
const shortage = await local('POST', '/orders', { token: buyer, headers: { 'idempotency-key': randomUUID() }, body: orderBody });
check('S2: 100 bags goes to NEEDS_REVIEW with 90 fulfillable', shortage.body.status === 'NEEDS_REVIEW' && shortage.body.fulfillable_qty === 90 && shortage.body.order_id === 'SE-ORD-000001', shortage.body);
check('S2: nothing is allocated', shortage.body.allocations?.length === 0);
const resetS1 = await reset('S1');
await until('the catalog after the second reset', async () => (await local('GET', '/products', { token: buyer })).body.length === 20);
const again = await local('POST', '/orders', { token: buyer, headers: { 'idempotency-key': randomUUID() }, body: orderBody });
check(
  'S1 after S2: the same 54 + 46 split, and numbering starts over',
  resetS1.status === 200 && again.body.order_id === 'SE-ORD-000001' && JSON.stringify(again.body.allocations?.map((a) => a.quantity)) === '[54,46]',
  again.body,
);
await local('POST', `/orders/${again.body.order_id}/cancel`, { token: buyer });

const logFiles = (process.env.SMOKE_LOG_FILES ?? '').split(',').filter(Boolean);
if (logFiles.length) {
  console.log('Secrets in logs');
  const secrets = [env.DEMO_PASSWORD, env.SIMULATOR_SERVICE_TOKEN, env.SE_JWT_SECRET, env.SE_DATA_KEY, env.GEMINI_API_KEY, env.SE_CENTRAL_TOKEN, env.CENTRAL_ADMIN_PASSWORD, env.SIM_DASHBOARD_PASSWORD, staffB, buyer, admin].filter(Boolean);
  for (const file of logFiles) {
    const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
    check(`${path.basename(file)} has log lines with request ids`, content.includes('request_id'));
    check(`${path.basename(file)} holds no secret, token or address`, !secrets.some((secret) => content.includes(secret)) && !/Askim|Skövde/.test(content));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
