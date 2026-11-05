import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { SimError } from '../errors.js';
import { seedSimulator } from '../services/seed.js';
import { constantTimeEqual, endSession, hasSession, startSession } from '../session.js';

export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED';

const POLLED_WITHIN_MS = 30_000;
const CONNECT_GRACE_MS = 30_000;

/**
 * What the simulator can actually observe about OnSite: whether something is reading its change feed. A real
 * legacy system knows no more than that, and it keeps working whether or not anyone is reading.
 */
export class ConnectionTracker {
  lastPollAt: number | null = null;
  connectRequestedAt: number | null = null;

  notePoll(now = Date.now()): void {
    this.lastPollAt = now;
    this.connectRequestedAt = null;
  }

  requestConnect(now = Date.now()): void {
    this.connectRequestedAt = now;
  }

  clearRequest(): void {
    this.connectRequestedAt = null;
  }

  state(outage: boolean, now = Date.now()): ConnectionState {
    const polling = this.lastPollAt !== null && now - this.lastPollAt <= POLLED_WITHIN_MS;
    if (polling) return outage ? 'DEGRADED' : 'CONNECTED';
    if (this.connectRequestedAt !== null && now - this.connectRequestedAt <= CONNECT_GRACE_MS) return 'CONNECTING';
    return 'DISCONNECTED';
  }
}

interface GatewayOptions {
  serviceToken: string;
  dashboardPassword?: string | undefined;
  localSeUrl?: string | undefined;
  tracker: ConnectionTracker;
  internalKey: string;
}

/**
 * The dashboard's backend-for-frontend. The browser holds only an HttpOnly session cookie; these routes make
 * the service-token calls on the server. Each one maps to a specific operation, so this is not an open proxy.
 */
