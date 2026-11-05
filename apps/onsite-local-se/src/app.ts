import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Config } from './config.js';
import { buildContainer, type Container, type ContainerOptions } from './container.js';
import type { Db } from './db.js';
import { registerErrorHandling } from './errors.js';
import { registerAuditHook } from './modules/audit/audit.hook.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { AuthService } from './modules/auth/auth.service.js';
import { registerCatalogRoutes } from './modules/catalog/catalog.routes.js';
import { registerAdminRoutes, registerHealthRoutes } from './modules/metrics/health.routes.js';
import { registerNormalizationRoutes } from './modules/normalization/normalization.routes.js';
import { registerStreamRoutes } from './modules/notifications/stream.routes.js';
import { registerOrderRoutes } from './modules/orders/orders.routes.js';
import { registerTaskRoutes } from './modules/tasks/tasks.routes.js';

declare module 'fastify' {
  interface FastifyInstance {
    container: Container;
  }
}

export async function buildApp(config: Config, pool: Db, options: ContainerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: {
        // The query string is dropped because the SSE stream accepts ?token=.
        req: (request) => ({ method: request.method, url: request.url.split('?')[0] }),
      },
    },
    genReqId: () => randomUUID(),
    requestIdLogLabel: 'request_id',
  });

  const container = buildContainer(config, pool, app.log, options);
  app.decorate('container', container);
  await container.inventory.loadConnectorState();

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.addHook('onResponse', async (_request, reply) => {
    container.latency.record(reply.elapsedTime);
  });
  // SSE clients are held open, so they must be closed for the server to stop.
  app.addHook('preClose', async () => {
    container.hub.closeAll();
  });
  registerAuditHook(app, pool);
  registerErrorHandling(app);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'OnSite Local SE API',
        description:
          'B2B order fulfilment middleware for Sweden. Demo environment: source system, prices, distances and slots are simulated.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  const auth = { jwtSecret: config.jwtSecret, countryCode: config.countryCode };
  registerHealthRoutes(app, { pool, simulator: container.simulator, centralUrl: config.centralIngestUrl });
  registerAdminRoutes(app, auth, container.metrics, container.inventory, container.simulator, container.demo);
  registerAuthRoutes(app, new AuthService(pool, config));
  registerCatalogRoutes(app, auth, container.catalog);
  registerOrderRoutes(app, auth, container.orders, container.documents);
  registerTaskRoutes(app, auth, container.tasks, container.documents);
  registerNormalizationRoutes(app, auth, container.normalization);
  registerStreamRoutes(app, auth, container.hub);

  return app;
}
