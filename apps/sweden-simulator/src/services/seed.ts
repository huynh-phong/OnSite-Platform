import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db.js';
import { withTransaction } from '../db.js';

const seedDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../seed');

interface Store {
  store_id: string;
  name: string;
  type: 'STORE' | 'HUB';
  lat: number;
  lng: number;
  prep_minutes: number;
}
interface Product {
  sku_id: string;
  name: string;
  source_unit: string;
  source_category: string;
  source_description: string;
  unit_price_sek: number;
}
interface ProductSeed {
  products: Product[];
  ai_demo_products: Product[];
}
interface ScenarioFile {
  defaults: { on_hand: Record<'STORE' | 'HUB', number>; node_source_unit_overrides: Record<string, string> };
  scenarios: Record<string, { description: string; on_hand: Record<string, Record<string, number>> }>;
}

async function loadJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(seedDir, file), 'utf8')) as T;
}

export interface SeedSummary {
  scenario: string;
  stores: number;
  products: number;
  inventoryRows: number;
}

/** Replaces all simulator data with the seed for the chosen scenario. Deterministic. */
export async function seedSimulator(pool: Db, scenarioName: string): Promise<SeedSummary> {
  const stores = await loadJson<Store[]>('stores.json');
  const { products, ai_demo_products: aiDemoProducts } = await loadJson<ProductSeed>('products.json');
  const inventorySeed = await loadJson<ScenarioFile>('inventory-scenarios.json');

  const scenario = inventorySeed.scenarios[scenarioName];
  if (!scenario) {
    const known = Object.keys(inventorySeed.scenarios).join(', ');
    throw new Error(`Unknown inventory scenario "${scenarioName}". Known: ${known}`);
  }
  const allProducts = [...products, ...aiDemoProducts];

  await withTransaction(pool, async (client) => {
    await client.query(`TRUNCATE change_feed, stock_ledger, reservations, inventory, products, stores, sim_settings
                        RESTART IDENTITY CASCADE`);
    await client.query('INSERT INTO sim_settings DEFAULT VALUES');

    for (const store of stores) {
      await client.query(
        `INSERT INTO stores (store_id, name, type, lat, lng, prep_minutes) VALUES ($1, $2, $3, $4, $5, $6)`,
        [store.store_id, store.name, store.type, store.lat, store.lng, store.prep_minutes],
      );
    }

    for (const product of allProducts) {
      await client.query(
        `INSERT INTO products (sku_id, name, source_unit, source_category, source_description, unit_price_sek)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          product.sku_id,
          product.name,
          product.source_unit,
          product.source_category,
          product.source_description,
          product.unit_price_sek,
        ],
      );
      await client.query(`INSERT INTO change_feed (entity, entity_id) VALUES ('product', $1)`, [product.sku_id]);
    }

    for (const store of stores) {
      for (const product of allProducts) {
        const onHand = scenario.on_hand[product.sku_id]?.[store.store_id] ?? (scenario.on_hand[product.sku_id]
          ? 0
          : inventorySeed.defaults.on_hand[store.type]);
        const sourceUnit = inventorySeed.defaults.node_source_unit_overrides[store.store_id] ?? product.source_unit;
        await client.query(
          `INSERT INTO inventory (node_id, sku_id, on_hand, source_unit) VALUES ($1, $2, $3, $4)`,
          [store.store_id, product.sku_id, onHand, sourceUnit],
        );
        if (onHand > 0) {
          await client.query(
            `INSERT INTO stock_ledger (node_id, sku_id, type, qty, reference)
             VALUES ($1, $2, 'INBOUND', $3, 'opening-balance')`,
            [store.store_id, product.sku_id, onHand],
          );
        }
        await client.query(`INSERT INTO change_feed (entity, entity_id) VALUES ('inventory', $1)`, [
          `${store.store_id}:${product.sku_id}`,
        ]);
      }
    }
  });

  return {
    scenario: scenarioName,
    stores: stores.length,
    products: allProducts.length,
    inventoryRows: stores.length * allProducts.length,
  };
}
