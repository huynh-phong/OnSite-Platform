import { apiToken, expect, kpi, loginCentral, loginLegacy, placeOrder, resetDemo, sql, test, WEB } from './support';

test.describe('Scenario E: Central outage and recovery', () => {
  test('Local carries on, events wait, and Central catches up without double counting', async ({ as, blank }) => {
    await resetDemo('S1');
    const central = await blank();
    await loginCentral(central);
    const buyer = await as('buyer.nordbygg');
    const admin = await as('admin.se');

    const first = await placeOrder(buyer, 10);
    await expect(central.getByText(first).first()).toBeVisible({ timeout: 30_000 });
    await expect(kpi(central, 'Orders processed')).toHaveText('1');
    await expect(kpi(admin, 'Waiting to send')).toHaveText('0', { timeout: 30_000 });
    const lag = kpi(central, 'Latest');
    await expect(lag).toHaveText(/\d+(\.\d+)? (ms|s)/);

    await central.getByRole('button', { name: 'Simulate Central outage' }).click();
    await expect(central.getByText(/Simulated outage: Central is refusing/)).toBeVisible();
    await expect(central.getByRole('row', { name: /Sweden.*Ingestion offline/ })).toBeVisible();

    // Local completes a whole order while Central refuses everything.
    const second = await placeOrder(buyer, 10);
    await expect(buyer.getByText('Awaiting approval').first()).toBeVisible();
    const staff = await as('staff.store-b');
    await staff.getByRole('link', { name: second }).click();
    await staff.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(staff.getByText(/The order is now: Approved/)).toBeVisible();
    await staff.reload();
    await staff.getByRole('button', { name: 'Dispatch' }).click();
    await expect(staff.getByText(/The order is now: Dispatched/)).toBeVisible();
    await staff.getByRole('button', { name: 'Confirm delivery' }).click();
    await expect(staff.getByText(/The order is now: Delivered/)).toBeVisible();
    await expect(buyer.getByText('Delivered on time and in full')).toBeVisible();

    // Events pile up, and Central did not move.
    await expect.poll(async () => Number(await kpi(admin, 'Waiting to send').textContent()), { timeout: 30_000 }).toBeGreaterThan(5);
    await expect(kpi(central, 'Orders processed')).toHaveText('1');
    await expect(kpi(central, 'Delivered')).toHaveText('0');
    const refused = await sql('SE', 'SELECT max(non_retryable_failures) AS n FROM outbox_events');
    expect(Number(refused[0]!.n)).toBe(0);

    // Recovery. Retries back off, so this can take a while.
    await central.getByRole('button', { name: 'Restore ingestion' }).click();
    await expect(kpi(central, 'Orders processed')).toHaveText('2', { timeout: 90_000 });
    await expect(kpi(central, 'Delivered')).toHaveText('1', { timeout: 90_000 });
    await expect(kpi(admin, 'Waiting to send')).toHaveText('0', { timeout: 90_000 });

    const local = await sql('SE', 'SELECT order_id, version, status FROM orders ORDER BY order_id');
    expect(await sql('CENTRAL', 'SELECT order_id, version, status FROM order_projection ORDER BY order_id')).toEqual(local);
    const counts = await sql('CENTRAL', 'SELECT events_received::int AS received, duplicate_events_ignored::int AS duplicates FROM country_status');
    const events = await sql('SE', 'SELECT count(*)::int AS n FROM outbox_events');
    expect(counts[0]!.received).toBe(events[0]!.n);
    expect(counts[0]!.duplicates).toBe(0);
  });

  test('a redelivered or late event changes nothing', async ({ as, blank }) => {
    await resetDemo('S1');
    const buyer = await as('buyer.nordbygg');
    const orderId = await placeOrder(buyer, 10);
    const central = await blank();
    await loginCentral(central);
    await expect(kpi(central, 'Orders processed')).toHaveText('1', { timeout: 30_000 });
    await expect.poll(async () => (await sql('SE', `SELECT 1 FROM outbox_events WHERE status = 'PENDING'`)).length, { timeout: 30_000 }).toBe(0);
    const before = await sql('CENTRAL', 'SELECT version, status FROM order_projection WHERE order_id = $1', [orderId]);
    await sql('SE', `UPDATE outbox_events SET status = 'PENDING', next_attempt_at = now(), delivered_at = NULL`);
    await expect.poll(async () => (await sql('SE', `SELECT 1 FROM outbox_events WHERE status = 'PENDING'`)).length, { timeout: 30_000 }).toBe(0);
    expect(await sql('CENTRAL', 'SELECT version, status FROM order_projection WHERE order_id = $1', [orderId])).toEqual(before);
    await expect(kpi(central, 'Orders processed')).toHaveText('1');
    await expect(central.getByRole('row', { name: /Sweden/ })).not.toContainText(/^.*\b0\b.*\b0\b$/);
  });
});

