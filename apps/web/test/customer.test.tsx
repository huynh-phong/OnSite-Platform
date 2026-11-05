import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { baseRoutes, cement, loginAs, mockApi, order, renderAt } from './helpers';

describe('login and access', () => {
  it('logs in with the real API call and goes to the area for the role', async () => {
    const calls = mockApi({
      ...baseRoutes,
      'POST /auth/login': { access_token: 'abc.def.ghi', expires_in: 3600, user_id: 'buyer.nordbygg', role: 'customer', store_id: null, customer_id: 'C' },
    });
    renderAt('/login');
    await userEvent.type(screen.getByLabelText('Username'), 'buyer.nordbygg');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(calls.find((call) => call.url.endsWith('/auth/login'))?.body).toEqual({ username: 'buyer.nordbygg', password: 'pw' });
    // The token goes in a header, never in a URL.
    await waitFor(() => expect(calls.some((call) => call.url === '/api/v1/orders')).toBe(true));
    expect(calls.every((call) => !call.url.includes('abc.def.ghi'))).toBe(true);
    expect(calls.find((call) => call.url === '/api/v1/orders')?.headers.authorization).toBe('Bearer abc.def.ghi');
  });

  it('shows a clear message for a wrong password', async () => {
    mockApi({ 'POST /auth/login': () => ({ status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'x', request_id: 'r' } } }) });
    renderAt('/login');
    await userEvent.type(screen.getByLabelText('Username'), 'a');
    await userEvent.type(screen.getByLabelText('Password'), 'b');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument();
  });

  it('sends someone who is not logged in to the login page', async () => {
    mockApi({});
    renderAt('/customer/orders');
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
  });

  it('logs out and clears the session when the server says the token has expired', async () => {
    loginAs('customer');
    mockApi({ ...baseRoutes, 'GET /orders': () => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x', request_id: 'r' } } }) });
    renderAt('/customer/orders');
    expect(await screen.findByText(/session has expired/)).toBeInTheDocument();
    expect(sessionStorage.getItem('onsite.session')).toBeNull();
  });

  it('does not use an expired stored session', async () => {
    sessionStorage.setItem('onsite.session', JSON.stringify({ token: 't', role: 'customer', user_id: 'u', expires_at: Date.now() - 1000 }));
    mockApi({});
    renderAt('/customer');
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
  });

  it('logs out on request', async () => {
    loginAs('customer');
    mockApi(baseRoutes);
    renderAt('/customer');
    await userEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(sessionStorage.getItem('onsite.session')).toBeNull();
  });

  it('shows navigation for the role, and keeps a role out of other areas', async () => {
    loginAs('customer');
    mockApi(baseRoutes);
    renderAt('/staff');
    expect(await screen.findByText(/This area is not for your account/)).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByText('My orders')).toBeInTheDocument();
    expect(within(nav).queryByText('AI review')).not.toBeInTheDocument();
  });
});

describe('catalog', () => {
  const other = { ...cement, sku_id: 'SE-TIM-1', name: 'Structural timber', category: 'timber', base_unit: 'm', availability: 'UNAVAILABLE' };

  it('lists products with availability, and filters by search and category', async () => {
    loginAs('customer');
    mockApi({ ...baseRoutes, 'GET /products': [cement, other] });
    renderAt('/customer/catalog');
    expect(await screen.findByText('Portland cement 25 kg bag')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Out of stock')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Search products'), 'timber');
    expect(screen.queryByText('Portland cement 25 kg bag')).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Search products'));
    await userEvent.selectOptions(screen.getByLabelText('Category'), 'cement');
    expect(screen.queryByText('Structural timber')).not.toBeInTheDocument();
    expect(screen.getByText('Portland cement 25 kg bag')).toBeInTheDocument();
  });

  it('warns when stock cannot be confirmed', async () => {
    loginAs('customer');
    mockApi({
      ...baseRoutes,
      'GET /products': [{ ...cement, availability: 'UNKNOWN' }],
      'GET /system/status': { inventory_trusted: false, stale_reason: 'LAST_SYNC_FAILED', last_successful_sync_at: null, verified_age_s: 90, stale_after_s: 60, connector_enabled: true, source_reachable: false },
    });
    renderAt('/customer/catalog');
    expect(await screen.findByText('Cannot confirm')).toBeInTheDocument();
    expect(await screen.findByText('Stock cannot be confirmed right now')).toBeInTheDocument();
  });
});

