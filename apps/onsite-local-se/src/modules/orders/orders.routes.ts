import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { principalOf, requireRole, type AuthOptions } from '../../auth.js';
import type { DocumentsService } from '../documents/documents.service.js';
import { bearer, emptyBodyOk, errors, IdParam, Nullable, Timestamp } from '../routes-common.js';
import type { CreateOrderBody, OrdersService } from './orders.service.js';
import { ORDER_STATUSES } from './state-machine.js';

const OrderStatus = Type.Unsafe<string>({ type: 'string', enum: [...ORDER_STATUSES] });

const OrderView = Type.Object({
  order_id: Type.String(),
  status: OrderStatus,
  review_reason: Nullable(Type.String()),
  fulfillable_qty: Nullable(Type.Integer()),
  early_shortage_detected: Type.Boolean(),
  sales_store_id: Type.String(),
  site_id: Type.String(),
  requested_delivery_at: Timestamp,
  inventory_as_of: Nullable(Timestamp),
  reservation_expires_at: Nullable(Timestamp),
  eta: Nullable(Timestamp),
  eta_is_estimate: Type.Boolean(),
  at_risk: Type.Boolean(),
  at_risk_reason: Nullable(Type.String()),
  approved_at: Nullable(Timestamp),
  delivered_at: Nullable(Timestamp),
  otif: Nullable(Type.Boolean()),
  version: Type.Integer(),
  created_at: Timestamp,
  items: Type.Array(
    Type.Object({
      sku_id: Type.String(),
      quantity: Type.Integer(),
      unit: Type.String(),
      unit_price_sek: Type.Number(),
    }),
  ),
  allocations: Type.Array(
    Type.Object({ node_id: Type.String(), sku_id: Type.String(), quantity: Type.Integer(), reason: Type.String() }),
  ),
  shipments: Type.Array(
    Type.Object({
      task_id: Type.String(),
      node_id: Type.String(),
      status: Type.String(),
      task_version: Type.Integer(),
      dispatch_slot: Nullable(Timestamp),
      eta: Nullable(Timestamp),
      eta_inputs: Type.Any({ description: 'The parameters the ETA was calculated from' }),
      is_short: Type.Boolean(),
      dispatched_at: Nullable(Timestamp),
      delivered_at: Nullable(Timestamp),
      delivered_qty: Nullable(Type.Integer()),
      reservation_health: Type.String(),
    }),
  ),
  events: Type.Array(
    Type.Object({
      type: Type.String(),
      version: Type.Integer(),
      occurred_at: Timestamp,
      actor: Type.Optional(Type.String()),
      data: Type.Optional(Type.Any()),
    }),
  ),
});

const DocumentLine = Type.Object({
  sku_id: Type.String(),
  name: Type.String(),
  quantity: Type.Integer(),
  unit: Type.String(),
  unit_price_sek: Type.Number(),
  line_total_sek: Type.Number(),
});
export const DocumentHeader = {
  not_a_tax_invoice: Type.Boolean(),
  prices_are_simulated: Type.Boolean(),
  order_id: Type.String(),
  customer_company: Nullable(Type.String()),
  sales_store: Type.Object({ store_id: Type.String(), name: Nullable(Type.String()) }),
  site_id: Type.String(),
  site_address: Nullable(Type.String()),
  requested_delivery_at: Timestamp,
  order_status: Type.String(),
  eta: Nullable(Timestamp),
  eta_is_estimate: Type.Boolean(),
};
export const TaskDocument = {
  task_id: Type.String(),
  shipping_node: Type.Object({ node_id: Type.String(), name: Nullable(Type.String()) }),
  status: Type.String(),
  eta: Nullable(Timestamp),
  approver: Nullable(Type.String()),
  approved_at: Nullable(Timestamp),
  lines: Type.Array(DocumentLine),
};

export function registerOrderRoutes(
  app: FastifyInstance,
  auth: AuthOptions,
  orders: OrdersService,
  documents: DocumentsService,
): void {
  app.post<{ Body: CreateOrderBody; Headers: { 'idempotency-key': string } }>(
    '/api/v1/orders',
    {
      onRequest: requireRole(auth, 'customer'),
      schema: {
        tags: ['orders'],
        security: bearer,
        summary: 'Place an order. A shortage or source problem returns 201 with status NEEDS_REVIEW and the reason.',
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 1, maxLength: 200 }) }),
        body: Type.Object({
          sales_store_id: Type.String({ minLength: 1 }),
          site_id: Type.String({ minLength: 1 }),
          requested_delivery_at: Type.String({ format: 'date-time' }),
          items: Type.Array(
            Type.Object({
              sku_id: Type.String({ minLength: 1 }),
              quantity: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
              unit: Type.String({ minLength: 1 }),
            }),
            { minItems: 1, maxItems: 100 },
          ),
        }),
        response: { 201: OrderView, ...errors(400, 401, 403, 409, 422) },
      },
    },
    async (request, reply) => {
      const result = await orders.create(principalOf(request), request.headers['idempotency-key'], request.body);
      return reply.code(result.statusCode).send(result.body);
    },
  );

  app.get<{ Querystring: { status?: string } }>(
    '/api/v1/orders',
    {
      onRequest: requireRole(auth),
      schema: {
        tags: ['orders'],
        security: bearer,
        summary: 'Latest 100 orders in your scope: a customer their own, staff their node, an admin all',
        querystring: Type.Object({ status: Type.Optional(OrderStatus) }),
        response: {
          200: Type.Array(
            Type.Object({
              order_id: Type.String(),
              status: Type.String(),
              sales_store_id: Type.String(),
              site_id: Type.String(),
              requested_delivery_at: Timestamp,
              eta: Nullable(Timestamp),
              at_risk: Type.Boolean(),
              version: Type.Integer(),
              created_at: Timestamp,
            }),
          ),
          ...errors(401),
        },
      },
    },
    async (request) => orders.list(principalOf(request), request.query.status),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/orders/:id',
    {
      onRequest: requireRole(auth),
      schema: {
        tags: ['orders'],
        security: bearer,
        summary: 'Status, shipments, ETA, at-risk flag and history',
        params: IdParam,
        response: { 200: OrderView, ...errors(401, 403, 404) },
      },
    },
    async (request) => orders.get(request.params.id, principalOf(request)),
  );

  app.post<{ Params: { id: string }; Body: { version?: number } }>(
    '/api/v1/orders/:id/cancel',
    {
      onRequest: requireRole(auth, 'customer', 'admin'),
      preValidation: emptyBodyOk,
      schema: {
        tags: ['orders'],
        security: bearer,
        summary: 'Cancel and release all stock. Customers: before approval. Admins: also once APPROVED, before dispatch.',
        params: IdParam,
        body: Type.Object({ version: Type.Optional(Type.Integer({ minimum: 1 })) }),
        response: { 200: OrderView, ...errors(401, 403, 404, 409) },
      },
    },
    async (request) => orders.cancel(request.params.id, principalOf(request), request.body.version),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/orders/:id/confirmation',
    {
      onRequest: requireRole(auth),
      schema: {
        tags: ['documents'],
        security: bearer,
        summary: 'Order confirmation with delivery batches, once APPROVED. Not a tax invoice.',
        params: IdParam,
        response: {
          200: Type.Object({
            document_type: Type.Literal('order_confirmation'),
            ...DocumentHeader,
            shipments: Type.Array(Type.Object(TaskDocument)),
          }),
          ...errors(401, 403, 404, 409),
        },
      },
    },
    async (request) => documents.orderConfirmation(request.params.id, principalOf(request)),
  );
}
