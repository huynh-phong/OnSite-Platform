import { expect, kpi, loginLegacy, placeOrder, resetDemo, sql, test, WEB } from './support';
import type { Page } from '@playwright/test';

async function createProduct(legacy: Page, sku: string, unit: string, description: string) {
  await legacy.getByRole('button', { name: 'Demo tools' }).click();
  await legacy.getByLabel('SKU', { exact: true }).fill(sku);
  await legacy.getByLabel('Unit (free text)').fill(unit);
  await legacy.getByLabel('Description').fill(description);
  await legacy.getByRole('button', { name: 'Create product' }).click();
  await expect(legacy.getByText(`Created ${sku}.`)).toBeVisible();
}

test.describe('Scenario C: S2 shortage at order time', () => {
  test('explains the shortage of 10, commits nothing, and offers no fake acceptance', async ({ as }) => {
    await resetDemo('S2');
    const buyer = await as('buyer.nordbygg');
    const orderId = await placeOrder(buyer, 100);
    await expect(buyer.getByText('Needs review').first()).toBeVisible();
    await expect(buyer.getByText('This order was not confirmed')).toBeVisible();
    await expect(buyer.getByText(/detected as you ordered/)).toBeVisible();
    const explanation = buyer.getByRole('alert').filter({ hasText: 'This order was not confirmed' });
    await expect(explanation).toContainText('At most 90 can be supplied now, which is 10 short');
    await expect(explanation).toContainText('place a new order');
    await expect(buyer.getByRole('button', { name: /accept/i })).toHaveCount(0);
    await expect(buyer.getByText('Waiting for each shipping node')).toHaveCount(0);

    expect(await sql('SIM', `SELECT 1 FROM reservations WHERE status = 'ACTIVE'`)).toEqual([]);
    expect(await sql('SE', 'SELECT 1 FROM fulfilment_tasks WHERE order_id = $1', [orderId])).toEqual([]);
    const stock = await sql('SIM', `SELECT coalesce(sum(reserved), 0)::int AS reserved FROM inventory WHERE sku_id = 'SE-CEM-025'`);
    expect(stock[0]!.reserved).toBe(0);

    // A smaller order within what is usable then goes through.
    const next = await placeOrder(buyer, 90);
    expect(next).not.toBe(orderId);
    await expect(buyer.getByRole('img', { name: '54 from SE-STORE-B, 36 from SE-HUB-01' })).toBeVisible();
  });
});

test.describe('Scenario D: AI normalization, on the mock provider', () => {
  test('nothing applies until a person decides, and an approved value is reused with no AI call', async ({ as, blank }) => {
    await resetDemo('S1');
    const legacy = await blank();
    await loginLegacy(legacy);
    await createProduct(legacy, 'SE-E2E-1', 'påsar', 'Byggcement Extra 35kg påsar');

    const staff = await as('staff.store-b');
    await staff.goto(`${WEB}/staff/reviews`);
    await expect(staff.getByText('AI suggests, humans approve.')).toBeVisible();
    await expect(staff.getByText('Mock provider')).toBeVisible();
    const unit = staff.locator('.card').filter({ hasText: '“påsar”' });
    const pack = staff.locator('.card').filter({ hasText: '“byggcement extra 35kg påsar”' });
    await expect(unit).toContainText('bag', { timeout: 30_000 });
    await expect(unit).toContainText('Waiting for a human');
    await expect(pack).toContainText('35', { timeout: 30_000 });

    // A suggestion alone changes nothing.
    const buyer = await as('buyer.nordbygg');
    await buyer.goto(`${WEB}/customer/catalog`);
    await expect(buyer.getByText('SE-E2E-1')).toHaveCount(0);
    expect(await sql('SE', `SELECT 1 FROM normalization_mappings WHERE raw_value = 'påsar'`)).toEqual([]);

    // One approved: still hidden, because the pack size is also mandatory.
    await unit.getByRole('button', { name: 'Approve suggestion' }).click();
    await expect(staff.locator('.card').filter({ hasText: '“påsar”' })).toHaveCount(0);
    await buyer.reload();
    await expect(buyer.getByText('Portland cement 25 kg bag')).toBeVisible();
    await expect(buyer.getByText('SE-E2E-1')).toHaveCount(0);

    // Correct the second by hand: now it can be ordered.
    await pack.getByRole('button', { name: 'Edit and approve' }).click();
    await pack.getByLabel('Correct value').fill('30');
    await pack.getByRole('button', { name: 'Save and approve' }).click();
    await expect(staff.locator('.card').filter({ hasText: '“byggcement extra 35kg påsar”' })).toHaveCount(0);
    await buyer.reload();
    await expect(buyer.getByText('SE-E2E-1')).toBeVisible();
    const stored = await sql('SE', `SELECT status, base_unit, pack_size_verified::float8 AS pack FROM products WHERE sku_id = 'SE-E2E-1'`);
    expect(stored[0]).toEqual({ status: 'ACTIVE', base_unit: 'bag', pack: 30 });

    await staff.getByRole('button', { name: 'Approved', exact: true }).click();
    await expect(staff.getByText('Decided by staff.store-b').first()).toBeVisible();
    await staff.getByRole('button', { name: 'Pending', exact: true }).click();

    // The same value again: no new AI call, and the reuse is counted.
    const calls = await kpi(staff, 'AI calls').textContent();
    const reused = Number(await kpi(staff, 'Reused without AI').textContent());
    await createProduct(legacy, 'SE-E2E-2', 'påsar', 'Byggcement utan vikt');
    await expect(async () => {
      await buyer.reload();
      await expect(buyer.getByText('SE-E2E-2')).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    await staff.reload();
    await expect(kpi(staff, 'AI calls')).toHaveText(calls!);
    expect(Number(await kpi(staff, 'Reused without AI').textContent())).toBeGreaterThan(reused);
    await expect(staff.locator('.card').filter({ hasText: 'SE-E2E-2' })).toHaveCount(0);
  });

  test('a rejected value keeps the product out of the catalog', async ({ as, blank }) => {
    await resetDemo('S1');
    const legacy = await blank();
    await loginLegacy(legacy);
    await createProduct(legacy, 'SE-E2E-3', 'skräpenhet', 'En produkt utan vikt');
    const staff = await as('staff.store-b');
    await staff.goto(`${WEB}/staff/reviews`);
    const row = staff.locator('.card').filter({ hasText: '“skräpenhet”' });
    await expect(row).toContainText('No suggestion', { timeout: 30_000 });
    await expect(row.getByRole('button', { name: 'Approve suggestion' })).toBeDisabled();
    await row.getByRole('button', { name: 'Reject' }).click();
    await expect(row).toHaveCount(0);
    const buyer = await as('buyer.nordbygg');
    await buyer.goto(`${WEB}/customer/catalog`);
    await expect(buyer.getByText('Portland cement 25 kg bag')).toBeVisible();
    await expect(buyer.getByText('SE-E2E-3')).toHaveCount(0);
  });
});
