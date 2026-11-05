// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App as CentralApp } from '../src/central/App';
import { App as LegacyApp } from '../src/legacy/App';
import { formatTime, stockholmInputToIso, stockholmNoonInput } from '../src/shared/format';
import { clearOrderKey, idempotencyKeyFor, type OrderBody } from '../src/web/orderDraft';
import { openStream, parseSseChunk } from '../src/web/sse';
import { LiveProvider, SessionProvider, useLive, useLiveData } from '../src/web/session';
import { loginAs } from './helpers';

describe('Swedish time', () => {
  it('reads an input as Swedish time, in both winter and summer, and across a change', () => {
    expect(stockholmInputToIso('2026-11-09T12:00')).toBe('2026-11-09T11:00:00.000Z');
    expect(stockholmInputToIso('2026-07-01T12:00')).toBe('2026-07-01T10:00:00.000Z');
    expect(stockholmInputToIso('2026-03-29T07:00')).toBe('2026-03-29T05:00:00.000Z');
    expect(stockholmInputToIso('2026-10-25T07:00')).toBe('2026-10-25T06:00:00.000Z');
  });

  it('shows what was entered', () => {
    expect(formatTime(stockholmInputToIso('2026-11-09T12:00'))).toBe('09 Nov, 12:00');
  });

  it('defaults to noon on a Swedish calendar day', () => {
    expect(stockholmNoonInput(2, new Date('2026-11-05T23:30:00Z'))).toBe('2026-11-08T12:00');
  });
});

describe('SSE parsing', () => {
  it('reads complete events, skips keep-alives, and keeps a partial block', () => {
    const { events, rest } = parseSseChunk(': connected\n\nevent: task.assigned\ndata: {"task_id":"a"}\n\nevent: order.up');
    expect(events).toEqual([{ type: 'task.assigned', data: { task_id: 'a' } }]);
    expect(rest).toBe('event: order.up');
  });

  it('ignores a malformed event', () => {
    expect(parseSseChunk('event: x\ndata: {nope\n\n').events).toEqual([]);
  });
});

function streamResponse(chunks: string[], close = true) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        if (close) controller.close();
      },
    }),
    { status: 200 },
  );
}

describe('the live stream', () => {
  it('sends the token in a header, not the URL', async () => {
    const fetchMock = vi.fn(async () => streamResponse([], false));
    vi.stubGlobal('fetch', fetchMock);
    const stop = openStream({ getToken: () => 'secret.jwt', onEvent: () => undefined, onConnected: () => undefined, onDisconnected: () => undefined, onUnauthorized: () => undefined });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/stream');
    expect(url).not.toContain('secret');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret.jwt');
    stop();
  });

  it('delivers events, reconnects after losing the connection, and tells the caller to reload', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse(['event: order.updated\ndata: {"order_id":"a"}\n\n']))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(streamResponse([], false));
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[] = [];
    const log: string[] = [];
    const stop = openStream({
      getToken: () => 't',
      delays: [1, 1],
      onEvent: (event) => seen.push(event.type),
      onConnected: () => log.push('connected'),
      onDisconnected: () => log.push('disconnected'),
      onUnauthorized: () => log.push('unauthorized'),
    });
    await waitFor(() => expect(log.filter((entry) => entry === 'connected')).toHaveLength(2));
    expect(seen).toEqual(['order.updated']);
    expect(log).toEqual(['connected', 'disconnected', 'disconnected', 'connected']);
    stop();
  });

  it('stops on 401 rather than retrying forever', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const onUnauthorized = vi.fn();
    openStream({ getToken: () => 't', delays: [1], onEvent: () => undefined, onConnected: () => undefined, onDisconnected: () => undefined, onUnauthorized });
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a live event makes the screen reload from REST, and shows a notification', async () => {
    loginAs('staff', { store_id: 'SE-STORE-B' });
    let loads = 0;
    let push: (text: string) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/v1/stream') {
          return new Response(new ReadableStream({ start(controller) { push = (text) => controller.enqueue(new TextEncoder().encode(text)); } }), { status: 200 });
        }
        loads += 1;
        return new Response(JSON.stringify({ loads }), { status: 200 });
      }),
    );
    function Screen() {
      const { connected, toasts } = useLive();
      const { data } = useLiveData(async () => {
        const response = await fetch('/api/v1/thing');
        return (await response.json()) as { loads: number };
      });
      return (
        <div>
          <span>{connected ? 'on' : 'off'}</span>
          <span data-testid="loads">{data?.loads}</span>
          {toasts.map((toast) => <span key={toast.id}>{toast.text}</span>)}
        </div>
      );
    }
    render(<SessionProvider><LiveProvider><Screen /></LiveProvider></SessionProvider>);
    await screen.findByText('on');
    await waitFor(() => expect(screen.getByTestId('loads')).not.toHaveTextContent(/^$/));
    const before = loads;
    await act(async () => {
      push('event: task.assigned\ndata: {"task_id":"a"}\n\n');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(loads).toBeGreaterThan(before);
    expect(await screen.findByText('New fulfilment task assigned')).toBeInTheDocument();
  });
});

