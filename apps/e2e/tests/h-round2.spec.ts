import { CEMENT, expect, loginCentral, loginLegacy, resetDemo, sql, test, WEB } from './support';

const MESSAGE = 'Hej! Ring mig på 070-123 45 67. Vi behöver 20 säckar Byggcement 25kg och 2 pall gips 13mm 900x2400. Leverans tis 07:00.';

test.describe('Round 2: AI reads a pasted order, a person checks it', () => {
  test('proposes lines, ticks only the clear one, orders nothing until the customer places the order', async ({ as }) => {
    await resetDemo('S1');
    const buyer = await as('buyer.nordbygg');
    await buyer.goto(`${WEB}/customer/catalog`);
    await buyer.getByLabel(/Order text/).fill(MESSAGE);
    await buyer.getByRole('button', { name: 'Read with AI' }).click();

    await expect(buyer.getByText('“20 säckar Byggcement 25kg”')).toBeVisible();
    await expect(buyer.getByText(/1 contact detail\(s\) were removed/)).toBeVisible();
    await expect(buyer.getByText(/You wrote “pall”; this is sold per sheet/)).toBeVisible();
    await expect(buyer.getByLabel('Add line 1')).toBeChecked();
    await expect(buyer.getByLabel('Add line 2')).not.toBeChecked();
    expect(await sql('SE', 'SELECT 1 FROM orders')).toEqual([]);

    // The person decides what "2 pall" means here.
    await buyer.getByLabel('Quantity for line 2').fill('60');
    await buyer.getByLabel('Add line 2').check();
    await buyer.getByRole('button', { name: 'Add 2 checked lines to the order' }).click();
    await expect(buyer.getByText('2 lines added to your order')).toBeVisible();
    await expect(buyer.getByLabel(`Quantity of ${CEMENT}`)).toHaveValue('20');
    expect(await sql('SE', 'SELECT 1 FROM orders')).toEqual([]);

    await buyer.getByRole('button', { name: 'Place order' }).click();
    await expect(buyer).toHaveURL(/\/customer\/orders\/SE-ORD-\d+/);
    await expect(buyer.getByText('Awaiting approval').first()).toBeVisible();
    const items = await sql('SE', 'SELECT sku_id, quantity FROM order_items ORDER BY sku_id');
    expect(items).toEqual([
      { sku_id: 'SE-CEM-025', quantity: 20 },
      { sku_id: 'SE-GYP-13-2400', quantity: 60 },
    ]);
  });
});

test.describe('Round 2: circuit breaker for a silent store (Round 1, Risk 3)', () => {
  test('moves an unapproved part off a store whose server stopped reporting, then lets it back', async ({ as, blank }) => {
    await resetDemo('S1');
    const buyer = await as('buyer.nordbygg');
    await buyer.goto(`${WEB}/customer/catalog`);
    await buyer.getByLabel(`Quantity of ${CEMENT}`).fill('30');
    await buyer.getByRole('button', { name: 'Place order' }).click();
    await expect(buyer.getByRole('img', { name: '30 from SE-STORE-B' })).toBeVisible();

    const legacy = await blank();
    await loginLegacy(legacy);
    await legacy.getByRole('button', { name: 'Demo tools' }).click();
    const storeB = legacy.getByRole('row', { name: /Store B Mölndal/ }).filter({ has: legacy.getByRole('button', { name: 'Drop link' }) });
    await storeB.getByRole('button', { name: 'Drop link' }).click();
    await expect(legacy.getByText('Link down at Store B Mölndal. Its heartbeat has stopped.')).toBeVisible();

    // The test stack times out after 4 s of silence; the design value is 5 minutes.
    await expect(async () => {
      await buyer.reload();
      await expect(buyer.getByRole('img', { name: '30 from SE-HUB-01' })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 40_000 });
    expect((await sql('SIM', `SELECT reserved FROM inventory WHERE node_id = 'SE-STORE-B' AND sku_id = 'SE-CEM-025'`))[0]!.reserved).toBe(0);

    const admin = await as('admin.se');
    await admin.goto(`${WEB}/admin`);
    const row = admin.getByRole('row', { name: /SE-STORE-B/ });
    await expect(row.getByText('Offline: isolated')).toBeVisible({ timeout: 20_000 });

    await legacy.getByRole('row', { name: /Store B Mölndal/ }).getByRole('button', { name: 'Restore' }).click();
    await expect(row.getByText('Online')).toBeVisible({ timeout: 20_000 });

    const central = await blank();
    await loginCentral(central);
    await expect(central.getByText('Pilot go/no-go KPIs (Round 1)')).toBeVisible();
    await expect(central.getByText('Node tasks handled in OnSite')).toBeVisible();
  });
});
