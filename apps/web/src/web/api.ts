export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** What a person should know and do, in place of an error code. Everything else shows the API's own message. */
const GUIDANCE: Record<string, string> = {
  VERSION_CONFLICT: 'Someone else changed this just now. The latest state has been loaded; check it and try again.',
  RESERVATION_LOST: 'The source system no longer holds this stock, so it was not dispatched. This needs manual follow-up.',
  RESERVATION_EXPIRED: 'The stock reservation ran out before approval, so the order has expired. The customer can place a new one.',
  SOURCE_UNAVAILABLE: 'The source system cannot be reached, so nothing was changed. Try again when it is back.',
  ORDER_NOT_APPROVED: 'Every shipping node must approve the order first.',
  INVALID_TRANSITION: 'This action is no longer possible in the current state. The latest state has been loaded.',
  FORBIDDEN: 'You do not have access to this. The server refused it, and the attempt was logged.',
  IDEMPOTENCY_IN_PROGRESS: 'Your order is still being processed. Wait a moment before trying again.',
  IDEMPOTENCY_CONFLICT: 'This submission conflicts with an earlier one. Reload the page and start the order again.',
  LOCAL_SE_UNAVAILABLE: 'OnSite Local SE cannot be reached right now. Try again in a moment.',
  NETWORK_ERROR: 'The request did not get through. It is safe to try again.',
  INVALID_CREDENTIALS: 'Wrong username or password.',
  VALUE_REQUIRED: 'The AI gave no suggestion for this one, so enter the value yourself.',
};

export function explainError(error: unknown): string {
  if (error instanceof ApiError) return GUIDANCE[error.code] ?? error.message;
  return error instanceof Error ? error.message : 'Something went wrong.';
}

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function configureApi(next: { token: string | null; onUnauthorized?: () => void }): void {
  token = next.token;
  onUnauthorized = next.onUnauthorized ?? onUnauthorized;
}

export function currentToken(): string | null {
  return token;
}

export async function api<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'The request did not get through');
  }
  const payload = (await response.json().catch(() => undefined)) as
    | { error?: { code: string; message: string; request_id?: string } }
    | undefined;
  if (!response.ok) {
    const error = new ApiError(
      response.status,
      payload?.error?.code ?? 'ERROR',
      payload?.error?.message ?? `The request failed (${response.status})`,
      payload?.error?.request_id,
    );
    if (response.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    throw error;
  }
  return payload as T;
}

// ---------------------------------------------------------------- API shapes, as the real API returns them