describe('placing an order', () => {
  const fill = async (quantity = '100') => {
    const input = await screen.findByLabelText('Quantity of Portland cement 25 kg bag');
    await userEvent.type(input, quantity);
    await screen.findByRole('option', { name: 'Demo Site 1, Askim' });
  };

  it('sends the order with an idempotency key, and shows what the server confirmed', async () => {
    loginAs('customer');
    const calls = mockApi({
      ...baseRoutes,
      'POST /orders': () => ({ status: 201, body: order() }),
      'GET /orders/SE-ORD-000001': order(),
    });
    renderAt('/customer/catalog');
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));

    expect(await screen.findByRole('heading', { name: 'SE-ORD-000001' })).toBeInTheDocument();
    const post = calls.find((call) => call.method === 'POST' && call.url.endsWith('/orders'))!;
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post.body).toMatchObject({
      sales_store_id: 'SE-STORE-B',
      site_id: 'SE-SITE-001',
      items: [{ sku_id: 'SE-CEM-025', quantity: 100, unit: 'bag' }],
    });
    // S1, as confirmed: both nodes, their quantities, and why.
    const breakdown = screen.getByRole('img', { name: '54 from SE-STORE-B, 46 from SE-HUB-01' });
    expect(breakdown).toBeInTheDocument();
    expect(screen.getByText(/Covers the remaining 46/)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for each shipping node to approve/)).toBeInTheDocument();
  });

  it('reuses the key when retrying after a lost connection, so no second order can appear', async () => {
    loginAs('customer');
    let attempts = 0;
    const calls = mockApi({
      ...baseRoutes,
      'POST /orders': () => {
        attempts += 1;
        return attempts === 1 ? undefined : { status: 201, body: order() };
      },
      'GET /orders/SE-ORD-000001': order(),
    });
    renderAt('/customer/catalog');
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText(/safe to try again/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByRole('heading', { name: 'SE-ORD-000001' });
    const posts = calls.filter((call) => call.method === 'POST' && call.url.endsWith('/orders'));
    expect(posts).toHaveLength(2);
    expect(posts[0]!.headers['idempotency-key']).toBe(posts[1]!.headers['idempotency-key']);
  });

  it('uses a new key once the order changes', async () => {
    loginAs('customer');
    const calls = mockApi({ ...baseRoutes, 'POST /orders': () => undefined });
    renderAt('/customer/catalog');
    await fill('10');
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
    await screen.findByText(/safe to try again/);
    await userEvent.type(screen.getByLabelText('Quantity of Portland cement 25 kg bag'), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'POST').length).toBe(2));
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts[0]!.headers['idempotency-key']).not.toBe(posts[1]!.headers['idempotency-key']);
  });

  it('cannot be submitted twice while one is in flight', async () => {
    loginAs('customer');
    let release: (value: Response) => void = () => undefined;
    const calls = mockApi(baseRoutes);
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push({ url: String(input), method: 'POST', headers: {}, body: undefined });
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return original(input, init);
    });
    renderAt('/customer/catalog');
    await fill();
    const button = screen.getByRole('button', { name: 'Place order' });
    await userEvent.dblClick(button);
    expect(await screen.findByRole('button', { name: /Checking stock/ })).toBeDisabled();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    release(new Response('{}', { status: 500 }));
  });

  it('needs at least one product', async () => {
    loginAs('customer');
    mockApi(baseRoutes);
    renderAt('/customer/catalog');
    await screen.findByText('Portland cement 25 kg bag');
    expect(screen.getByRole('button', { name: 'Place order' })).toBeDisabled();
  });

  it('shows an API refusal, and does not pretend the order exists', async () => {
    loginAs('customer');
    mockApi({ ...baseRoutes, 'POST /orders': () => ({ status: 422, body: { error: { code: 'PRODUCT_NOT_AVAILABLE', message: 'Product SE-CEM-025 is not available', request_id: 'r' } } }) });
    renderAt('/customer/catalog');
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Place order' }));
    expect(await screen.findByText('Product SE-CEM-025 is not available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place order' })).toBeEnabled();
  });
});

