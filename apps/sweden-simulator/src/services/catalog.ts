import type { Db } from '../db.js';
import { withTransaction } from '../db.js';
import { SimError } from '../errors.js';
import { appendFeed, readFeed } from './feed.js';

export interface LegacyProduct {
  sku_id: string;
  name: string;
  source_unit: string;
  source_category: string;
  source_description: string;
  unit_price_sek: number;
  version: number;
  updated_at: string;
}

export interface LegacyInventory {
  node_id: string;
  sku_id: string;
  on_hand: number;
  reserved: number;
  source_unit: string;
  version: number;
  updated_at: string;
}

const PRODUCT_COLUMNS = `sku_id, name, source_unit, source_category, source_description,
  unit_price_sek::float8 AS unit_price_sek, version, updated_at`;
export const INVENTORY_COLUMNS = 'node_id, sku_id, on_hand, reserved, source_unit, version, updated_at';

export async function listStores(pool: Db) {
  const { rows } = await pool.query(
    'SELECT store_id, name, type, lat, lng, prep_minutes, status FROM stores ORDER BY store_id',
  );
  return rows;
}

export function readProducts(pool: Db, sinceSeq: number, limit?: number) {
  return readFeed<LegacyProduct & Record<string, unknown>>(
    pool,
    {
      entity: 'product',
      all: `SELECT ${PRODUCT_COLUMNS} FROM products ORDER BY sku_id`,
      byIds: `SELECT ${PRODUCT_COLUMNS} FROM products WHERE sku_id = ANY($1)`,
      id: (row) => row.sku_id,
    },
    sinceSeq,
    limit,
  );
}

export function readInventory(pool: Db, sinceSeq: number, limit?: number) {
  return readFeed<LegacyInventory & Record<string, unknown>>(
    pool,
    {
      entity: 'inventory',
      all: `SELECT ${INVENTORY_COLUMNS} FROM inventory ORDER BY node_id, sku_id`,
      byIds: `SELECT ${INVENTORY_COLUMNS} FROM inventory WHERE node_id || ':' || sku_id = ANY($1)`,
      id: (row) => `${row.node_id}:${row.sku_id}`,
    },
    sinceSeq,
    limit,
  );
}

export interface NewProduct {
  sku_id: string;
  name: string;
  source_unit: string;
  source_category: string;
  source_description: string;
  unit_price_sek: number;
}

export async function createProduct(pool: Db, product: NewProduct): Promise<LegacyProduct> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<LegacyProduct>(
      `INSERT INTO products (sku_id, name, source_unit, source_category, source_description, unit_price_sek)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sku_id) DO NOTHING
       RETURNING ${PRODUCT_COLUMNS}`,
      [
        product.sku_id,
        product.name,
        product.source_unit,
        product.source_category,
        product.source_description,
        product.unit_price_sek,
      ],
    );
    if (!rows[0]) throw new SimError(409, 'PRODUCT_EXISTS', `Product ${product.sku_id} already exists`);
    await appendFeed(client, 'product', product.sku_id);
    return rows[0];
  });
}

export interface Receipt {
  node_id: string;
  sku_id: string;
  qty: number;
  reference?: string;
  source_unit?: string;
}

/** Inbound stock. Creates the stock row on first receipt of a SKU at a node. */
export async function receiveStock(pool: Db, receipt: Receipt): Promise<LegacyInventory> {
  return withTransaction(pool, async (client) => {
    const known = await client.query<{ source_unit: string }>(
      `SELECT p.source_unit FROM products p, stores s WHERE p.sku_id = $1 AND s.store_id = $2`,
      [receipt.sku_id, receipt.node_id],
    );
    if (!known.rows[0]) throw new SimError(404, 'UNKNOWN_STOCK_ROW', 'Unknown node or SKU');
    const { rows } = await client.query<LegacyInventory>(
      `INSERT INTO inventory (node_id, sku_id, on_hand, source_unit) VALUES ($1, $2, $3, $4)
       ON CONFLICT (node_id, sku_id) DO UPDATE
         SET on_hand = inventory.on_hand + EXCLUDED.on_hand, version = inventory.version + 1, updated_at = now()
       RETURNING ${INVENTORY_COLUMNS}`,
      [receipt.node_id, receipt.sku_id, receipt.qty, receipt.source_unit ?? known.rows[0].source_unit],
    );
    await client.query(
      `INSERT INTO stock_ledger (node_id, sku_id, type, qty, reference) VALUES ($1, $2, 'INBOUND', $3, $4)`,
      [receipt.node_id, receipt.sku_id, receipt.qty, receipt.reference ?? 'receipt'],
    );
    await appendFeed(client, 'inventory', `${receipt.node_id}:${receipt.sku_id}`);
    return rows[0]!;
  });
}

export async function listTransactions(pool: Db, filter: { node_id?: string; sku_id?: string; limit: number }) {
  const { rows } = await pool.query(
    `SELECT entry_id::float8 AS entry_id, node_id, sku_id, type, qty, reference, occurred_at FROM stock_ledger
      WHERE ($1::text IS NULL OR node_id = $1) AND ($2::text IS NULL OR sku_id = $2)
      ORDER BY stock_ledger.entry_id DESC LIMIT $3`,
    [filter.node_id ?? null, filter.sku_id ?? null, filter.limit],
  );
  return rows;
}
