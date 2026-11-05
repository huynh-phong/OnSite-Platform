export interface OrderBody {
  sales_store_id: string;
  site_id: string;
  requested_delivery_at: string;
  items: { sku_id: string; quantity: number; unit: string }[];
}

interface StoredDraft {
  fingerprint: string;
  key: string;
}

const STORAGE_KEY = 'onsite.order-key';

export function fingerprint(body: OrderBody): string {
  return JSON.stringify([
    body.sales_store_id,
    body.site_id,
    body.requested_delivery_at,
    body.items.map((item) => [item.sku_id, item.quantity, item.unit]),
  ]);
}

function read(): StoredDraft | null {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as StoredDraft | null;
  } catch {
    return null;
  }
}

/**
 * The Idempotency-Key for this submission. Trying the same order again, after a timeout or a double click,
 * uses the same key, so the server creates one order. Changing the order makes it a new one, with a new key.
 */
export function idempotencyKeyFor(body: OrderBody): string {
  const print = fingerprint(body);
  const stored = read();
  if (stored?.fingerprint === print) return stored.key;
  const key = crypto.randomUUID();
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ fingerprint: print, key }));
  } catch {
    // Without storage it still works; a retry after a reload would just count as new.
  }
  return key;
}

/** Called once the server has answered, so that the next order, even an identical one, is a new order. */
export function clearOrderKey(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
