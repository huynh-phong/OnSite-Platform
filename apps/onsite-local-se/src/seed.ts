import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { encryptField } from './crypto.js';
import type { Db } from './db.js';
import { withTransaction } from './db.js';
import { hashRawValue, normalizeRawValue } from './modules/normalization/key.js';
import { hashPassword } from './passwords.js';

const seedDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../seed');

interface StoreSeed {
  store_id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  prep_minutes: number;
}
interface CustomerSeed {
  customer_id: string;
  company_name: string;
  contact: unknown;
  sites: { site_id: string; lat: number; lng: number; address: string }[];
}
interface UserSeed {
  user_id: string;
  role: string;
  store_id?: string;
  customer_id?: string;
}
interface BaselineMappings {
  unit: string[];
  category: string[];
  pack_size_kg: Record<string, number>;
}

async function loadJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(seedDir, file), 'utf8')) as T;
}

/**
 * Replaces all Local SE data with the demo seed. Products and stock are not seeded here:
 * they arrive from the simulator through the sync worker, using the approved mappings below.
 */
export async function seedLocal(pool: Db, config: Config) {
  const stores = await loadJson<StoreSeed[]>('stores.json');
  const customers = await loadJson<CustomerSeed[]>('customers.json');
  const users = await loadJson<UserSeed[]>('users.json');
  const baseline = await loadJson<BaselineMappings>('normalization-baseline.json');

  const passwordHash = hashPassword(config.demoPassword);
  const mappings: [string, string, string][] = [
    ...baseline.unit.map((value): [string, string, string] => ['unit', value, value]),
    ...baseline.category.map((value): [string, string, string] => ['category', value, value]),
    ...Object.entries(baseline.pack_size_kg).map(([raw, kg]): [string, string, string] => [
      'pack_size_kg',
      raw,
      String(kg),
    ]),
  ];

  await withTransaction(pool, async (client) => {
    await client.query(`TRUNCATE metric_counters, connector_settings, audit_logs, pending_normalized_records, normalization_review_queue,
      normalization_mappings, inbox_events, outbox_events, idempotency_records, order_events, shipments,
      reservations, allocations, fulfilment_tasks, order_items, orders, sync_cursors, inventory_view,
      products, sites, users, customers, stores RESTART IDENTITY CASCADE`);
    await client.query('ALTER SEQUENCE order_number_seq RESTART WITH 1');

    for (const store of stores) {
      await client.query(
        `INSERT INTO stores (store_id, name, type, lat, lng, prep_minutes) VALUES ($1, $2, $3, $4, $5, $6)`,
        [store.store_id, store.name, store.type, store.lat, store.lng, store.prep_minutes],
      );
    }

    for (const customer of customers) {
      const contact = encryptField(
        JSON.stringify(customer.contact),
        { country: config.countryCode, table: 'customers', rowId: customer.customer_id, field: 'contact_enc' },
        config.dataKey,
        config.dataKeyId,
      );
      await client.query(
        `INSERT INTO customers (customer_id, company_name, contact_enc, contact_nonce, contact_tag, key_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [customer.customer_id, customer.company_name, contact.ciphertext, contact.nonce, contact.tag, contact.keyId],
      );
      for (const site of customer.sites) {
        const address = encryptField(
          site.address,
          { country: config.countryCode, table: 'sites', rowId: site.site_id, field: 'address_enc' },
          config.dataKey,
          config.dataKeyId,
        );
        await client.query(
          `INSERT INTO sites (site_id, customer_id, lat, lng, address_enc, address_nonce, address_tag, key_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            site.site_id,
            customer.customer_id,
            site.lat,
            site.lng,
            address.ciphertext,
            address.nonce,
            address.tag,
            address.keyId,
          ],
        );
      }
    }

    for (const user of users) {
      await client.query(
        `INSERT INTO users (user_id, password_hash, role, country, store_id, customer_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.user_id, passwordHash, user.role, config.countryCode, user.store_id ?? null, user.customer_id ?? null],
      );
    }

    for (const [field, raw, normalized] of mappings) {
      await client.query(
        `INSERT INTO normalization_mappings
           (source_system, field, raw_value_hash, raw_value, normalized_value, approved_by)
         VALUES ($1, $2, $3, $4, $5, 'seed')`,
        [config.sourceSystem, field, hashRawValue(raw), normalizeRawValue(raw), normalized],
      );
    }

    for (const stream of ['products', 'inventory']) {
      await client.query(`INSERT INTO sync_cursors (source_system, stream) VALUES ($1, $2)`, [
        config.sourceSystem,
        stream,
      ]);
    }
  });

  return {
    stores: stores.length,
    customers: customers.length,
    sites: customers.reduce((total, customer) => total + customer.sites.length, 0),
    users: users.length,
    mappings: mappings.length,
  };
}
