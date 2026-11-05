import { CEMENT, expect, kpi, loginCentral, loginLegacy, placeOrder, resetDemo, test, WEB } from './support';

// Saves what real screens look like, to review layout by eye, and checks no page scrolls sideways.
const dir = 'test-results/screens';

test('key screens render without sideways scrolling, on desktop and on a phone', async ({ as, blank }) => {
  await resetDemo('S1');
  const buyer = await as('buyer.nordbygg');
  const orderId = await placeOrder(buyer, 100, { requested: '2031-01-15T12:00' });
  const staff = await as('staff.store-b');
  const admin = await as('admin.se');
  const legacy = await blank();
  await loginLegacy(legacy);
  const central = await blank();
  await loginCentral(central);
  await expect(kpi(central, 'Orders processed')).toHaveText('1', { timeout: 30_000 });

  const shots: [string, typeof buyer, string][] = [
    ['customer-home', buyer, `${WEB}/customer`],
    ['customer-catalog', buyer, `${WEB}/customer/catalog`],
    ['customer-order', buyer, `${WEB}/customer/orders/${orderId}`],
    ['staff-home', staff, `${WEB}/staff`],
    ['staff-reviews', staff, `${WEB}/staff/reviews`],
    ['admin-home', admin, `${WEB}/admin`],
    ['legacy-home', legacy, ''],
    ['central-home', central, ''],
  ];
  const overflowing: string[] = [];
  for (const [name, page, url] of shots) {
    if (url) await page.goto(url);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) overflowing.push(`${name} at ${width}px: ${overflow}px`);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  }
  expect(overflowing).toEqual([]);
  await buyer.setViewportSize({ width: 390, height: 800 });
  await buyer.goto(`${WEB}/customer/catalog`);
  await buyer.getByLabel(`Quantity of ${CEMENT}`).scrollIntoViewIfNeeded();
  await buyer.screenshot({ path: `${dir}/customer-catalog-phone.png` });
});
