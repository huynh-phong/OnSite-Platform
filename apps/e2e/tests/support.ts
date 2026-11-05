import { test as base, expect, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

export const env = JSON.parse(process.env.E2E_ENV ?? '{}') as Record<string, string>;
export const WEB = 'http://localhost:13000';
export const SIM = 'http://localhost:15000';
export const CENTRAL = 'http://localhost:16001';
export const LOCAL = 'http://localhost:14000';
export const CEMENT = 'Portland cement 25 kg bag';

export async function apiToken(user: string): Promise<string> {
  const response = await fetch(`${WEB}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: env.DEMO_PASSWORD }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Demo reset through the real admin API, then waits until the catalog is ready. */
export async function resetDemo(scenario: 'S1' | 'S2', connector: 'enabled' | 'disabled' = 'enabled') {
  const token = await apiToken('admin.se');
  const response = await fetch(`${WEB}/api/v1/admin/demo/reset`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ scenario, confirm: 'RESET', connector }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(((await response.json()) as { central: string }).central).toBe('reset');
  if (connector === 'disabled') return;
  await expect
    .poll(
      async () => {
        const products = await fetch(`${WEB}/api/v1/products`, { headers: { authorization: `Bearer ${await apiToken('buyer.nordbygg')}` } });
        const list = (await products.json()) as { availability: string }[];
        return list.length === 20 && list[0]?.availability === 'AVAILABLE';
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(database: 'SE' | 'SIM' | 'CENTRAL', text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: env[`${database}_DATABASE_URL`] });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

export async function loginWeb(page: Page, user: string) {
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(env.DEMO_PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).not.toHaveURL(/login/);
}

export async function loginLegacy(page: Page) {
  await page.goto(SIM);
  await page.getByLabel('Dashboard password').fill(env.SIM_DASHBOARD_PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Stores and hub' })).toBeVisible();
}

export async function loginCentral(page: Page) {
  await page.goto(CENTRAL);
  await page.getByLabel('Admin password').fill(env.CENTRAL_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Cross-country overview' })).toBeVisible();
}

export function kpi(page: Page, label: string) {
  return page.locator('.kpi').filter({ has: page.locator('.label', { hasText: label }) }).locator('.value');
}

export async function placeOrder(page: Page, quantity: number, options: { requested?: string; site?: RegExp } = {}) {
  await page.goto(`${WEB}/customer/catalog`);
  await page.getByLabel(`Quantity of ${CEMENT}`).fill(String(quantity));
  if (options.requested) await page.getByLabel('Requested delivery (Swedish time)').fill(options.requested);
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/customer\/orders\/SE-ORD-\d+/);
  await expect(page.getByRole('heading', { name: /^SE-ORD-\d+$/ })).toBeVisible();
  return (await page.getByRole('heading', { name: /^SE-ORD-\d+$/ }).textContent()) as string;
}

interface Fixtures {
  /** Opens a separate logged-in browser session. Any page error or console error fails the test. */
  as: (user: string) => Promise<Page>;
  blank: () => Promise<Page>;
  failures: string[];
}

const IGNORED_CONSOLE = /Failed to load resource/;

export const test = base.extend<Fixtures>({
  failures: async ({}, use) => {
    const failures: string[] = [];
    await use(failures);
    expect(failures, 'browser errors during the test').toEqual([]);
  },
  blank: async ({ browser, failures }, use) => {
    const contexts: Awaited<ReturnType<Browser['newContext']>>[] = [];
    await use(async () => {
      const context = await browser.newContext({ timezoneId: 'Asia/Ho_Chi_Minh', locale: 'en-GB', viewport: { width: 1280, height: 800 } });
      contexts.push(context);
      const page = await context.newPage();
      page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error' && !IGNORED_CONSOLE.test(message.text())) failures.push(`console: ${message.text()}`);
      });
      return page;
    });
    for (const context of contexts) await context.close();
  },
  as: async ({ blank }, use) => {
    await use(async (user) => {
      const page = await blank();
      await loginWeb(page, user);
      return page;
    });
  },
});

export { expect };