describe('tracking an order', () => {
  it('S2: explains the shortage of 10, offers no fake acceptance, and points to a new order', async () => {
    loginAs('customer');
    mockApi({
      ...baseRoutes,
      'GET /orders/SE-ORD-000002': order({
        order_id: 'SE-ORD-000002',
        status: 'NEEDS_REVIEW',
        review_reason: 'INSUFFICIENT_STOCK',
        fulfillable_qty: 90,
        early_shortage_detected: true,
        allocations: [],
        shipments: [],
        eta: null,
      }),
    });
    renderAt('/customer/orders/SE-ORD-000002');
    expect(await screen.findByText('This order was not confirmed')).toBeInTheDocument();
    expect(screen.getByText(/detected as you ordered/)).toBeInTheDocument();
    expect(screen.getByText('90')).toBeInTheDocument();
    expect(screen.getByText(/which is 10 short/)).toBeInTheDocument();
    expect(screen.getByText(/place a new order/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /accept/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Waiting for each shipping node/)).not.toBeInTheDocument();
  });

  it('shows the at-risk warning and the estimate', async () => {
    loginAs('customer');
    mockApi({ ...baseRoutes, 'GET /orders/SE-ORD-000001': order({ at_risk: true, at_risk_reason: 'The shipment from SE-HUB-01 is estimated after the requested time' }) });
    renderAt('/customer/orders/SE-ORD-000001');
    expect(await screen.findByText('This delivery may be late')).toBeInTheDocument();
    expect(screen.getByText(/estimated after the requested time/)).toBeInTheDocument();
  });

  it('warns about at-risk orders on the overview', async () => {
    loginAs('customer');
    mockApi({ ...baseRoutes, 'GET /orders': [order({ at_risk: true })] });
    renderAt('/customer');
    expect(await screen.findByText('SE-ORD-000001 may arrive late')).toBeInTheDocument();
  });

  it('cancels with the current version, then shows the state from the server', async () => {
    loginAs('customer');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let cancelled = false;
    const calls = mockApi({
      ...baseRoutes,
      'GET /orders/SE-ORD-000001': () => ({ body: order(cancelled ? { status: 'CANCELLED', allocations: [], shipments: [] } : {}) }),
      'POST /orders/SE-ORD-000001/cancel': () => {
        cancelled = true;
        return { body: order({ status: 'CANCELLED' }) };
      },
    });
    renderAt('/customer/orders/SE-ORD-000001');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ version: 5 });
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
  });

  it('offers cancelling only while a customer may', async () => {
    loginAs('customer');
    mockApi({ ...baseRoutes, 'GET /orders/SE-ORD-000001': order({ status: 'APPROVED' }) });
    renderAt('/customer/orders/SE-ORD-000001');
    await screen.findByRole('heading', { name: 'SE-ORD-000001' });
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Order confirmation' })).toBeInTheDocument();
  });

  it('shows the order confirmation, labelled as not a tax invoice', async () => {
    loginAs('customer');
    mockApi({
      ...baseRoutes,
      'GET /orders/SE-ORD-000001': order({ status: 'APPROVED' }),
      'GET /orders/SE-ORD-000001/confirmation': {
        document_type: 'order_confirmation',
        not_a_tax_invoice: true,
        order_id: 'SE-ORD-000001',
        customer_company: 'Nordbygg AB',
        sales_store: { store_id: 'SE-STORE-B', name: 'Store B' },
        site_id: 'SE-SITE-001',
        site_address: 'Demo Site 1, Askim',
        requested_delivery_at: '2026-11-12T11:00:00.000Z',
        order_status: 'APPROVED',
        eta: null,
        shipments: [],
      },
    });
    renderAt('/customer/orders/SE-ORD-000001');
    await userEvent.click(await screen.findByRole('button', { name: 'Order confirmation' }));
    expect(await screen.findByText(/Not a tax invoice/)).toBeInTheDocument();
  });

  it('shows a late or short delivery honestly', async () => {
    loginAs('customer');
    mockApi({ ...baseRoutes, 'GET /orders/SE-ORD-000001': order({ status: 'DELIVERED', otif: false, delivered_at: '2026-11-06T10:00:00.000Z' }) });
    renderAt('/customer/orders/SE-ORD-000001');
    expect(await screen.findByText('Delivered, but late or short')).toBeInTheDocument();
  });

  it('shows a refusal instead of an empty page', async () => {
    loginAs('customer');
    mockApi({ ...baseRoutes, 'GET /orders/SE-ORD-000009': () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'x', request_id: 'r' } } }) });
    renderAt('/customer/orders/SE-ORD-000009');
    expect(await screen.findByText(/You do not have access/)).toBeInTheDocument();
  });
});