describe('idempotency keys', () => {
  const body: OrderBody = { sales_store_id: 'B', site_id: 'S', requested_delivery_at: 'T', items: [{ sku_id: 'X', quantity: 1, unit: 'bag' }] };

  it('reuses the key for the same order, and changes it for a different one', () => {
    const key = idempotencyKeyFor(body);
    expect(idempotencyKeyFor({ ...body })).toBe(key);
    expect(idempotencyKeyFor({ ...body, items: [{ sku_id: 'X', quantity: 2, unit: 'bag' }] })).not.toBe(key);
  });

  it('gives a new key once the order has been answered, even for an identical order', () => {
    const key = idempotencyKeyFor(body);
    clearOrderKey();
    expect(idempotencyKeyFor(body)).not.toBe(key);
  });
});

function dashboardFetch(routes: Record<string, unknown | ((init?: RequestInit) => { status: number; body: unknown })>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      const route = routes[`${init?.method ?? 'GET'} ${url.split('?')[0]}`];
      if (route === undefined) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `No mock ${url}` } }), { status: 404 });
      if (typeof route === 'function') {
        const result = (route as (i?: RequestInit) => { status: number; body: unknown })(init);
        return new Response(JSON.stringify(result.body), { status: result.status });
      }
      return new Response(JSON.stringify(route), { status: 200 });
    }),
  );
  return calls;
}

