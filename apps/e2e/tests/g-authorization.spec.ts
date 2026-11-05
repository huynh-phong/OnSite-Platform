import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { apiToken, CENTRAL, env, expect, LOCAL, loginCentral, loginLegacy, loginWeb, placeOrder, resetDemo, SIM, sql, test, WEB } from './support';

const api = (url: string, token: string | null, method = 'GET', body?: unknown) =>
  fetch(`${WEB}/api/v1${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

function signJwt(claims: object, secret: string) {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const content = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`;
}

test.describe('Scenario G: authorization', () => {
  test.beforeEach(async () => {
    await resetDemo('S1');
  });

  test('customers cannot see each other, in the interface or directly', async ({ as, blank }) => {
    const buyer = await as('buyer.nordbygg');
    const orderId = await placeOrder(buyer, 5);

    const seal = (plain: string, table: string, rowId: string, field: string) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(env.SE_DATA_KEY!, 'base64'), nonce);
      cipher.setAAD(Buffer.from(`SE|${table}|${rowId}|${field}`));
      return [Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]), nonce, cipher.getAuthTag()];
    };
    await sql('SE', `INSERT INTO customers (customer_id, company_name, contact_enc, contact_nonce, contact_tag, key_id) VALUES ('SE-CUST-900', 'Other AB', $1, $2, $3, 'se-key-v1')`, seal('{}', 'customers', 'SE-CUST-900', 'contact_enc'));
    await sql('SE', `INSERT INTO sites (site_id, customer_id, lat, lng, address_enc, address_nonce, address_tag, key_id) VALUES ('SE-SITE-900', 'SE-CUST-900', 57.6, 11.9, $1, $2, $3, 'se-key-v1')`, seal('Another Test Site', 'sites', 'SE-SITE-900', 'address_enc'));
    const passwordHash = (await sql<{ password_hash: string }>('SE', `SELECT password_hash FROM users WHERE user_id = 'buyer.nordbygg'`))[0]!.password_hash;
    await sql('SE', `INSERT INTO users (user_id, password_hash, role, country, customer_id) VALUES ('buyer.other', $1, 'customer', 'SE', 'SE-CUST-900')`, [passwordHash]);

    const other = await blank();
    await loginWeb(other, 'buyer.other');
    await other.goto(`${WEB}/customer/orders/${orderId}`);
    await expect(other.getByText('This order could not be loaded')).toBeVisible();
    await other.goto(`${WEB}/customer/orders`);
    await expect(other.getByText('No orders yet.')).toBeVisible();

    const token = await apiToken('buyer.other');
    expect((await api(`/orders/${orderId}`, token)).status).toBe(403);
    expect((await api(`/orders/${orderId}/confirmation`, token)).status).toBe(403);
    expect((await api(`/orders/${orderId}/cancel`, token, 'POST', {})).status).toBe(403);
    expect(await (await api('/orders', token)).json()).toEqual([]);
    const audit = await sql('SE', `SELECT 1 FROM audit_logs WHERE actor = 'buyer.other' AND result = '403'`);
    expect(audit.length).toBeGreaterThanOrEqual(3);
  });

  test('Store B staff cannot act on or read the hub task', async ({ as }) => {
    const buyer = await as('buyer.nordbygg');
    const orderId = await placeOrder(buyer, 100);
    const [hubTask] = await sql<{ task_id: string; version: number }>('SE', `SELECT task_id, version FROM fulfilment_tasks WHERE order_id = $1 AND node_id = 'SE-HUB-01'`, [orderId]);
    const staff = await as('staff.store-b');
    await staff.goto(`${WEB}/staff/tasks/${hubTask!.task_id}`);
    await expect(staff.getByText('This task belongs to another node')).toBeVisible();
    await expect(staff.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

    await staff.goto(`${WEB}/staff`);
    await expect(staff.locator('tbody tr')).toHaveCount(1);

    const token = await apiToken('staff.store-b');
    for (const [action, body] of [
      ['approve', { version: hubTask!.version }],
      ['reject', { version: hubTask!.version, reason: 'x' }],
      ['dispatch', { version: hubTask!.version }],
      ['deliver', { version: hubTask!.version, delivered_qty: 1 }],
    ] as const) {
      expect((await api(`/staff/tasks/${hubTask!.task_id}/${action}`, token, 'POST', body)).status, action).toBe(403);
    }
    expect((await api(`/staff/tasks/${hubTask!.task_id}/picklist`, token)).status).toBe(403);
    expect(await sql('SE', `SELECT status FROM fulfilment_tasks WHERE task_id = $1`, [hubTask!.task_id])).toEqual([{ status: 'PENDING_APPROVAL' }]);
    expect((await sql('SE', `SELECT 1 FROM audit_logs WHERE actor = 'staff.store-b' AND result = '403'`)).length).toBeGreaterThanOrEqual(5);
    // Client-supplied scope is ignored.
    const list = (await (await api('/staff/tasks?store_id=SE-HUB-01&node_id=SE-HUB-01', token)).json()) as { node_id: string }[];
    expect(list.every((task) => task.node_id === 'SE-STORE-B')).toBe(true);
  });

  test('roles cannot reach admin or other areas, by screen or by API', async ({ as }) => {
    const buyer = await as('buyer.nordbygg');
    await buyer.goto(`${WEB}/admin`);
    await expect(buyer.getByText('This area is not for your account')).toBeVisible();
    await expect(buyer.getByRole('button', { name: 'Reset all demo data' })).toHaveCount(0);
    await buyer.goto(`${WEB}/staff`);
    await expect(buyer.getByText('This area is not for your account')).toBeVisible();

    const staff = await as('staff.store-b');
    await staff.goto(`${WEB}/admin`);
    await expect(staff.getByText('This area is not for your account')).toBeVisible();

    for (const user of ['buyer.nordbygg', 'staff.store-b']) {
      const token = await apiToken(user);
      expect((await api('/metrics', token)).status, user).toBe(403);
      expect((await api('/admin/connector/disable', token, 'POST')).status, user).toBe(403);
      expect((await api('/admin/demo/reset', token, 'POST', { scenario: 'S1', confirm: 'RESET' })).status, user).toBe(403);
    }
    expect((await api('/orders', await apiToken('staff.store-b'), 'POST', {})).status).toBe(403);
    expect((await api('/staff/tasks', await apiToken('buyer.nordbygg'))).status).toBe(403);
  });

  test('invalid, forged, expired and foreign-country tokens are refused', async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: 'admin.se', role: 'admin', country: 'SE', iat: now - 100 };
    const secret = env.SE_JWT_SECRET!;
    const cases: [string, string | null, number][] = [
      ['no token', null, 401],
      ['garbage', 'not.a.token', 401],
      ['expired', signJwt({ ...claims, exp: now - 10 }, secret), 401],
      ['wrong key', signJwt({ ...claims, exp: now + 3600 }, 'x'.repeat(64)), 401],
      ['other country', signJwt({ ...claims, country: 'DK', exp: now + 3600 }, secret), 403],
    ];
    for (const [name, token, status] of cases) {
      expect((await api('/metrics', token)).status, name).toBe(status);
    }
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ ...claims, exp: now + 3600 })).toString('base64url')}.`;
    expect((await api('/metrics', none)).status).toBe(401);
    expect((await fetch(`${WEB}/api/v1/stream`)).status).toBe(401);
    // A valid token in a URL is refused by the web server, so none reaches a log or history.
    const token = await apiToken('admin.se');
    expect((await fetch(`${WEB}/api/v1/stream?token=${token}`)).status).toBe(400);
  });

  test('protected dashboards and service APIs refuse the unauthenticated', async () => {
    for (const [method, url] of [
      ['GET', `${SIM}/legacy/stores`],
      ['POST', `${SIM}/legacy/admin/outage`],
      ['POST', `${SIM}/legacy/admin/reset`],
      ['GET', `${SIM}/ui-api/stores`],
      ['POST', `${SIM}/ui-api/outage`],
      ['POST', `${SIM}/ui-api/demo/reset`],
      ['POST', `${CENTRAL}/ingest/events`],
      ['GET', `${CENTRAL}/dashboard`],
      ['GET', `${CENTRAL}/events`],
      ['POST', `${CENTRAL}/admin/offline`],
      ['POST', `${CENTRAL}/admin/reset`],
    ] as const) {
      const response = await fetch(url, { method });
      expect(response.status, `${method} ${url}`).toBe(401);
    }
    // No cross-origin opening anywhere.
    for (const url of [`${WEB}/api/v1/health`, `${LOCAL}/api/v1/health`, `${SIM}/health`, `${CENTRAL}/health`]) {
      const response = await fetch(url, { headers: { origin: 'https://evil.example' } });
      expect(response.headers.get('access-control-allow-origin'), url).toBeNull();
    }
  });

  test('no service credential reaches a browser, in pages, traffic or storage, or the service logs', async ({ blank }) => {
    const secrets = [env.SIMULATOR_SERVICE_TOKEN, env.SE_CENTRAL_TOKEN, env.SE_JWT_SECRET, env.SE_DATA_KEY].filter(Boolean) as string[];
    const seen: string[] = [];
    const watch = async (page: Awaited<ReturnType<typeof blank>>) => {
      page.on('response', async (response) => {
        try {
          seen.push(response.url(), JSON.stringify(await response.allHeaders()), await response.text());
        } catch {
          // Streams and redirects have no readable body.
        }
      });
      page.on('request', (request) => seen.push(request.url(), JSON.stringify(request.headers())));
    };

    const web = await blank();
    await watch(web);
    await loginWeb(web, 'admin.se');
    await expect(web.getByRole('heading', { name: 'Operations' })).toBeVisible();
    await web.waitForTimeout(1500);

    const legacy = await blank();
    await watch(legacy);
    await loginLegacy(legacy);
    await legacy.getByRole('button', { name: 'Demo tools' }).click();
    await legacy.waitForTimeout(1500);

    const central = await blank();
    await watch(central);
    await loginCentral(central);
    await central.waitForTimeout(1500);

    expect(seen.length).toBeGreaterThan(20);
    const everything = seen.join('\n');
    for (const secret of secrets) expect(everything.includes(secret), 'a service credential appeared in the browser').toBe(false);
    // The JWT itself must never be in a URL.
    const urls = seen.filter((entry) => /^https?:/.test(entry));
    expect(urls.some((url) => /eyJ[a-zA-Z0-9_-]{10,}\./.test(url))).toBe(false);

    const dir = path.resolve(process.cwd(), 'test-results/service-logs');
    const allSecrets = [...secrets, env.DEMO_PASSWORD!, env.SIM_DASHBOARD_PASSWORD!, env.CENTRAL_ADMIN_PASSWORD!];
    for (const log of ['web', 'local-se', 'simulator', 'central']) {
      const content = readFileSync(path.join(dir, `${log}.log`), 'utf8');
      expect(content.length, log).toBeGreaterThan(0);
      for (const secret of allSecrets) expect(content.includes(secret), `${log}.log`).toBe(false);
      expect(/eyJ[a-zA-Z0-9_-]{10,}\.eyJ/.test(content), `${log}.log holds a token`).toBe(false);
      expect(/Askim|Skövde/.test(content), `${log}.log holds an address`).toBe(false);
    }
  });

  test('sensitive fields are ciphertext at rest', async () => {
    const rows = await sql<{ raw: string }>('SE', `SELECT encode(address_enc, 'escape') AS raw FROM sites UNION ALL SELECT encode(contact_enc, 'escape') FROM customers`);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) expect(row.raw).not.toMatch(/Askim|Skövde|Demo|nordbygg/i);
  });
});
