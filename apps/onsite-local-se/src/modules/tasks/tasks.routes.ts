import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { principalOf, requireRole, type AuthOptions } from '../../auth.js';
import type { DocumentsService } from '../documents/documents.service.js';
import { DocumentHeader, TaskDocument } from '../orders/orders.routes.js';
import { TASK_STATUSES } from '../orders/state-machine.js';
import { bearer, errors, Nullable, Timestamp, UuidParam, VersionBody } from '../routes-common.js';
import type { TasksService } from './tasks.service.js';

const TaskResult = Type.Object({
  task_id: Type.String(),
  status: Type.String(),
  version: Type.Integer(),
  node_id: Type.String(),
  order_id: Type.String(),
  order_status: Type.String(),
  order_version: Type.Integer(),
  eta: Nullable(Timestamp),
  at_risk: Type.Boolean(),
});

export function registerTaskRoutes(
  app: FastifyInstance,
  auth: AuthOptions,
  tasks: TasksService,
  documents: DocumentsService,
): void {
  const staffOnly = requireRole(auth, 'staff');
  const actionSchema = (summary: string, body: object, codes: number[]) => ({
    tags: ['tasks'],
    security: bearer,
    summary,
    params: UuidParam,
    body,
    response: { 200: TaskResult, ...errors(400, 401, 403, 404, 409, ...codes) },
  });

  app.get<{ Querystring: { status?: string } }>(
    '/api/v1/staff/tasks',
    {
      onRequest: requireRole(auth, 'staff', 'admin'),
      schema: {
        tags: ['tasks'],
        security: bearer,
        summary: "Tasks of your own node (taken from the token). Admins see all nodes' tasks.",
        querystring: Type.Object({ status: Type.Optional(Type.Unsafe<string>({ type: 'string', enum: [...TASK_STATUSES] })) }),
        response: {
          200: Type.Array(
            Type.Object({
              task_id: Type.String(),
              order_id: Type.String(),
              node_id: Type.String(),
              status: Type.String(),
              version: Type.Integer(),
              order_status: Type.String(),
              allocated_qty: Type.Integer(),
              requested_delivery_at: Timestamp,
              eta: Nullable(Timestamp),
              at_risk: Type.Boolean(),
              reservation_health: Type.String({
                description: 'OK, RENEWAL_FAILING, LOST or NOT_APPLICABLE. LOST blocks dispatch.',
              }),
              reject_reason: Nullable(Type.String()),
              created_at: Timestamp,
            }),
          ),
          ...errors(401, 403),
        },
      },
    },
    async (request) => tasks.list(principalOf(request), request.query.status),
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/staff/tasks/:id/picklist',
    {
      onRequest: requireRole(auth, 'staff', 'admin'),
      schema: {
        tags: ['documents'],
        security: bearer,
        summary: 'Picking list for one shipping node. Not a tax invoice.',
        params: UuidParam,
        response: {
          200: Type.Object({ document_type: Type.Literal('picking_list'), ...DocumentHeader, ...TaskDocument }),
          ...errors(401, 403, 404),
        },
      },
    },
    async (request) => documents.pickingList(request.params.id, principalOf(request)),
  );

  app.post<{ Params: { id: string }; Body: { version: number } }>(
    '/api/v1/staff/tasks/:id/approve',
    {
      onRequest: staffOnly,
      schema: actionSchema(
        'Approve this node\'s part. The reservations are checked at the source first.',
        VersionBody,
        [503],
      ),
    },
    async (request) => tasks.approve(request.params.id, principalOf(request), request.body.version),
  );

  app.post<{ Params: { id: string }; Body: { version: number; reason: string } }>(
    '/api/v1/staff/tasks/:id/reject',
    {
      onRequest: staffOnly,
      schema: actionSchema(
        "Reject this node's part. Its stock is released and the missing quantity is looked for elsewhere.",
        Type.Object({ version: Type.Integer({ minimum: 1 }), reason: Type.String({ minLength: 1, maxLength: 500 }) }),
        [],
      ),
    },
    async (request) => tasks.reject(request.params.id, principalOf(request), request.body.version, request.body.reason),
  );

  app.post<{ Params: { id: string }; Body: { version: number } }>(
    '/api/v1/staff/tasks/:id/dispatch',
    {
      onRequest: staffOnly,
      schema: actionSchema('Dispatch and commit the reservation at the source.', VersionBody, [503]),
    },
    async (request) => tasks.dispatch(request.params.id, principalOf(request), request.body.version),
  );

  app.post<{ Params: { id: string }; Body: { version: number; delivered_qty: number; note?: string } }>(
    '/api/v1/staff/tasks/:id/deliver',
    {
      onRequest: staffOnly,
      schema: actionSchema(
        'Confirm delivery. Less than the allocated quantity marks the shipment short.',
        Type.Object({
          version: Type.Integer({ minimum: 1 }),
          delivered_qty: Type.Integer({ minimum: 0 }),
          note: Type.Optional(Type.String({ maxLength: 500 })),
        }),
        [422],
      ),
    },
    async (request) =>
      tasks.deliver(
        request.params.id,
        principalOf(request),
        request.body.version,
        request.body.delivered_qty,
        request.body.note,
      ),
  );
}
