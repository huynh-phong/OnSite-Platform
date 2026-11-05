import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Db } from './db.js';
import { registerErrorHandling } from './errors.js';
import { registerHealthRoutes } from './routes/health.js';
import { ConnectionTracker, registerGateway } from './routes/gateway.js';
import { registerLegacyRoutes } from './routes/legacy.js';
import { registerStaticUi } from './static-ui.js';

const defaultUiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist/legacy');

export interface AppOptions {
  serviceToken: string;
  dashboardPassword?: string | undefined;
  localSeUrl?: string | undefined;
  uiDir?: string | undefined;
}

export async function buildApp(pool: Db, options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: {
        req: (request) => ({ method: request.method, url: request.url.split('?')[0] }),
      },
    },
    genReqId: () => randomUUID(),
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
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
  const tracker = new ConnectionTracker();
  const internalKey = randomUUID();
  registerLegacyRoutes(app, pool, {
    serviceToken: options.serviceToken,
    onFeedPoll: () => tracker.notePoll(),
    internalKey,
  });
  registerGateway(app, pool, {
    serviceToken: options.serviceToken,
    dashboardPassword: options.dashboardPassword,
    localSeUrl: options.localSeUrl,
    tracker,
    internalKey,
  });
  registerStaticUi(app, options.uiDir ?? process.env.SIM_UI_DIR ?? defaultUiDir, 'legacy.html');
  return app;
}
