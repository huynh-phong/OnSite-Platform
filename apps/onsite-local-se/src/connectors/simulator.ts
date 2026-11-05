const HEALTH_TIMEOUT_MS = 2000;

/** The source could not answer: outage, timeout, network failure, 5xx, or the connector is switched off. */
export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

/** The source answered and refused. */
export class SourceRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly sourceStatus?: string,
  ) {
    super(`Source rejected the request: ${status} ${code}`);
    this.name = 'SourceRejectedError';
  }
}

export interface SourceInventory {
  node_id: string;
  sku_id: string;
  on_hand: number;
  reserved: number;
  source_unit: string;
  version: number;
  updated_at: string;
}

export interface SourceProduct {
  sku_id: string;
  name: string;
  source_unit: string;
  source_category: string;
  source_description: string;
  unit_price_sek: number;
  version: number;
  updated_at: string;
}

export interface FeedPage<T> {
  items: T[];
  next_seq: number;
  head_seq: number;
  feed_epoch: string;
  has_more: boolean;
  snapshot: boolean;
}

export interface SourceReservation {
  reservation_id: string;
  node_id: string;
  sku_id: string;
  qty: number;
  status: 'ACTIVE' | 'COMMITTED' | 'RELEASED' | 'EXPIRED';
  expires_at: string;
  extension_count: number;
  inventory?: SourceInventory;
}

export class SimulatorClient {
  /** Set from the admin connector switch. While false no call leaves Local SE. */
  enabled = true;

  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly timeoutMs: number = 3000,
  ) {}

  private async request<T>(method: string, path: string, options: { body?: unknown; key?: string } = {}): Promise<T> {
    if (!this.enabled) throw new SourceUnavailableError('Source connector is disabled');
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.key ? { 'idempotency-key': options.key } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SourceUnavailableError(`Source call failed: ${(error as Error).name}`);
    }
    if (response.status >= 500) throw new SourceUnavailableError(`Source returned ${response.status}`);
    const payload = (await response.json().catch(() => undefined)) as
      | (T & { error?: { code?: string; status?: string } })
      | undefined;
    if (!response.ok) {
      throw new SourceRejectedError(response.status, payload?.error?.code ?? 'UNKNOWN', payload?.error?.status);
    }
    return payload as T;
  }

  /** A real business call, so a simulated outage shows as down even though /health still answers. */
  async isReachable(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const response = await fetch(`${this.baseUrl}/legacy/stores`, {
        headers: { authorization: `Bearer ${this.serviceToken}` },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  inventoryFeed(sinceSeq: number): Promise<FeedPage<SourceInventory>> {
    return this.request('GET', `/legacy/inventory?since_seq=${sinceSeq}`);
  }

  productFeed(sinceSeq: number): Promise<FeedPage<SourceProduct>> {
    return this.request('GET', `/legacy/products?since_seq=${sinceSeq}`);
  }

  reserve(input: { node_id: string; sku_id: string; qty: number; ttl_minutes: number }, key: string) {
    return this.request<SourceReservation>('POST', '/legacy/reservations', { body: input, key });
  }

  getReservation(id: string) {
    return this.request<SourceReservation>('GET', `/legacy/reservations/${id}`);
  }

  extend(id: string, ttlMinutes: number) {
    return this.request<SourceReservation>('POST', `/legacy/reservations/${id}/extend`, {
      body: { ttl_minutes: ttlMinutes },
    });
  }

  commit(id: string) {
    return this.request<SourceReservation>('POST', `/legacy/reservations/${id}/commit`);
  }

  release(id: string) {
    return this.request<SourceReservation>('DELETE', `/legacy/reservations/${id}`);
  }

  releaseByKey(key: string) {
    return this.request<{ status: string; inventory?: SourceInventory }>(
      'DELETE',
      `/legacy/reservations?idempotency_key=${encodeURIComponent(key)}`,
    );
  }
}
