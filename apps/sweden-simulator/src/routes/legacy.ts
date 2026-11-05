import { timingSafeEqual } from 'node:crypto';
import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { SimError } from '../errors.js';
import {
  createProduct,
  listStores,
  listTransactions,
  readInventory,
  readProducts,
  receiveStock,
  type NewProduct,
  type Receipt,
} from '../services/catalog.js';
import { trimFeed } from '../services/feed.js';
import {
  commitReservation,
  createReservation,
  extendReservation,
  getReservation,
  releaseByKey,
  releaseReservation,
  sweepExpiredReservations,
} from '../services/reservations.js';
import { isOutageEnabled, setOutage } from '../services/settings.js';

const OUTAGE_PATH = '/legacy/admin/outage';
const security = [{ serviceToken: [] }];
const MAX_TTL_MINUTES = 24 * 60;

const Timestamp = Type.Unsafe<string>({ type: 'string', format: 'date-time' });
const Inventory = Type.Object({
  node_id: Type.String(),
  sku_id: Type.String(),
  on_hand: Type.Integer(),
  reserved: Type.Integer(),
  source_unit: Type.String(),
  version: Type.Integer(),
  updated_at: Timestamp,
});
const Product = Type.Object({
  sku_id: Type.String(),
  name: Type.String(),
  source_unit: Type.String(),
  source_category: Type.String(),
  source_description: Type.String(),
  unit_price_sek: Type.Number(),
  version: Type.Integer(),
  updated_at: Timestamp,
});
const Reservation = Type.Object({
  reservation_id: Type.String(),
  node_id: Type.String(),
  sku_id: Type.String(),
  qty: Type.Integer(),
  status: Type.Union([
    Type.Literal('ACTIVE'),
    Type.Literal('COMMITTED'),
    Type.Literal('RELEASED'),
    Type.Literal('EXPIRED'),
  ]),
  expires_at: Timestamp,
  extension_count: Type.Integer(),
  inventory: Type.Optional(Inventory),
});
const feedResponse = (item: TSchema) =>
  Type.Object({
    items: Type.Array(item),
    next_seq: Type.Integer(),
    head_seq: Type.Integer(),
    feed_epoch: Type.String(),
    has_more: Type.Boolean(),
    snapshot: Type.Boolean(),
  });