export function registerGateway(app: FastifyInstance, pool: Db, options: GatewayOptions): void {
  const secret = `${options.dashboardPassword ?? randomUUID()}:${options.serviceToken}`;

  const requireSession = async (request: FastifyRequest) => {
    if (!hasSession(request, secret)) throw new SimError(401, 'UNAUTHORIZED', 'Log in to the dashboard first');
  };

  const legacy = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const response = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${options.serviceToken}`, 'x-sim-internal': options.internalKey },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: response.statusCode, body: response.json() as unknown };
  };
  const forward = (reply: { code: (status: number) => { send: (body: unknown) => unknown } }, result: { status: number; body: unknown }) =>
    reply.code(result.status).send(result.body);

  app.post<{ Body: { password: string } }>(
    '/ui-api/login',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Log in to the legacy dashboard',
        body: Type.Object({ password: Type.String({ minLength: 1, maxLength: 200 }) }),
      },
    },
    async (request, reply) => {
      if (!options.dashboardPassword) throw new SimError(503, 'DASHBOARD_DISABLED', 'SIM_DASHBOARD_PASSWORD is not set');
      if (!constantTimeEqual(request.body.password, options.dashboardPassword)) {
        throw new SimError(401, 'INVALID_CREDENTIALS', 'Wrong password');
      }
      startSession(reply, secret);
      return { authenticated: true };
    },
  );
  app.post('/ui-api/logout', { schema: { tags: ['dashboard'] } }, async (_request, reply) => {
    endSession(reply);
    return { authenticated: false };
  });
  app.get('/ui-api/me', { schema: { tags: ['dashboard'] } }, async (request) => ({
    authenticated: hasSession(request, secret),
  }));

  const guarded = { onRequest: requireSession };
  const schema = (summary: string, extra: object = {}) => ({ tags: ['dashboard'], summary, ...extra });

  app.get('/ui-api/stores', { ...guarded, schema: schema('Stores and hub') }, async (_request, reply) =>
    forward(reply, await legacy('GET', '/legacy/stores')),
  );
  app.get('/ui-api/products', { ...guarded, schema: schema('Product catalog') }, async (_request, reply) =>
    forward(reply, await legacy('GET', '/legacy/products?since_seq=0&limit=5000')),
  );
  app.get('/ui-api/inventory', { ...guarded, schema: schema('Stock at every node') }, async (_request, reply) =>
    forward(reply, await legacy('GET', '/legacy/inventory?since_seq=0&limit=5000')),
  );
  app.get<{ Querystring: { node_id?: string; sku_id?: string; limit: number } }>(
    '/ui-api/transactions',
    {
      ...guarded,
      schema: schema('Stock ledger', {
        querystring: Type.Object({
          node_id: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9-]{1,64}$' })),
          sku_id: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9-]{1,64}$' })),
          limit: Type.Integer({ minimum: 1, maximum: 500, default: 100 }),
        }),
      }),
    },
    async (request, reply) => {
      const query = new URLSearchParams({ limit: String(request.query.limit) });
      if (request.query.node_id) query.set('node_id', request.query.node_id);
      if (request.query.sku_id) query.set('sku_id', request.query.sku_id);
      return forward(reply, await legacy('GET', `/legacy/transactions?${query}`));
    },
  );
  app.post<{ Body: unknown }>('/ui-api/receipts', { ...guarded, schema: schema('Receive stock') }, async (request, reply) =>
    forward(reply, await legacy('POST', '/legacy/receipts', request.body)),
  );
  app.post<{ Body: unknown }>('/ui-api/products', { ...guarded, schema: schema('Create a product') }, async (request, reply) =>
    forward(reply, await legacy('POST', '/legacy/products', request.body)),
  );

  const OutageBody = Type.Object({ enabled: Type.Boolean() });
  app.get('/ui-api/outage', { ...guarded, schema: schema('Outage state') }, async (_request, reply) =>
    forward(reply, await legacy('GET', '/legacy/admin/outage')),
  );
  app.post<{ Body: { enabled: boolean } }>(
    '/ui-api/outage',
    { ...guarded, schema: schema('Turn the simulated API outage on or off', { body: OutageBody }) },
    async (request, reply) => forward(reply, await legacy('POST', '/legacy/admin/outage', request.body)),
  );
  app.post<{ Body: { scenario: 'S1' | 'S2'; confirm: string } }>(
    '/ui-api/demo/reset',
    {
      ...guarded,
      schema: schema('DEMO ONLY: re-seed the simulator. Local SE is not touched: use its admin reset for the whole demo.', {
        body: Type.Object({
          scenario: Type.Union([Type.Literal('S1'), Type.Literal('S2')]),
          confirm: Type.String(),
        }),
      }),
    },
    async (request) => {
      if (request.body.confirm !== 'RESET') throw new SimError(400, 'CONFIRMATION_REQUIRED', 'Send confirm="RESET"');
      return seedSimulator(pool, request.body.scenario);
    },
  );

  const localHealth = async (): Promise<boolean> => {
    if (!options.localSeUrl) return false;
    try {
      const response = await fetch(`${options.localSeUrl}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
      return response.ok;
    } catch {
      return false;
    }
  };

  app.get('/ui-api/connection', { ...guarded, schema: schema('What this system can observe about OnSite') }, async () => {
    const outage = (await legacy('GET', '/legacy/admin/outage')).body as { enabled: boolean };
    return {
      state: options.tracker.state(outage.enabled),
      last_poll_at: options.tracker.lastPollAt ? new Date(options.tracker.lastPollAt).toISOString() : null,
      onsite_process_reachable: await localHealth(),
    };
  });

  /** Uses the normal OnSite admin login and API. The credentials are passed on once and never kept. */
  app.post<{ Body: { enabled: boolean; username: string; password: string } }>(
    '/ui-api/onsite/connector',
    {
      ...guarded,
      schema: schema('Ask OnSite Local SE, as one of its admins, to connect or disconnect. This does not install anything.', {
        body: Type.Object({
          enabled: Type.Boolean(),
          username: Type.String({ minLength: 1, maxLength: 100 }),
          password: Type.String({ minLength: 1, maxLength: 200 }),
        }),
      }),
    },
    async (request, reply) => {
      if (!options.localSeUrl) throw new SimError(503, 'ONSITE_NOT_CONFIGURED', 'LOCAL_SE_URL is not set');
      try {
        const login = await fetch(`${options.localSeUrl}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: request.body.username, password: request.body.password }),
          signal: AbortSignal.timeout(5000),
        });
        if (!login.ok) throw new SimError(401, 'ONSITE_LOGIN_FAILED', 'OnSite refused that admin login');
        const { access_token: token } = (await login.json()) as { access_token: string };
        const action = request.body.enabled ? 'enable' : 'disable';
        const result = await fetch(`${options.localSeUrl}/api/v1/admin/connector/${action}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (result.status === 403) throw new SimError(403, 'ONSITE_FORBIDDEN', 'That OnSite account is not an admin');
        if (!result.ok) throw new SimError(502, 'ONSITE_ERROR', `OnSite answered ${result.status}`);
        if (request.body.enabled) options.tracker.requestConnect();
        else options.tracker.clearRequest();
        return reply.send({ enabled: request.body.enabled });
      } catch (error) {
        if (error instanceof SimError) throw error;
        throw new SimError(502, 'ONSITE_UNREACHABLE', 'OnSite Local SE is not running. The simulator keeps working without it.');
      }
    },
  );
}
