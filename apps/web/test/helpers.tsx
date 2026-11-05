import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { configureApi } from '../src/web/api';
import { App } from '../src/web/App';
import { SessionProvider, type Role } from '../src/web/session';

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: MockCall) => { status?: number; body?: unknown } | undefined;

/** A fake of the real API's responses at the network boundary, so that the real client code runs. */
export function mockApi(routes: Record<string, Handler | object>) {
  const calls: MockCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call: MockCall = { url, method, headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      if (url === '/api/v1/stream') {
        // A stream that stays open and says nothing.
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
      const path = url.replace('/api/v1', '');
      const route = routes[`${method} ${path}`] ?? routes[`${method} ${path.split('?')[0]}`];
      if (route === undefined) return json(404, { error: { code: 'NOT_FOUND', message: `No mock: ${method} ${path}`, request_id: 'r' } });
      const result = typeof route === 'function' ? (route as Handler)(call) : { body: route };
      if (!result) throw new TypeError('network down');
      return json(result.status ?? 200, result.body ?? {});
    }),
  );
  return calls;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function loginAs(role: Role, extra: { store_id?: string; customer_id?: string } = {}) {
  const session = {
    token: `token-for-${role}`,
    user_id: `${role}.user`,
    role,
    store_id: extra.store_id ?? null,
    customer_id: extra.customer_id ?? null,
    expires_at: Date.now() + 3600_000,
  };
  sessionStorage.setItem('onsite.session', JSON.stringify(session));
  configureApi({ token: session.token });
  return session;
}

export function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <App />
      </SessionProvider>
    </MemoryRouter>,
  );
}

export const cement = {
  sku_id: 'SE-CEM-025',
  name: 'Portland cement 25 kg bag',
  category: 'cement',
  base_unit: 'bag',
  pack_size_kg: 25,
  unit_price_sek: 89,
  status: 'ACTIVE',
  availability: 'AVAILABLE',
  inventory_as_of: '2026-11-05T10:00:00.000Z',
};

export const baseRoutes = {
  'GET /stores': [{ store_id: 'SE-STORE-B', name: 'Store B Mölndal', type: 'STORE', status: 'ACTIVE' }],
  'GET /sites': [{ site_id: 'SE-SITE-001', customer_id: 'C', address: 'Demo Site 1, Askim' }],
  'GET /products': [cement],
  'GET /orders': [],
  'GET /system/status': { inventory_trusted: true, stale_reason: null, last_successful_sync_at: null, verified_age_s: 3, stale_after_s: 60, connector_enabled: true, source_reachable: true },
  'GET /health': { status: 'ok', db: 'ok', simulator: 'ok', central: 'configured' },
};

export function order(overrides: object = {}) {
  return {
    order_id: 'SE-ORD-000001',
    status: 'AWAITING_APPROVAL',
    review_reason: null,
    fulfillable_qty: null,
    early_shortage_detected: false,
    sales_store_id: 'SE-STORE-B',
    site_id: 'SE-SITE-001',
    requested_delivery_at: '2026-11-12T11:00:00.000Z',
    inventory_as_of: '2026-11-05T10:00:00.000Z',
    reservation_expires_at: '2026-11-05T10:30:00.000Z',
    eta: '2026-11-06T10:00:00.000Z',
    eta_is_estimate: true,
    at_risk: false,
    at_risk_reason: null,
    approved_at: null,
    delivered_at: null,
    otif: null,
    version: 5,
    created_at: '2026-11-05T10:00:00.000Z',
    items: [{ sku_id: 'SE-CEM-025', quantity: 100, unit: 'bag', unit_price_sek: 89 }],
    allocations: [
      { node_id: 'SE-STORE-B', sku_id: 'SE-CEM-025', quantity: 54, reason: 'Earliest ETA (5.8 km from site), usable 54; line is split' },
      { node_id: 'SE-HUB-01', sku_id: 'SE-CEM-025', quantity: 46, reason: 'Covers the remaining 46 (15.2 km from site), usable 54' },
    ],
    shipments: [
      { task_id: 't-b', node_id: 'SE-STORE-B', status: 'PENDING_APPROVAL', task_version: 1, dispatch_slot: null, eta: '2026-11-06T09:00:00.000Z', eta_inputs: { provisional: true }, is_short: false, dispatched_at: null, delivered_at: null, delivered_qty: null, reservation_health: 'NOT_APPLICABLE' },
      { task_id: 't-h', node_id: 'SE-HUB-01', status: 'PENDING_APPROVAL', task_version: 1, dispatch_slot: null, eta: '2026-11-06T10:00:00.000Z', eta_inputs: { provisional: true }, is_short: false, dispatched_at: null, delivered_at: null, delivered_qty: null, reservation_health: 'NOT_APPLICABLE' },
    ],
    events: [{ type: 'order.submitted', version: 1, occurred_at: '2026-11-05T10:00:00.000Z' }],
    ...overrides,
  };
}

export function task(overrides: object = {}) {
  return {
    task_id: 't-b',
    order_id: 'SE-ORD-000001',
    node_id: 'SE-STORE-B',
    status: 'PENDING_APPROVAL',
    version: 1,
    order_status: 'AWAITING_APPROVAL',
    allocated_qty: 54,
    requested_delivery_at: '2026-11-12T11:00:00.000Z',
    eta: '2026-11-06T10:00:00.000Z',
    at_risk: false,
    reservation_health: 'NOT_APPLICABLE',
    reject_reason: null,
    created_at: '2026-11-05T10:00:00.000Z',
    ...overrides,
  };
}

export const picklist = {
  document_type: 'picking_list',
  not_a_tax_invoice: true,
  order_id: 'SE-ORD-000001',
  customer_company: 'Nordbygg AB',
  sales_store: { store_id: 'SE-STORE-B', name: 'Store B Mölndal' },
  site_id: 'SE-SITE-001',
  site_address: 'Demo Site 1, Askim',
  requested_delivery_at: '2026-11-12T11:00:00.000Z',
  order_status: 'AWAITING_APPROVAL',
  eta: '2026-11-06T10:00:00.000Z',
  task_id: 't-b',
  shipping_node: { node_id: 'SE-STORE-B', name: 'Store B Mölndal' },
  status: 'PENDING_APPROVAL',
  approver: null,
  approved_at: null,
  lines: [{ sku_id: 'SE-CEM-025', name: 'Portland cement 25 kg bag', quantity: 54, unit: 'bag', unit_price_sek: 89, line_total_sek: 4806 }],
};

export const review = {
  review_id: 'r1',
  source_system: 'sweden-legacy',
  field: 'unit',
  raw_value: 'säck',
  source_description: 'Byggcement Std 25kg säck',
  ai_status: 'COMPLETED',
  ai_suggestion: 'bag',
  confidence: 0.92,
  ai_reason: 'Swedish for bag',
  ai_evidence: null,
  model_version: 'gemini-flash-lite-latest',
  pending_record_count: 12,
  status: 'PENDING',
  outcome: null,
  final_value: null,
  reviewed_by: null,
  reviewed_at: null,
  reject_reason: null,
  created_at: '2026-11-05T10:00:00.000Z',
  age_seconds: 30,
};

export const stats = {
  provider: 'gemini',
  model_version: 'gemini-flash-lite-latest',
  is_live_provider: true,
  auto_approval: false,
  ai_calls_total: 3,
  normalization_cache_hits_total: 40,
  normalization_records_total: 50,
  normalization_cache_hit_rate: 0.8,
  outcomes: { accepted_as_is: 1, edited: 0, rejected: 0 },
};