test.describe('Scenario F: simulator outage and recovery', () => {
  test('refuses unsafe commitments, warns staff, and recovers by itself', async ({ as, blank }) => {
    await resetDemo('S1');
    const legacy = await blank();
    await loginLegacy(legacy);
    await expect(legacy.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
    const staff = await as('staff.store-b');
    const buyer = await as('buyer.nordbygg');

    await legacy.getByRole('button', { name: 'Demo tools' }).click();
    await legacy.getByRole('button', { name: 'Start outage' }).click();
    await expect(legacy.getByText('Simulated API outage is on')).toBeVisible();
    await expect(legacy.getByText('Degraded', { exact: true })).toBeVisible({ timeout: 30_000 });
    // The legacy system's own screens keep working.
    await legacy.getByRole('button', { name: 'Stores & stock' }).click();
    await expect(legacy.getByRole('heading', { name: 'Stock at Store B Mölndal' })).toBeVisible();

    await expect(staff.getByText(/no stock will be committed/)).toBeVisible({ timeout: 30_000 });
    await expect(staff.getByText('Source: down')).toBeVisible({ timeout: 30_000 });

    await buyer.goto(`${WEB}/customer/catalog`);
    await expect(buyer.getByText('Stock cannot be confirmed right now')).toBeVisible();
    await expect(buyer.getByText('Cannot confirm').first()).toBeVisible();
    await placeOrder(buyer, 10);
    await expect(buyer.getByText('This order was not confirmed')).toBeVisible();
    await expect(buyer.getByText(/source system could not be reached/)).toBeVisible();
    await expect(buyer.getByText(/You asked for/)).toBeVisible();
    expect(await sql('SIM', `SELECT 1 FROM reservations WHERE status = 'ACTIVE'`)).toEqual([]);

    await legacy.getByRole('button', { name: 'Demo tools' }).click();
    await legacy.getByRole('button', { name: 'Recover' }).click();
    await expect(legacy.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(staff.getByText(/no stock will be committed/)).toHaveCount(0, { timeout: 30_000 });
    await expect(staff.getByText('Source: ok')).toBeVisible({ timeout: 30_000 });

    await placeOrder(buyer, 10);
    await expect(buyer.getByText('Waiting for each shipping node')).toBeVisible();
    await expect(buyer.getByRole('img', { name: '10 from SE-STORE-B' })).toBeVisible();
  });

  test('connector off and on: disconnected, then connected, using the real admin API', async ({ blank, as }) => {
    await resetDemo('S1', 'disabled');
    const legacy = await blank();
    await loginLegacy(legacy);
    await expect(legacy.getByText('Disconnected', { exact: true })).toBeVisible({ timeout: 45_000 });
    await legacy.getByRole('button', { name: 'Demo tools' }).click();
    await expect(legacy.getByRole('button', { name: 'Enable OnSite connection' })).toBeDisabled();
    await legacy.getByLabel('OnSite admin').fill('admin.se');
    await legacy.getByLabel('Password').fill('wrong');
    await legacy.getByRole('button', { name: 'Enable OnSite connection' }).click();
    await expect(legacy.getByText('OnSite refused that admin login')).toBeVisible();
    await legacy.getByLabel('Password').fill(process.env.E2E_ENV ? JSON.parse(process.env.E2E_ENV).DEMO_PASSWORD : '');
    await legacy.getByRole('button', { name: 'Enable OnSite connection' }).click();
    await expect(legacy.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 });

    const admin = await as('admin.se');
    await expect(admin.getByText('Enabled', { exact: true })).toBeVisible();
    await expect(kpi(admin, 'Inventory feed verified')).toHaveText(/ago/);
    expect(await apiToken('admin.se')).toBeTruthy();
  });
});

test.describe('Legacy dashboard: before OnSite', () => {
  test('walks through the manual process with live stock, and shows catalog and ledger', async ({ blank }) => {
    await resetDemo('S1');
    const legacy = await blank();
    await loginLegacy(legacy);
    await expect(legacy.locator('.store-tile')).toHaveCount(11);
    await legacy.getByRole('button', { name: /Hub SE-01/ }).click();
    await expect(legacy.getByRole('heading', { name: /Stock at Hub SE-01/ })).toBeVisible();

    await legacy.getByRole('button', { name: 'Manual process' }).click();
    await expect(legacy.getByText(/makes no claim about time taken/)).toBeVisible();
    for (let i = 0; i < 11; i += 1) await legacy.getByRole('button', { name: 'Open next location' }).click();
    await expect(legacy.getByText('11 of 11 locations opened')).toBeVisible();
    await legacy.getByRole('button', { name: 'Next step' }).click();
    await expect(legacy.getByText('2 of 11 locations show this product')).toBeVisible();
    await legacy.getByRole('button', { name: 'Next step' }).click();
    await expect(legacy.getByText('On paper there are enough for 100')).toBeVisible();
    await legacy.getByRole('button', { name: 'Next step' }).click();
    await expect(legacy.getByText(/Phone each chosen store/)).toBeVisible();

    await legacy.getByRole('button', { name: 'Product catalog' }).click();
    await expect(legacy.getByText('Byggcement Std 25kg säck')).toBeVisible();
    await legacy.getByRole('button', { name: 'Stock ledger' }).click();
    await expect(legacy.getByText('No movements yet.')).toBeVisible();
    await legacy.getByRole('button', { name: 'Demo tools' }).click();
    await legacy.getByRole('button', { name: 'Receive', exact: true }).click();
    await expect(legacy.getByText('Received 40 at SE-STORE-B.')).toBeVisible();
    await legacy.getByRole('button', { name: 'Stock ledger' }).click();
    await expect(legacy.locator('tbody tr').filter({ hasText: 'INBOUND' })).toHaveCount(1);
  });
});

test.describe('Demo reset through the interface', () => {
  test('needs typing RESET, and gives the same result each time', async ({ as }) => {
    const admin = await as('admin.se');
    const buyer = await as('buyer.nordbygg');
    for (const [scenario, expected] of [
      ['S2', 'This order was not confirmed'],
      ['S1', 'Waiting for each shipping node'],
      ['S1', 'Waiting for each shipping node'],
    ] as const) {
      await admin.goto(`${WEB}/admin`);
      const button = admin.getByRole('button', { name: 'Reset all demo data' });
      await expect(button).toBeDisabled();
      await admin.getByLabel('Scenario').selectOption(scenario);
      await admin.getByLabel('Type RESET to confirm').fill('RESET');
      await button.click();
      await expect(admin.getByText(`Reset to ${scenario}. Connection on. Central: reset.`)).toBeVisible();
      expect(await sql('SE', 'SELECT 1 FROM orders')).toEqual([]);
      expect(await sql('CENTRAL', 'SELECT 1 FROM order_projection')).toEqual([]);
      expect(await sql('SIM', `SELECT 1 FROM reservations`)).toEqual([]);
      await expect
        .poll(async () => {
          await buyer.goto(`${WEB}/customer/catalog`);
          return buyer.getByRole('cell', { name: /Portland cement 25 kg bag/ }).isVisible();
        }, { timeout: 30_000 })
        .toBe(true);
      const orderId = await placeOrder(buyer, 100);
      expect(orderId).toBe('SE-ORD-000001');
      await expect(buyer.getByText(expected)).toBeVisible();
    }
  });
});
