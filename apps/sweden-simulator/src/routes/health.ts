import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Db } from '../db.js';

const HealthResponse = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  db: Type.Union([Type.Literal('ok'), Type.Literal('down')]),
});

export function registerHealthRoutes(app: FastifyInstance, pool: Db): void {
  app.get(
    '/health',
    { schema: { tags: ['health'], response: { 200: HealthResponse, 503: HealthResponse } } },
    async (_request, reply) => {
      try {
        await pool.query('SELECT 1');
        return { status: 'ok', db: 'ok' };
      } catch {
        return reply.code(503).send({ status: 'degraded', db: 'down' });
      }
    },
  );
}
