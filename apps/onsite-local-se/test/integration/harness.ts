import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp as buildSimulator } from '../../../sweden-simulator/src/app.js';
import { createPool as createSimPool } from '../../../sweden-simulator/src/db.js';
import { dropEverything as dropSim, runMigrations as migrateSim } from '../../../sweden-simulator/src/migrate.js';
import { sweepExpiredReservations } from '../../../sweden-simulator/src/services/reservations.js';
import { seedSimulator } from '../../../sweden-simulator/src/services/seed.js';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { MockLlmProvider, type LlmProvider, type SuggestInput } from '../../src/connectors/llm.js';
import { createPool, type Db } from '../../src/db.js';
import { dropEverything, runMigrations } from '../../src/migrate.js';
import { seedLocal } from '../../src/seed.js';

export const CEMENT = 'SE-CEM-025';
export const STORE_B = 'SE-STORE-B';
export const HUB = 'SE-HUB-01';
export const NEAR_SITE = 'SE-SITE-001';
export const FAR_SITE = 'SE-SITE-002';

function envValue(name: string): string {
  if (process.env[name]) return process.env[name]!;
  const file = readFileSync(new URL('../../../../.env', import.meta.url), 'utf8');
  const line = file.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not set in the environment or in .env`);
  return line.slice(name.length + 1);
}

/** Tests get their own databases on the same servers, so that the demo data is left alone. */
async function testDatabaseUrl(name: string): Promise<string> {
  const url = new URL(envValue(name));
  const testName = `${url.pathname.slice(1)}_test`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testName]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE ${testName}`);
  await admin.end();
  url.pathname = `/${testName}`;
  return url.toString();
}

export type LlmMode = 'mock' | 'invalid-json' | 'bad-schema' | 'timeout' | 'error';

/** The mock provider, plus a record of every call and switchable failure modes. */
export class TestLlm implements LlmProvider {
  readonly modelVersion = 'test-llm';
  private readonly mock = new MockLlmProvider();
  mode: LlmMode = 'mock';
  calls: SuggestInput[] = [];
  /** When set, the provider waits for it before answering, to keep calls in flight. */
  gate: Promise<void> | undefined;

  async suggest(input: SuggestInput, signal: AbortSignal): Promise<unknown> {
    this.calls.push(input);
    if (this.gate) await this.gate;
    switch (this.mode) {
      case 'invalid-json':
        return 'this is not json';
      case 'bad-schema':
        return { suggested_value: 'banana', confidence: 0.9, reason: 'not an allowed value' };
      case 'timeout':
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      case 'error':
        throw new Error('provider down');
      default:
        return this.mock.suggest(input);
    }
  }
}

export interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, unknown>;
}

export interface Harness {
  app: FastifyInstance;
  sim: FastifyInstance;
  simUrl: string;
  config: Config;
  pool: Db;
  simPool: Db;
  llm: TestLlm;
  serviceHeaders: Record<string, string>;
  reset: (scenario?: 'S1' | 'S2', options?: { sync?: boolean }) => Promise<void>;
  /** A full worker tick: sync, then the AI queue. */
  sync: () => Promise<{ ok: boolean; error?: string }>;
  api: (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    options?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ) => Promise<ApiResponse>;
  simApi: (method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown, headers?: Record<string, string>) => Promise<ApiResponse>;
  token: (user: string) => Promise<string>;
  placeOrder: (
    quantity: number,
    options?: { site?: string; requestedAt?: string; key?: string; sku?: string; unit?: string; token?: string },
  ) => Promise<ApiResponse>;
  outage: (enabled: boolean) => Promise<void>;
  sweepSource: () => Promise<number>;
  stock: (node: string, sku?: string) => Promise<{ on_hand: number; reserved: number }>;
  /** The live tasks of an order, with what a staff member needs to act on them. */
  tasks: (orderId: string) => Promise<{ task_id: string; node_id: string; version: number; status: string }[]>;
  act: (
    orderId: string,
    node: string,
    action: 'approve' | 'dispatch' | 'deliver' | 'reject',
    body?: Record<string, unknown>,
  ) => Promise<ApiResponse>;
  close: () => Promise<void>;
}

const STAFF_BY_NODE: Record<string, string> = {
  [STORE_B]: 'staff.store-b',
  [HUB]: 'staff.hub-01',
  'SE-STORE-C': 'staff.store-c',
  'SE-STORE-D': 'staff.store-d',
};

