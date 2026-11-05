import { apiToken, expect, kpi, loginCentral, loginLegacy, placeOrder, resetDemo, sql, test, WEB } from './support';
import type { Page } from '@playwright/test';

async function openTask(page: Page, orderId: string) {
  await page.goto(`${WEB}/staff`);
  await page.getByRole('link', { name: orderId }).first().click();
  await expect(page.getByRole('heading', { name: new RegExp(`^${orderId} at`) })).toBeVisible();
}

test.describe('Scenario B: S1 split order, all through the interface', () => {
  test.beforeEach(async () => {
    await resetDemo('S1');
  });

  test('order, two approvals, dispatch, delivery, ledger and Central', async ({ as, blank }) => {
    const staffB = await as('staff.store-b');
    const staffHub = await as('staff.hub-01');
    const buyer = await as('buyer.nordbygg');

    // The node's board is open before the order exists: the task must arrive by itself.
    await expect(staffB.getByRole('heading', { name: 'Tasks at SE-STORE-B' })).toBeVisible();
    await expect(staffB.getByText('No open tasks at this node')).toBeVisible();

    const orderId = await placeOrder(buyer, 100, { requested: '2031-01-15T12:00' });
    expect(orderId).toMatch(/^SE-ORD-\d{6}$/);
    await expect(buyer.getByText('Awaiting approval').first()).toBeVisible();
    await expect(buyer.getByRole('img', { name: '54 from SE-STORE-B, 46 from SE-HUB-01' })).toBeVisible();
    await expect(buyer.getByText('Covers the remaining 46')).toBeVisible();
    await expect(buyer.getByRole('row', { name: /SE-STORE-B Awaiting|SE-STORE-B Pending/ })).toHaveCount(1);
    await expect(buyer.getByRole('row', { name: /SE-HUB-01 Pending/ })).toHaveCount(1);

    // Live: the staff screen learned of it without a reload.
    await expect(staffB.getByText('New fulfilment task assigned')).toBeVisible();
    await expect(staffB.getByRole('link', { name: orderId })).toBeVisible();
    await expect(kpi(staffB, 'To approve')).toHaveText('1');

    // Store B: picking list, then approval.
    await openTask(staffB, orderId);
    await expect(staffB.getByText('Not a tax invoice')).toBeVisible();
    await expect(staffB.getByText('54 bag')).toBeVisible();
    await expect(staffB.getByText('Nordbygg AB')).toBeVisible();
    await expect(staffB.getByText(/Askim/)).toBeVisible();
    await expect(staffB.getByText('Approvals: 0 of 2 nodes')).toBeVisible();
    await staffB.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(staffB.getByText('Approved. The order is now: Awaiting approval.')).toBeVisible();
    await expect(staffB.getByText('Approvals: 1 of 2 nodes')).toBeVisible();
    await expect(staffB.getByRole('button', { name: 'Dispatch' })).toHaveCount(0);

    // The customer's open page still says waiting.
    await expect(buyer.getByText('Waiting for each shipping node')).toBeVisible();

    // The hub approves its own part.
    await openTask(staffHub, orderId);
    await expect(staffHub.getByText('46 bag')).toBeVisible();
    await staffHub.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(staffHub.getByText('Approved. The order is now: Approved.')).toBeVisible();

    // The customer sees it without reloading, through the live stream.
    await expect(buyer.getByRole('button', { name: 'Order confirmation' })).toBeVisible();
    await buyer.getByRole('button', { name: 'Order confirmation' }).click();
    await expect(buyer.getByRole('heading', { name: `Order confirmation ${orderId}` })).toBeVisible();
    await expect(buyer.getByText('Not a tax invoice')).toBeVisible();
    await expect(buyer.getByText(/From Store B Mölndal/)).toBeVisible();
    await expect(buyer.getByText(/From Hub SE-01/)).toBeVisible();
    await expect(kpi(buyer, 'Estimated delivery')).not.toHaveText('—');

    // Dispatch both.
    await staffB.reload();
    await staffB.getByRole('button', { name: 'Dispatch' }).click();
    await expect(staffB.getByText(/Dispatched.*The order is now: Dispatching/)).toBeVisible();
    await staffHub.reload();
    await staffHub.getByRole('button', { name: 'Dispatch' }).click();
    await expect(staffHub.getByText(/Dispatched.*The order is now: Dispatched/)).toBeVisible();

    // Delivery from both nodes.
    await expect(staffB.getByLabel(/Quantity delivered/)).toHaveValue('54');
    await staffB.getByRole('button', { name: 'Confirm delivery' }).click();
    await expect(staffB.getByText('Delivery recorded. The order is now: Dispatched.')).toBeVisible();
    await expect(staffHub.getByLabel(/Quantity delivered/)).toHaveValue('46');
    await staffHub.getByRole('button', { name: 'Confirm delivery' }).click();
    await expect(staffHub.getByText('Delivery recorded. The order is now: Delivered.')).toBeVisible();

    // The customer's result and history.
    await expect(buyer.getByText('Delivered on time and in full')).toBeVisible();
    for (const event of ['Submitted', 'Allocating', 'Awaiting approval', 'Approved', 'Dispatching', 'Dispatched', 'Delivered']) {
      await expect(buyer.locator('.timeline').getByText(event, { exact: true }).first()).toBeVisible();
    }

    // Closed tasks move to history.
    await staffB.goto(`${WEB}/staff/history`);
    await expect(staffB.getByRole('link', { name: orderId })).toBeVisible();

    // The source system's own ledger shows what really left, read from its own dashboard.
    const legacy = await blank();
    await loginLegacy(legacy);
    await legacy.getByRole('button', { name: 'Stock ledger' }).click();
    const outbound = legacy.locator('tbody tr').filter({ hasText: 'OUTBOUND' });
    await expect(outbound).toHaveCount(2);
    await expect(outbound.filter({ hasText: 'SE-STORE-B' })).toContainText('54');
    await expect(outbound.filter({ hasText: 'SE-HUB-01' })).toContainText('46');
    await legacy.getByRole('button', { name: 'Stores & stock' }).click();
    const cement = legacy.locator('tbody tr').filter({ hasText: 'SE-CEM-025' });
    // Store B is selected by default: 60 - 54 on hand, nothing reserved.
    await expect(cement.locator('td').nth(3)).toHaveText('6');
    await expect(cement.locator('td').nth(4)).toHaveText('0');

    // Central catches up on real events.
    const central = await blank();
    await loginCentral(central);
    await expect(central.getByText('order.delivered.v1')).toBeVisible({ timeout: 30_000 });
    await expect(kpi(central, 'Delivered')).toHaveText('1');
    await expect(kpi(central, 'Orders processed')).toHaveText('1');
    await expect(kpi(central, 'Simulated OTIF')).toHaveText('100%');
    await expect(central.getByRole('row', { name: /Sweden.*Operational/ })).toBeVisible();

    // And the systems agree.
    const local = await sql<{ version: number; status: string }>('SE', 'SELECT version, status FROM orders WHERE order_id = $1', [orderId]);
    await expect
      .poll(async () => sql<{ version: number; status: string }>('CENTRAL', 'SELECT version, status FROM order_projection WHERE order_id = $1', [orderId]), { timeout: 20_000 })
      .toEqual(local);
    expect(await sql('SIM', `SELECT 1 FROM reservations WHERE status = 'ACTIVE'`)).toEqual([]);
  });

  test('rejecting with no other source explains the result and leaves nothing held', async ({ as }) => {
    const buyer = await as('buyer.nordbygg');
    const orderId = await placeOrder(buyer, 100);
    const hub = await as('staff.hub-01');
    await openTask(hub, orderId);
    await hub.getByRole('button', { name: 'Reject' }).click();
    await expect(hub.getByRole('button', { name: 'Confirm rejection' })).toBeDisabled();
    await hub.getByLabel(/Why can this node/).fill('Forklift out of service');
    await hub.getByRole('button', { name: 'Confirm rejection' }).click();
    await expect(hub.getByText(/Rejected\. The stock was released.*Needs review/)).toBeVisible();
    await expect(buyer.getByText('This order was not confirmed')).toBeVisible();
    expect(await sql('SIM', `SELECT 1 FROM reservations WHERE status = 'ACTIVE'`)).toEqual([]);
  });

  test('a customer cancels and the stock goes back', async ({ as }) => {
    const buyer = await as('buyer.nordbygg');
    await placeOrder(buyer, 100);
    buyer.on('dialog', (dialog) => void dialog.accept());
    await buyer.getByRole('button', { name: 'Cancel order' }).click();
    await expect(buyer.getByText('Cancelled').first()).toBeVisible();
    await expect(buyer.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
    await expect.poll(async () => sql('SIM', `SELECT 1 FROM reservations WHERE status = 'ACTIVE'`)).toEqual([]);
  });

  test('an order with two products goes all the way through', async ({ as }) => {
    const buyer = await as('buyer.nordbygg');
    await buyer.goto(`${WEB}/customer/catalog`);
    await buyer.getByLabel('Quantity of Portland cement 25 kg bag').fill('10');
    await buyer.getByLabel('Quantity of Gypsum board 13 mm 900x2400').fill('5');
    await buyer.getByRole('button', { name: 'Place order' }).click();
    await expect(buyer.getByRole('heading', { name: /^SE-ORD-\d+$/ })).toBeVisible();
    const orderId = (await buyer.getByRole('heading', { name: /^SE-ORD-\d+$/ }).textContent()) as string;
    await expect(buyer.getByRole('cell', { name: 'SE-GYP-13-2400' }).first()).toBeVisible();

    const staff = await as('staff.store-b');
    await openTask(staff, orderId);
    await expect(staff.getByText('10 bag')).toBeVisible();
    await expect(staff.getByText('5 sheet')).toBeVisible();
    await staff.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(staff.getByText(/The order is now: Approved/)).toBeVisible();
    await staff.getByRole('button', { name: 'Dispatch' }).click();
    await expect(staff.getByText(/The order is now: Dispatched/)).toBeVisible();
    await expect(staff.getByLabel(/Quantity delivered/)).toHaveValue('15');
    await staff.getByLabel(/Quantity delivered/).fill('14');
    await expect(staff.getByText('This will mark the delivery as short.')).toBeVisible();
    await staff.getByLabel(/Quantity delivered/).fill('99');
    await expect(staff.getByRole('button', { name: 'Confirm delivery' })).toBeDisabled();
    await staff.getByLabel(/Quantity delivered/).fill('14');
    await staff.getByRole('button', { name: 'Confirm delivery' }).click();
    await expect(staff.getByText(/The order is now: Delivered/)).toBeVisible();
    await expect(buyer.getByText('Delivered, but late or short')).toBeVisible();
    const ledger = await sql<{ sku_id: string; qty: number }>('SIM', `SELECT sku_id, qty FROM stock_ledger WHERE type = 'OUTBOUND' ORDER BY sku_id`);
    expect(ledger).toEqual([{ sku_id: 'SE-CEM-025', qty: 10 }, { sku_id: 'SE-GYP-13-2400', qty: 5 }]);
  });

  test('a stale screen cannot overwrite a newer decision', async ({ as }) => {
    const buyer = await as('buyer.nordbygg');
    const orderId = await placeOrder(buyer, 10);
    const first = await as('staff.store-b');
    const second = await as('staff.store-b');
    await openTask(first, orderId);
    await openTask(second, orderId);
    const [staleTask] = await sql<{ task_id: string; version: number }>('SE', 'SELECT task_id, version FROM fulfilment_tasks WHERE order_id = $1', [orderId]);
    await first.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(first.getByText(/The order is now: Approved/)).toBeVisible();
    // The live update can reach the second screen at any moment, so its button may be gone before the click lands.
    const stale = second.getByRole('button', { name: 'Approve', exact: true });
    const clicked = await stale.click({ timeout: 1500 }).then(() => true, () => false);
    if (clicked) await expect(second.getByText('That did not go through').or(second.getByRole('button', { name: 'Dispatch' })).first()).toBeVisible();
    await expect(second.getByRole('button', { name: 'Dispatch' })).toBeVisible({ timeout: 30_000 });

    // Whatever the timing above, the server itself refuses the out-of-date version.
    const refused = await fetch(`${WEB}/api/v1/staff/tasks/${staleTask!.task_id}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await apiToken('staff.store-b')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: staleTask!.version }),
    });
    expect(refused.status).toBe(409);
    const events = await sql('SE', `SELECT 1 FROM order_events WHERE order_id = $1 AND type = 'task.approved'`, [orderId]);
    expect(events).toHaveLength(1);
  });

  test('a far site with an early deadline warns the customer and the node', async ({ as }) => {
    const buyer = await as('buyer.nordbygg');
    await buyer.goto(`${WEB}/customer/catalog`);
    await buyer.getByLabel('Quantity of Portland cement 25 kg bag').fill('5');
    await buyer.getByLabel('Construction site').selectOption({ label: 'Demo Site 2, Skövde' });
    await buyer.getByLabel('Requested delivery (Swedish time)').fill('2026-01-01T12:00');
    await buyer.getByRole('button', { name: 'Place order' }).click();
    await expect(buyer.getByText('This delivery may be late')).toBeVisible();
    // Which node is earliest for this far site depends on the time of day and the dispatch slots.
    const orderId = (await buyer.getByRole('heading', { name: /^SE-ORD-\d+$/ }).textContent()) as string;
    const [assigned] = await sql<{ node_id: string }>('SE', 'SELECT node_id FROM fulfilment_tasks WHERE order_id = $1', [orderId]);
    const staff = await as(assigned!.node_id === 'SE-HUB-01' ? 'staff.hub-01' : 'staff.store-b');
    await expect(staff.getByText('At risk').first()).toBeVisible();
    await expect(kpi(staff, 'With problems')).toHaveText('1');
  });
});