export interface Store {
  store_id: string;
  name: string;
  type: 'STORE' | 'HUB';
  status: string;
}
export interface Product {
  sku_id: string;
  name: string;
  category: string | null;
  base_unit: string | null;
  pack_size_kg: number | null;
  unit_price_sek: number;
  status: 'ACTIVE' | 'PENDING_REVIEW';
  availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
  inventory_as_of: string | null;
  usable_by_node?: { node_id: string; usable: number }[];
}
export interface Site {
  site_id: string;
  customer_id: string;
  address: string;
}
export interface OrderSummary {
  order_id: string;
  status: string;
  sales_store_id: string;
  site_id: string;
  requested_delivery_at: string;
  eta: string | null;
  at_risk: boolean;
  version: number;
  created_at: string;
}
export interface Shipment {
  task_id: string;
  node_id: string;
  status: string;
  task_version: number;
  dispatch_slot: string | null;
  eta: string | null;
  eta_inputs: { provisional?: boolean; distance_km?: number; travel_minutes?: number; prep_minutes?: number } | null;
  is_short: boolean;
  dispatched_at: string | null;
  delivered_at: string | null;
  delivered_qty: number | null;
  reservation_health: 'OK' | 'RENEWAL_FAILING' | 'LOST' | 'NOT_APPLICABLE';
}
export interface OrderDetail extends OrderSummary {
  review_reason: string | null;
  fulfillable_qty: number | null;
  early_shortage_detected: boolean;
  inventory_as_of: string | null;
  reservation_expires_at: string | null;
  eta_is_estimate: boolean;
  at_risk_reason: string | null;
  approved_at: string | null;
  delivered_at: string | null;
  otif: boolean | null;
  items: { sku_id: string; quantity: number; unit: string; unit_price_sek: number }[];
  allocations: { node_id: string; sku_id: string; quantity: number; reason: string }[];
  shipments: Shipment[];
  events: { type: string; version: number; occurred_at: string; actor?: string; data?: Record<string, unknown> }[];
}
export interface Task {
  task_id: string;
  order_id: string;
  node_id: string;
  status: string;
  version: number;
  order_status: string;
  allocated_qty: number;
  requested_delivery_at: string;
  eta: string | null;
  at_risk: boolean;
  reservation_health: Shipment['reservation_health'];
  reject_reason: string | null;
  created_at: string;
}
export interface DocumentLine {
  sku_id: string;
  name: string;
  quantity: number;
  unit: string;
  unit_price_sek: number;
  line_total_sek: number;
}
export interface TaskDocument {
  task_id: string;
  shipping_node: { node_id: string; name: string | null };
  status: string;
  eta: string | null;
  approver: string | null;
  approved_at: string | null;
  lines: DocumentLine[];
}
export interface DocumentHeader {
  not_a_tax_invoice: boolean;
  order_id: string;
  customer_company: string | null;
  sales_store: { store_id: string; name: string | null };
  site_id: string;
  site_address: string | null;
  requested_delivery_at: string;
  order_status: string;
  eta: string | null;
}
export type PickingList = DocumentHeader & TaskDocument & { document_type: 'picking_list' };
export type Confirmation = DocumentHeader & { document_type: 'order_confirmation'; shipments: TaskDocument[] };
export interface Review {
  review_id: string;
  source_system: string;
  field: 'unit' | 'category' | 'pack_size_kg';
  raw_value: string;
  source_description: string | null;
  ai_status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  ai_suggestion: string | null;
  confidence: number | null;
  ai_reason: string | null;
  ai_evidence: string | null;
  model_version: string | null;
  pending_record_count: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  outcome: string | null;
  final_value: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reject_reason: string | null;
  created_at: string;
  age_seconds: number;
}
export interface AiStats {
  provider: string;
  model_version: string;
  is_live_provider: boolean;
  auto_approval: boolean;
  ai_calls_total: number;
  normalization_cache_hits_total: number;
  normalization_records_total: number;
  normalization_cache_hit_rate: number | null;
  outcomes: Record<string, number>;
}
export interface SystemStatus {
  inventory_trusted: boolean;
  stale_reason: string | null;
  last_successful_sync_at: string | null;
  verified_age_s: number | null;
  stale_after_s: number;
  connector_enabled: boolean;
  source_reachable: boolean;
}
export interface Metrics {
  api: { p50_ms: number | null; p95_ms: number | null; samples: number };
  inventory: {
    trusted: boolean;
    stale_reason: string | null;
    last_successful_sync_at: string | null;
    verified_age_s: number | null;
    nodes: { node_id: string; rows: number; newest_source_change_age_s: number; inventory_freshness_s: number | null }[];
  };
  outbox: { outbox_pending: number; outbox_delivered: number; outbox_dead: number; outbox_oldest_age_s: number | null };
  reservations: { reservation_conflicts: number; renewals_total: number; renewal_failures_total: number; lost_total: number };
  ai: { ai_calls_total: number; normalization_cache_hits_total: number; review_queue_pending: number };
  business: {
    orders_total: number;
    early_shortage_detected: number;
    at_risk_count: number;
    delivered_orders: number;
    otif_rate: number | null;
  };
}
export interface Health {
  status: string;
  db: string;
  simulator: 'ok' | 'down' | 'disabled';
  central: 'configured' | 'not_configured';
}
