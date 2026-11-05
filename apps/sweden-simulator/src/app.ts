import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Db } from './db.js';
import { registerErrorHandling } from './errors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLegacyRoutes } from './routes/legacy.js';

export async function buildApp(pool: Db, options: { serviceToken: string }): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: {
        req: (request) => ({ method: request.method, url: request.url.split('?')[0] }),
      },
    },
    genReqId: () => randomUUID(),
    requestIdLogLabel: 'request_id',
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  registerErrorHandling(app);

  await app.register(swagger, {
    openapi: {
      info: { title: 'Sweden Legacy Simulator', description: 'SIMULATED ERP/WMS.', version: '0.2.0' },
      components: { securitySchemes: { serviceToken: { type: 'http', scheme: 'bearer' } } },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  registerHealthRoutes(app, pool);
  registerLegacyRoutes(app, pool, options.serviceToken);
  return app;
}