export async function startHarness(): Promise<Harness> {
  process.env.LOG_LEVEL = 'silent';
  const serviceToken = randomBytes(24).toString('hex');
  const demoPassword = randomBytes(12).toString('hex');

  const simPool = createSimPool(await testDatabaseUrl('SIM_DATABASE_URL'));
  await dropSim(simPool);
  await migrateSim(simPool);
  const sim = await buildSimulator(simPool, { serviceToken });
  await sim.listen({ host: '127.0.0.1', port: 0 });
  const simUrl = `http://127.0.0.1:${(sim.server.address() as AddressInfo).port}`;

  Object.assign(process.env, {
    COUNTRY_CODE: 'SE',
    SE_DATABASE_URL: await testDatabaseUrl('SE_DATABASE_URL'),
    SE_JWT_SECRET: randomBytes(32).toString('hex'),
    SE_DATA_KEY: randomBytes(32).toString('base64'),
    SE_DATA_KEY_ID: 'se-key-v1',
    SIMULATOR_BASE_URL: simUrl,
    SIMULATOR_SERVICE_TOKEN: serviceToken,
    DEMO_PASSWORD: demoPassword,
    LLM_PROVIDER: 'mock',
    CENTRAL_INGEST_URL: '',
  });
  const config = loadConfig();
  config.llm.timeoutMs = 200;
  const baseTtl = config.reservation.ttlMinutes;

  const pool = createPool(config.databaseUrl);
  await dropEverything(pool);
  await runMigrations(pool);
  await seedLocal(pool, config);

  const llm = new TestLlm();
  const app = await buildApp(config, pool, { llm });
  await app.ready();

  const tokens = new Map<string, string>();
  // Fixed, so that a retry with the same key really is the same request.
  const defaultRequestedAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const serviceHeaders = { authorization: `Bearer ${serviceToken}` };

  const api: Harness['api'] = async (method, url, options = {}) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { payload: options.body as object }),
    });
    let body: unknown = response.body;
    try {
      body = response.json();
    } catch {
      // Not JSON.
    }
    return { status: response.statusCode, body, headers: response.headers };
  };

  const simApi: Harness['simApi'] = async (method, url, body, headers = {}) => {
    const response = await sim.inject({
      method,
      url,
      headers: { ...serviceHeaders, ...headers },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    return { status: response.statusCode, body: response.json(), headers: response.headers };
  };

  const token: Harness['token'] = async (user) => {
    const known = tokens.get(user);
    if (known) return known;
    const response = await api('POST', '/api/v1/auth/login', { body: { username: user, password: demoPassword } });
    if (response.status !== 200) throw new Error(`Login failed for ${user}: ${response.status}`);
    tokens.set(user, response.body.access_token);
    return response.body.access_token;
  };

  const sync: Harness['sync'] = () => app.container.inventory.tick();

  const reset: Harness['reset'] = async (scenario = 'S1', options = {}) => {
    await seedSimulator(simPool, scenario);
    await seedLocal(pool, config);
    tokens.clear();
    llm.calls = [];
    llm.mode = 'mock';
    llm.gate = undefined;
    config.reservation.ttlMinutes = baseTtl;
    config.centralIngestUrl = undefined;
    await app.container.inventory.loadConnectorState();
    if (options.sync !== false) {
      const result = await sync();
      if (!result.ok) throw new Error(`Initial sync failed: ${result.error}`);
    }
  };

  const placeOrder: Harness['placeOrder'] = async (quantity, options = {}) =>
    api('POST', '/api/v1/orders', {
      token: options.token ?? (await token('buyer.nordbygg')),
      headers: { 'idempotency-key': options.key ?? randomUUID() },
      body: {
        sales_store_id: STORE_B,
        site_id: options.site ?? NEAR_SITE,
        requested_delivery_at: options.requestedAt ?? defaultRequestedAt,
        items: [{ sku_id: options.sku ?? CEMENT, quantity, unit: options.unit ?? 'bag' }],
      },
    });

  const stock: Harness['stock'] = async (node, sku = CEMENT) => {
    const { rows } = await simPool.query<{ on_hand: number; reserved: number }>(
      'SELECT on_hand, reserved FROM inventory WHERE node_id = $1 AND sku_id = $2',
      [node, sku],
    );
    return rows[0]!;
  };

  const tasks: Harness['tasks'] = async (orderId) => {
    const { rows } = await pool.query(
      `SELECT task_id, node_id, version, status FROM fulfilment_tasks
        WHERE order_id = $1 AND status NOT IN ('REJECTED', 'EXPIRED', 'CANCELLED') ORDER BY node_id`,
      [orderId],
    );
    return rows;
  };

  const act: Harness['act'] = async (orderId, node, action, body = {}) => {
    const { rows } = await pool.query(
      `SELECT task_id, version FROM fulfilment_tasks
        WHERE order_id = $1 AND node_id = $2 AND status NOT IN ('REJECTED', 'EXPIRED', 'CANCELLED')`,
      [orderId, node],
    );
    if (!rows[0]) throw new Error(`No live task for ${orderId} at ${node}`);
    return api('POST', `/api/v1/staff/tasks/${rows[0].task_id}/${action}`, {
      token: await token(STAFF_BY_NODE[node] ?? 'staff.store-b'),
      body: { version: rows[0].version, ...body },
    });
  };

  return {
    app,
    sim,
    simUrl,
    config,
    pool,
    simPool,
    llm,
    serviceHeaders,
    reset,
    sync,
    api,
    simApi,
    token,
    placeOrder,
    outage: async (enabled) => {
      await simApi('POST', '/legacy/admin/outage', { enabled });
    },
    sweepSource: () => sweepExpiredReservations(simPool),
    stock,
    tasks,
    act,
    close: async () => {
      await app.close();
      await sim.close();
      await pool.end();
      await simPool.end();
    },
  };
}