describe('Sweden legacy dashboard', () => {
  const store = { store_id: 'SE-STORE-B', name: 'Store B Mölndal', type: 'STORE', status: 'ACTIVE' };
  const hub = { store_id: 'SE-HUB-01', name: 'Hub SE-01', type: 'HUB', status: 'ACTIVE' };
  const row = (node: string, onHand: number) => ({ node_id: node, sku_id: 'SE-CEM-025', on_hand: onHand, reserved: 0, source_unit: 'bag', version: 1, updated_at: '2026-11-05T10:00:00.000Z' });
  const product = { sku_id: 'SE-CEM-025', name: 'Portland cement', source_unit: 'bag', source_category: 'cement', source_description: 'Portland cement', unit_price_sek: 89, updated_at: '2026-11-05T10:00:00.000Z' };
  const routes = (connection: object = { state: 'DISCONNECTED', last_poll_at: null, onsite_process_reachable: false }, outage = false) => ({
    'GET /ui-api/me': { authenticated: true },
    'GET /ui-api/stores': [store, hub],
    'GET /ui-api/inventory': { items: [row('SE-STORE-B', 60), row('SE-HUB-01', 60)] },
    'GET /ui-api/products': { items: [product] },
    'GET /ui-api/connection': connection,
    'GET /ui-api/outage': { enabled: outage },
    'GET /ui-api/transactions': [{ entry_id: 1, node_id: 'SE-STORE-B', sku_id: 'SE-CEM-025', type: 'OUTBOUND', qty: 54, reference: 'abc', occurred_at: '2026-11-05T10:00:00.000Z' }],
  });

  it('asks for a login, and never calls with any token of its own', async () => {
    const calls = dashboardFetch({ 'GET /ui-api/me': { authenticated: false }, 'POST /ui-api/login': { authenticated: true }, ...{} });
    render(<LegacyApp />);
    await userEvent.type(await screen.findByLabelText('Dashboard password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(calls.some((call) => call.url === '/ui-api/login')).toBe(true));
    for (const call of calls) {
      expect(JSON.stringify(call.init?.headers ?? {})).not.toMatch(/authorization/i);
      expect(call.url.startsWith('/ui-api/')).toBe(true);
    }
  });

  it('shows stores, stock and a disconnected state with OnSite absent', async () => {
    dashboardFetch(routes());
    render(<LegacyApp />);
    expect(await screen.findByText('Store B Mölndal')).toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByText(/carries on working/)).toBeInTheDocument();
    expect(await screen.findByText('60')).toBeInTheDocument();
  });

  it('reflects connected and degraded states from the server', async () => {
    dashboardFetch(routes({ state: 'DEGRADED', last_poll_at: '2026-11-05T10:00:00.000Z', onsite_process_reachable: true }, true));
    render(<LegacyApp />);
    expect(await screen.findByText('Degraded')).toBeInTheDocument();
    expect(await screen.findByText('Simulated API outage is on')).toBeInTheDocument();
  });

  it('walks through the manual process with live stock, claiming no timings', async () => {
    dashboardFetch(routes());
    render(<LegacyApp />);
    await screen.findByText('Store B Mölndal');
    await userEvent.click(screen.getByRole('button', { name: 'Manual process' }));
    expect(screen.getByText(/makes no claim about time taken/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open next location' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open next location' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByText(/2 of 2 locations show this product/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText(/On paper there are enough for 100/)).toBeInTheDocument();
  });

  it('turns the outage on and off through the gateway', async () => {
    const calls = dashboardFetch({ ...routes(), 'POST /ui-api/outage': { enabled: true } });
    render(<LegacyApp />);
    await screen.findByText('Store B Mölndal');
    await userEvent.click(screen.getByRole('button', { name: 'Demo tools' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start outage' }));
    await waitFor(() => expect(calls.some((call) => call.url === '/ui-api/outage' && call.init?.method === 'POST')).toBe(true));
    expect(await screen.findByText('Outage is on.')).toBeInTheDocument();
  });

  it('requires typing RESET before a reset', async () => {
    const calls = dashboardFetch({ ...routes(), 'POST /ui-api/demo/reset': { scenario: 'S2' } });
    render(<LegacyApp />);
    await screen.findByText('Store B Mölndal');
    await userEvent.click(screen.getByRole('button', { name: 'Demo tools' }));
    const button = screen.getByRole('button', { name: 'Reset simulator' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Type RESET to confirm'), 'RESET');
    await userEvent.click(button);
    await waitFor(() => expect(calls.some((call) => call.url === '/ui-api/demo/reset')).toBe(true));
  });

  it('reports that OnSite is not running, and keeps working', async () => {
    dashboardFetch({ ...routes(), 'POST /ui-api/onsite/connector': () => ({ status: 502, body: { error: { code: 'ONSITE_UNREACHABLE', message: 'OnSite Local SE is not running.' } } }) });
    render(<LegacyApp />);
    await screen.findByText('Store B Mölndal');
    await userEvent.click(screen.getByRole('button', { name: 'Demo tools' }));
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Enable OnSite connection' }));
    expect(await screen.findByText('OnSite Local SE is not running.')).toBeInTheDocument();
  });
});

describe('Central dashboard', () => {
  const base = {
    data_is_simulated: true,
    ingestion_offline: false,
    refused_while_offline: 0,
    countries: [
      { origin_country: 'SE', deployed: true, state: 'ACTIVE', last_event_occurred_at: '2026-11-05T10:00:00.000Z', last_received_at: '2026-11-05T10:00:01.000Z', events_received: 12, duplicate_events_ignored: 2, out_of_order_events: 0 },
      { origin_country: 'DK', deployed: false, state: 'FUTURE_EXPANSION', last_event_occurred_at: null, last_received_at: null, events_received: 0, duplicate_events_ignored: 0, out_of_order_events: 0 },
    ],
    orders_by_status: [{ status: 'DELIVERED', count: 1 }],
    kpis: { total_orders: 3, at_risk_orders: 1, early_shortage_detected: 1, delivered_orders: 1, simulated_otif_rate: 1 },
    central_sync_lag_ms: { latest: 1800, p50: 900, p95: 2100, sampled_events: 12 },
  };
  const event = { event_id: 'e1', event_type: 'order.approved.v1', origin_country: 'SE', aggregate_id: 'SE-ORD-000001', aggregate_version: 3, occurred_at: '2026-11-05T10:00:00.000Z', applied_at: '2026-11-05T10:00:01.000Z', projected: true, sync_lag_ms: 900 };

  it('shows only received data, marks other countries as not deployed, and labels OTIF as simulated', async () => {
    dashboardFetch({ 'GET /auth/me': { authenticated: true }, 'GET /dashboard': base, 'GET /events': [event] });
    render(<CentralApp />);
    expect(await screen.findByText('Sweden')).toBeInTheDocument();
    expect(screen.getByText('Operational: receiving events')).toBeInTheDocument();
    expect(screen.getByText('Future expansion: not deployed')).toBeInTheDocument();
    expect(screen.getByText('Simulated OTIF')).toBeInTheDocument();
    expect(screen.getByText('Not a real-world result')).toBeInTheDocument();
    expect(screen.getByText('order.approved.v1')).toBeInTheDocument();
    expect(screen.getByText('1.8 s')).toBeInTheDocument();
    expect(screen.getByText(/Near-real-time synchronization/)).toBeInTheDocument();
  });

  it('shows the Round 1 pilot KPIs with their gates, and flags adoption below 90%', async () => {
    const pilot_kpis = {
      simulated_otif_rate: 1,
      delay_warnings_sent: 2,
      tasks_handled_in_onsite: 4,
      tasks_missed_deadline: 1,
      adoption_rate: 0.8,
      deliveries_confirmed_digitally: 3,
    };
    dashboardFetch({ 'GET /auth/me': { authenticated: true }, 'GET /dashboard': { ...base, pilot_kpis }, 'GET /events': [] });
    render(<CentralApp />);
    expect(await screen.findByText('Pilot go/no-go KPIs (Round 1)')).toBeInTheDocument();
    expect(screen.getAllByText('Simulated OTIF')).toHaveLength(1);
    expect(screen.getByText('Delay warnings sent before the customer asked').previousSibling).toHaveTextContent('2');
    const adoption = screen.getByText('Node tasks handled in OnSite').closest('.kpi');
    expect(adoption).toHaveTextContent('80%');
    expect(adoption).toHaveTextContent('4 of 5 decided before the deadline');
    expect(adoption).toHaveClass('warn');
  });

  it('simulates the outage and shows what it means', async () => {
    let offline = false;
    const calls = dashboardFetch({
      'GET /auth/me': { authenticated: true },
      'GET /dashboard': () => ({ status: 200, body: { ...base, ingestion_offline: offline, refused_while_offline: offline ? 4 : 0 } }),
      'GET /events': [],
      'POST /admin/offline': () => {
        offline = true;
        return { status: 200, body: { ingestion_offline: true } };
      },
    });
    render(<CentralApp />);
    await userEvent.click(await screen.findByRole('button', { name: 'Simulate Central outage' }));
    expect(await screen.findByText(/Simulated outage: Central is refusing/)).toBeInTheDocument();
    expect(screen.getByText(/Refused so far: 4/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore ingestion' })).toBeInTheDocument();
    expect(calls.some((call) => call.url === '/admin/offline')).toBe(true);
  });

  it('returns to login when the session is gone', async () => {
    dashboardFetch({ 'GET /auth/me': { authenticated: true }, 'GET /dashboard': () => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Log in first' } } }), 'GET /events': [] });
    render(<CentralApp />);
    expect(await screen.findByLabelText('Admin password')).toBeInTheDocument();
  });
});