const FeedQuery = Type.Object({
  since_seq: Type.Integer({ minimum: 0, default: 0 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
});
const IdParam = Type.Object({ id: Type.String({ format: 'uuid' }) });
const ErrorBody = Type.Object({
  error: Type.Object(
    { code: Type.String(), message: Type.String(), request_id: Type.String() },
    { additionalProperties: true },
  ),
});

function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function registerLegacyRoutes(app: FastifyInstance, pool: Db, serviceToken: string): void {
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/legacy/')) return;
    if (!tokenMatches(request.headers.authorization, serviceToken)) {
      throw new SimError(401, 'UNAUTHORIZED', 'A valid service token is required');
    }
    if (path !== OUTAGE_PATH && (await isOutageEnabled(pool))) {
      throw new SimError(503, 'SOURCE_UNAVAILABLE', 'Simulated source outage');
    }
  });

  app.get('/legacy/stores', { schema: { tags: ['catalog'], security } }, async () => listStores(pool));

  app.get<{ Querystring: { since_seq: number; limit?: number } }>(
    '/legacy/products',
    { schema: { tags: ['catalog'], security, querystring: FeedQuery, response: { 200: feedResponse(Product) } } },
    async (request) => readProducts(pool, request.query.since_seq, request.query.limit),
  );

  app.post<{ Body: NewProduct }>(
    '/legacy/products',
    {
      schema: {
        tags: ['catalog'],
        security,
        summary: 'Create a new product with free-text source data',
        body: Type.Object({
          sku_id: Type.String({ minLength: 1, maxLength: 64 }),
          name: Type.String({ minLength: 1 }),
          source_unit: Type.String({ minLength: 1 }),
          source_category: Type.String({ minLength: 1 }),
          source_description: Type.String({ minLength: 1 }),
          unit_price_sek: Type.Number({ minimum: 0 }),
        }),
        response: { 201: Product },
      },
    },
    async (request, reply) => reply.code(201).send(await createProduct(pool, request.body)),
  );

  app.get<{ Querystring: { since_seq: number; limit?: number } }>(
    '/legacy/inventory',
    { schema: { tags: ['inventory'], security, querystring: FeedQuery, response: { 200: feedResponse(Inventory) } } },
    async (request) => readInventory(pool, request.query.since_seq, request.query.limit),
  );

  app.post<{ Body: Receipt }>(
    '/legacy/receipts',
    {
      schema: {
        tags: ['inventory'],
        security,
        body: Type.Object({
          node_id: Type.String(),
          sku_id: Type.String(),
          qty: Type.Integer({ minimum: 1 }),
          reference: Type.Optional(Type.String()),
          source_unit: Type.Optional(Type.String({ minLength: 1 })),
        }),
        response: { 201: Inventory },
      },
    },
    async (request, reply) => reply.code(201).send(await receiveStock(pool, request.body)),
  );

  app.get<{ Querystring: { node_id?: string; sku_id?: string; limit: number } }>(
    '/legacy/transactions',
    {
      schema: {
        tags: ['inventory'],
        security,
        summary: 'Stock ledger, newest first',
        querystring: Type.Object({
          node_id: Type.Optional(Type.String()),
          sku_id: Type.Optional(Type.String()),
          limit: Type.Integer({ minimum: 1, maximum: 1000, default: 100 }),
        }),
      },
    },
    async (request) => listTransactions(pool, request.query),
  );

  app.post<{
    Body: { node_id: string; sku_id: string; qty: number; ttl_minutes: number };
    Headers: { 'idempotency-key': string };
  }>(
    '/legacy/reservations',
    {
      schema: {
        tags: ['reservations'],
        security,
        summary: 'Atomically reserve usable stock',
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 1, maxLength: 200 }) }),
        body: Type.Object({
          node_id: Type.String(),
          sku_id: Type.String(),
          qty: Type.Integer({ minimum: 1 }),
          ttl_minutes: Type.Number({ exclusiveMinimum: 0, maximum: MAX_TTL_MINUTES }),
        }),
        response: { 200: Reservation, 201: Reservation, 409: ErrorBody },
      },
    },
    async (request, reply) => {
      const { created, result } = await createReservation(pool, {
        ...request.body,
        idempotency_key: request.headers['idempotency-key'],
      });
      return reply.code(created ? 201 : 200).send(result);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/legacy/reservations/:id',
    { schema: { tags: ['reservations'], security, params: IdParam, response: { 200: Reservation } } },
    async (request) => getReservation(pool, request.params.id),
  );

  app.post<{ Params: { id: string } }>(
    '/legacy/reservations/:id/commit',
    {
      schema: {
        tags: ['reservations'],
        security,
        summary: 'Turn a reservation into outbound stock',
        params: IdParam,
        response: { 200: Reservation, 409: ErrorBody },
      },
    },
    async (request) => commitReservation(pool, request.params.id),
  );

  app.post<{ Params: { id: string }; Body: { ttl_minutes: number } }>(
    '/legacy/reservations/:id/extend',
    {
      schema: {
        tags: ['reservations'],
        security,
        summary: 'Renew an active, unexpired reservation without changing stock',
        params: IdParam,
        body: Type.Object({ ttl_minutes: Type.Number({ exclusiveMinimum: 0, maximum: MAX_TTL_MINUTES }) }),
        response: { 200: Reservation, 409: ErrorBody },
      },
    },
    async (request) => extendReservation(pool, request.params.id, request.body.ttl_minutes),
  );

  app.delete<{ Params: { id: string } }>(
    '/legacy/reservations/:id',
    {
      schema: {
        tags: ['reservations'],
        security,
        summary: 'Release a reservation (idempotent)',
        params: IdParam,
        response: { 200: Reservation, 409: ErrorBody },
      },
    },
    async (request) => releaseReservation(pool, request.params.id),
  );

  app.delete<{ Querystring: { idempotency_key: string } }>(
    '/legacy/reservations',
    {
      schema: {
        tags: ['reservations'],
        security,
        summary: 'Release by client key, for a create whose response was lost (idempotent)',
        querystring: Type.Object({ idempotency_key: Type.String({ minLength: 1 }) }),
      },
    },
    async (request) => releaseByKey(pool, request.query.idempotency_key),
  );

  const OutageState = Type.Object({ enabled: Type.Boolean() });
  app.get(OUTAGE_PATH, { schema: { tags: ['admin'], security, response: { 200: OutageState } } }, async () => ({
    enabled: await isOutageEnabled(pool),
  }));
  app.post<{ Body: { enabled: boolean } }>(
    OUTAGE_PATH,
    {
      schema: {
        tags: ['admin'],
        security,
        summary: 'Simulate a source outage. While enabled, every other /legacy/* endpoint returns 503.',
        body: OutageState,
        response: { 200: OutageState },
      },
    },
    async (request) => ({ enabled: await setOutage(pool, request.body.enabled) }),
  );

  app.post(
    '/legacy/admin/expire-sweep',
    { schema: { tags: ['admin'], security, summary: 'Run the reservation expiry sweep now' } },
    async () => ({ expired: await sweepExpiredReservations(pool) }),
  );

  app.post<{ Body: { through_seq: number } }>(
    '/legacy/admin/feed/trim',
    {
      schema: {
        tags: ['admin'],
        security,
        summary: 'Controlled failure: remove old feed rows so that older cursors become invalid',
        body: Type.Object({ through_seq: Type.Integer({ minimum: 1 }) }),
      },
    },
    async (request) => ({ trimmed_through: await trimFeed(pool, request.body.through_seq) }),
  );
}
