import { CEMENT, env, expect, kpi, placeOrder, resetDemo, test, WEB } from './support';

test.describe('Scenario A: customer login and catalog', () => {
  test.beforeEach(async () => {
    await resetDemo('S1');
  });

  test('logs in, sees real data, searches and filters, and refreshing keeps the session', async ({ as }) => {
    const page = await as('buyer.nordbygg');
    await expect(page).toHaveURL(/\/customer$/);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByText('SE-SITE-001')).toBeVisible();
    await expect(page.getByText('Askim')).toBeVisible();

    await page.getByRole('link', { name: 'Catalog & order' }).click();
    await expect(page.getByText(CEMENT)).toBeVisible();
    // 20 approved products; the one awaiting review is not offered.
    await expect(page.locator('tbody tr')).toHaveCount(20);
    await expect(page.getByText('Byggcement Std')).toHaveCount(0);

    await page.getByLabel('Search products').fill('gypsum');
    await expect(page.locator('tbody tr')).toHaveCount(5);
    await expect(page.getByText(CEMENT)).toHaveCount(0);
    await page.getByLabel('Search products').fill('');
    await page.getByLabel('Category').selectOption('cement');
    await expect(page.locator('tbody tr')).toHaveCount(5);
    await page.getByLabel('Search products').fill('no such product');
    await expect(page.getByText('No products match.')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Catalog & order' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  });

  test('builds an order: quantity, total, site, then removes it', async ({ as }) => {
    const page = await as('buyer.nordbygg');
    await page.goto(`${WEB}/customer/catalog`);
    const place = page.getByRole('button', { name: 'Place order' });
    await expect(place).toBeDisabled();
    await page.getByLabel(`Quantity of ${CEMENT}`).fill('10');
    await expect(page.getByText('Simulated total')).toBeVisible();
    await expect(page.getByLabel('Construction site').locator('option')).toHaveCount(2);
    await expect(place).toBeEnabled();
    await page.getByRole('button', { name: `Remove ${CEMENT}` }).click();
    await expect(place).toBeDisabled();
  });

  test('a delivery time entered in Vietnam stays the Swedish time that was entered', async ({ as }) => {
    const page = await as('buyer.nordbygg');
    await placeOrder(page, 5, { requested: '2031-01-15T12:00' });
    await expect(kpi(page, 'You asked for delivery')).toHaveText('15 Jan, 12:00');
    await page.goto(`${WEB}/customer/catalog`);
    await placeOrder(page, 5, { requested: '2031-07-15T12:00' });
    await expect(kpi(page, 'You asked for delivery')).toHaveText('15 Jul, 12:00');
  });

  test('wrong password, logging out and an expired session are all handled', async ({ blank, as }) => {
    const anonymous = await blank();
    await anonymous.goto(`${WEB}/customer/orders`);
    await expect(anonymous).toHaveURL(/login/);
    await anonymous.getByLabel('Username').fill('buyer.nordbygg');
    await anonymous.getByLabel('Password').fill('wrong-password');
    await anonymous.getByRole('button', { name: 'Log in' }).click();
    await expect(anonymous.getByText('Wrong username or password.')).toBeVisible();
    expect(env.DEMO_PASSWORD).toBeTruthy();

    const page = await as('buyer.nordbygg');
    await page.evaluate(() => {
      const session = JSON.parse(sessionStorage.getItem('onsite.session')!);
      sessionStorage.setItem('onsite.session', JSON.stringify({ ...session, token: 'expired.or.invalid' }));
    });
    await page.goto(`${WEB}/customer/orders`);
    await expect(page.getByText('Your session has expired')).toBeVisible();
    await expect(page).toHaveURL(/login/);

    const again = await as('buyer.nordbygg');
    await again.getByRole('button', { name: 'Log out' }).click();
    await expect(again).toHaveURL(/login/);
    await again.goto(`${WEB}/customer`);
    await expect(again).toHaveURL(/login/);
  });
});
