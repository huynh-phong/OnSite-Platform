import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { bearerToken, verifyToken, type AuthOptions, type Principal } from '../../auth.js';
import { AppError } from '../../errors.js';
import { bearer, errors } from '../routes-common.js';
import type { NotificationHub } from './hub.js';

const HEARTBEAT_MS = 25_000;

export function registerStreamRoutes(app: FastifyInstance, auth: AuthOptions, hub: NotificationHub): void {
  app.get<{ Querystring: { token?: string } }>(
    '/api/v1/stream',
    {
      // EventSource in a browser cannot set headers, hence ?token=. Query strings are not logged.
      onRequest: async (request) => {
        const token = bearerToken(request) ?? request.query.token;
        if (!token) throw new AppError(401, 'UNAUTHORIZED', 'A valid token is required');
        request.principal = verifyToken(token, auth.jwtSecret, auth.countryCode);
      },
      schema: {
        tags: ['notifications'],
        security: bearer,
        summary:
          'Server-Sent Events: task.assigned, task.updated, order.updated, order.at_risk, review.created. Staff get their node only, customers their orders only. A hint only: read the data over REST.',
        querystring: Type.Object({ token: Type.Optional(Type.String()) }),
        response: errors(401, 403),
      },
    },
    async (request, reply) => {
      const principal = request.principal as Principal;
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-request-id': request.id,
      });
      raw.write(': connected\n\n');

      const heartbeat = setInterval(() => raw.write(': keep-alive\n\n'), HEARTBEAT_MS);
      heartbeat.unref();
      const unsubscribe = hub.subscribe({
        role: principal.role,
        storeId: principal.store_id,
        customerId: principal.customer_id,
        send: ({ type, data }) => raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
        close: () => raw.end(),
      });
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  );
}
