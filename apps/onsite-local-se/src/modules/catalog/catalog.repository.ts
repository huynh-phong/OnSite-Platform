import type { Db } from '../../db.js';

type Queryable = Pick<Db, 'query'>;

export interface StoreRow {
  store_id: string;
  name: string;
  type: 'STORE' | 'HUB';
  lat: number;
  lng: number;
  prep_minutes: number;
  status: 'ACTIVE' | 'INACTIVE';
  last_heartbeat_at: Date | null;
  heartbeat_checked_at: Date | null;
}

export interface ProductRow {
  sku_id: string;
  name: string;
  category: string | null;
  base_unit: string | null;
  pack_size_verified: string | null;
  unit_price: string;
  status: 'ACTIVE' | 'PENDING_REVIEW';
  source_unit: string | null;
  source_description: string | null;
  updated_at: Date;
}

export interface SiteRow {
  site_id: string;
  customer_id: string;
  lat: number;
  lng: number;
  address_enc: Buffer;
  address_nonce: Buffer;
  address_tag: Buffer;
  key_id: string;
}

export async function listStores(db: Queryable): Promise<StoreRow[]> {
  const { rows } = await db.query<StoreRow>('SELECT * FROM stores ORDER BY store_id');
  return rows;
}

/** Records one successful read of the source's heartbeats. A heartbeat never moves backwards. */
export async function recordHeartbeats(db: Queryable, beats: { store_id: string; last_heartbeat_at: string }[]) {
  if (!beats.length) return;
  await db.query(
    `UPDATE stores s
        SET last_heartbeat_at = GREATEST(s.last_heartbeat_at, b.at), heartbeat_checked_at = now()
       FROM unnest($1::text[], $2::timestamptz[]) AS b(store_id, at)
      WHERE s.store_id = b.store_id`,
    [beats.map((beat) => beat.store_id), beats.map((beat) => beat.last_heartbeat_at)],
  );
}

/**
 * Nodes that, at the last read, had been silent for longer than the timeout. Silence is measured as the
 * source saw it, so a gap in our own reads does not make a node offline, and a node never heard of is not.
 */
export async function listOfflineNodeIds(db: Queryable, timeoutSeconds: number): Promise<string[]> {
  const { rows } = await db.query<{ store_id: string }>(
    `SELECT store_id FROM stores
      WHERE heartbeat_checked_at - last_heartbeat_at > make_interval(secs => $1) ORDER BY store_id`,
    [timeoutSeconds],
  );
  return rows.map((row) => row.store_id);
}

export async function getStore(db: Queryable, storeId: string): Promise<StoreRow | undefined> {
  const { rows } = await db.query<StoreRow>('SELECT * FROM stores WHERE store_id = $1', [storeId]);
  return rows[0];
}

export async function listProducts(db: Queryable, includePending: boolean): Promise<ProductRow[]> {
  const { rows } = await db.query<ProductRow>(
    `SELECT sku_id, name, category, base_unit, pack_size_verified, unit_price, status, source_unit, source_description, updated_at
       FROM products WHERE $1 OR status = 'ACTIVE' ORDER BY sku_id`,
    [includePending],
  );
  return rows;
}

export async function getProducts(db: Queryable, skuIds: string[]): Promise<ProductRow[]> {
  const { rows } = await db.query<ProductRow>('SELECT * FROM products WHERE sku_id = ANY($1)', [skuIds]);
  return rows;
}

export async function getSite(db: Queryable, siteId: string): Promise<SiteRow | undefined> {
  const { rows } = await db.query<SiteRow>('SELECT * FROM sites WHERE site_id = $1', [siteId]);
  return rows[0];
}

export async function listCustomerSites(db: Queryable, customerId?: string): Promise<SiteRow[]> {
  const { rows } = await db.query<SiteRow>(
    'SELECT * FROM sites WHERE $1::text IS NULL OR customer_id = $1 ORDER BY site_id',
    [customerId ?? null],
  );
  return rows;
}

export async function getCustomerName(db: Queryable, customerId: string): Promise<string | undefined> {
  const { rows } = await db.query<{ company_name: string }>('SELECT company_name FROM customers WHERE customer_id = $1', [
    customerId,
  ]);
  return rows[0]?.company_name;
}
