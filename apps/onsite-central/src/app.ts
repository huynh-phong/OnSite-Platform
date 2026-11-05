import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest, LogController } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { countriesStatus, dashboard, recentEvents } from './services/dashboard.js';
import {
  ingestEvent,
  isIngestionOffline,
  noteRefusal,
  resetCentral,
  setIngestionOffline,
  type IncomingEvent,
} from './services/ingest.js';
import { constantTimeEqual, endSession, hasSession, startSession } from './session.js';
import { registerStaticUi } from './static-ui.js';

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const IncomingEventSchema = Type.Object({
  event_id: Type.String({ format: 'uuid' }),
  event_type: Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z0-9_.]+$' }),
  origin_country: Type.String({ pattern: '^[A-Z]{2}$' }),
  aggregate_type: Type.String({ minLength: 1, maxLength: 50 }),
  aggregate_id: Type.String({ pattern: '^[A-Za-z0-9-]{1,64}$' }),
  aggregate_version: Type.Integer({ minimum: 1 }),
  occurred_at: Type.String({ format: 'date-time' }),
  payload: Type.Object({}, { additionalProperties: true }),
});

const defaultUiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist/central');

export async function buildApp(config: Config, pool: Db, options: { uiDir?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: { req: (request) => ({ method: request.method, url: request.url.split('?')[0] }) },
    },
    genReqId: () => randomUUID(),
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', request_id: request.id } }),
  );
  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, request_id: request.id } });
    }
    if ('validation' in error && error.validation) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: error.message, request_id: request.id } });
    }
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    return reply.code(status).send({
      error: {
        code: status >= 500 ? 'INTERNAL_ERROR' : (error.code ?? 'BAD_REQUEST'),
        message: status >= 500 ? 'Internal server error' : error.message,
        request_id: request.id,
      },
    });
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'OnSite Central',
        description: 'Aggregation and monitoring of filtered events from each Local deployment. Holds no customer data.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          serviceToken: { type: 'http', scheme: 'bearer' },
          session: { type: 'apiKey', in: 'cookie', name: 'onsite_central_session' },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  const sessionSecret = `${config.adminPassword}:${config.ingestToken}`;
  const hasToken = (request: FastifyRequest) =>
    constantTimeEqual(request.headers.authorization ?? '', `Bearer ${config.ingestToken}`);
  const requireToken = async (request: FastifyRequest) => {
    if (!hasToken(request)) throw new HttpError(401, 'UNAUTHORIZED', 'A valid service token is required');
  };
  const requireAdmin = async (request: FastifyRequest) => {
    if (!hasSession(request, sessionSecret)) throw new HttpError(401, 'UNAUTHORIZED', 'Log in first');
  };
  const session = [{ session: [] }];

  app.post<{ Body: IncomingEvent }>(
    '/ingest/events',
    {
      onRequest: requireToken,
      schema: {
        tags: ['ingest'],
        security: [{ serviceToken: [] }],
        summary: 'Receive one event. 2xx: acknowledged, including duplicates. 4xx: refused for good. 5xx: retry later.',
        body: IncomingEventSchema,
        response: { 200: Type.Object({ result: Type.String() }) },
      },
    },
    async (request) => {
      if (await isIngestionOffline(pool)) {
        await noteRefusal(pool);
        throw new HttpError(503, 'CENTRAL_OFFLINE', 'Simulated Central outage: try again later');
      }
      return { result: await ingestEvent(pool, request.body) };
    },
  );

  app.post<{ Body: { password: string } }>(
    '/auth/login',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Log in to the dashboard',
        body: Type.Object({ password: Type.String({ minLength: 1, maxLength: 200 }) }),
      },
    },
    async (request, reply) => {
      if (!constantTimeEqual(request.body.password, config.adminPassword)) {
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'Wrong password');
      }
      startSession(reply, sessionSecret);
      return { authenticated: true };
    },
  );
  app.post('/auth/logout', { schema: { tags: ['dashboard'] } }, async (_request, reply) => {
    endSession(reply);
    return { authenticated: false };
  });
  app.get('/auth/me', { schema: { tags: ['dashboard'] } }, async (request) => ({
    authenticated: hasSession(request, sessionSecret),
  }));

  app.get(
    '/dashboard',
    { onRequest: requireAdmin, schema: { tags: ['dashboard'], security: session, summary: 'KPIs and sync state from stored events' } },
    async () => dashboard(pool),
  );
  app.get(
    '/countries/status',
    { onRequest: requireAdmin, schema: { tags: ['dashboard'], security: session, summary: 'State of each Local deployment' } },
    async () => countriesStatus(pool),
  );
  app.get<{ Querystring: { limit: number } }>(
    '/events',
    {
      onRequest: requireAdmin,
      schema: {
        tags: ['dashboard'],
        security: session,
        summary: 'Event ingestion history, newest first',
        querystring: Type.Object({ limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }) }),
      },
    },
    async (request) => recentEvents(pool, request.query.limit),
  );

  app.post<{ Body: { enabled: boolean } }>(
    '/admin/offline',
    {
      onRequest: requireAdmin,
      schema: {
        tags: ['admin'],
        security: session,
        summary: 'Simulate a Central ingestion outage. The dashboard stays up; Local keeps working and retries.',
        body: Type.Object({ enabled: Type.Boolean() }),
      },
    },
    async (request) => ({ ingestion_offline: await setIngestionOffline(pool, request.body.enabled) }),
  );
  app.post(
    '/admin/reset',
    {
      schema: {
        tags: ['admin'],
        security: [{ serviceToken: [] }, { session: [] }],
        summary: 'DEMO ONLY: clear all received events and projections. Local SE calls this during its demo reset.',
      },
      onRequest: async (request) => {
        if (!hasToken(request) && !hasSession(request, sessionSecret)) {
          throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
        }
      },
    },
    async () => {
      await resetCentral(pool);
      return { reset: true };
    },
  );

  app.get('/health', { schema: { tags: ['health'], summary: 'Central health' } }, async (_request, reply) => {
    try {
      const offline = await isIngestionOffline(pool);
      return { status: 'ok', db: 'ok', ingestion: offline ? 'simulated_offline' : 'online' };
    } catch {
      return reply.code(503).send({ status: 'degraded', db: 'down', ingestion: 'unavailable' });
    }
  });

  registerStaticUi(app, options.uiDir ?? process.env.CENTRAL_UI_DIR ?? defaultUiDir, 'central.html');
  return app;
}
