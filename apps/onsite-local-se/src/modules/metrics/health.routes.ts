import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { requireRole, type AuthOptions } from '../../auth.js';
import type { SimulatorClient } from '../../connectors/simulator.js';
import type { Db } from '../../db.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import { bearer, errors, Nullable, Timestamp } from '../routes-common.js';
import type { DemoService } from './demo.service.js';
import { checkHealth } from './health.service.js';
import type { MetricsService } from './metrics.service.js';

const HealthResponse = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  db: Type.Union([Type.Literal('ok'), Type.Literal('down')]),
  simulator: Type.Union([Type.Literal('ok'), Type.Literal('down'), Type.Literal('disabled')]),
  central: Type.Union([Type.Literal('not_configured'), Type.Literal('configured')]),
});

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { pool: Db; simulator: SimulatorClient; centralUrl?: string | undefined },
): void {
  app.get(
    '/api/v1/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Local SE health, including its dependencies',
        response: { 200: HealthResponse, 503: HealthResponse },
      },
    },
    async (_request, reply) => {
      const report = await checkHealth(deps.pool, deps.simulator, deps.centralUrl);
      // A simulator outage degrades Local SE but it keeps serving; only a lost DB makes it unhealthy.
      return reply.code(report.db === 'ok' ? 200 : 503).send(report);
    },
  );
}

export function registerAdminRoutes(
  app: FastifyInstance,
  auth: AuthOptions,
  metrics: MetricsService,
  inventory: InventoryService,
  simulator: SimulatorClient,
  demo: DemoService,
): void {
  const adminOnly = requireRole(auth, 'admin');

  app.get(
    '/api/v1/system/status',
    {
      onRequest: requireRole(auth),
      schema: {
        tags: ['health'],
        security: bearer,
        summary: 'Whether stock can be trusted right now and whether the source is reachable, for operational warnings',
        response: {
          200: Type.Object({
            inventory_trusted: Type.Boolean(),
            stale_reason: Nullable(Type.String()),
            last_successful_sync_at: Nullable(Timestamp),
            verified_age_s: Nullable(Type.Number()),
            stale_after_s: Type.Number(),
            connector_enabled: Type.Boolean(),
            source_reachable: Type.Boolean(),
          }),
          ...errors(401),
        },
      },
    },
    async () => {
      const freshness = await inventory.freshness();
      return {
        inventory_trusted: freshness.trusted,
        stale_reason: freshness.staleReason,
        last_successful_sync_at: freshness.lastSuccessfulSyncAt?.toISOString() ?? null,
        verified_age_s: freshness.verifiedAgeSeconds,
        stale_after_s: inventory.staleAfterSeconds,
        connector_enabled: simulator.enabled,
        source_reachable: await simulator.isReachable(),
      };
    },
  );

  app.post<{ Body: { scenario: 'S1' | 'S2'; confirm: string; connector?: 'enabled' | 'disabled' } }>(
    '/api/v1/admin/demo/reset',
    {
      onRequest: adminOnly,
      schema: {
        tags: ['admin'],
        security: bearer,
        summary:
          'DEMO ONLY: wipes and re-seeds all demo data in the simulator, Local SE and Central. Needs DEMO_RESET_ENABLED=true and confirm="RESET".',
        body: Type.Object({
          scenario: Type.Union([Type.Literal('S1'), Type.Literal('S2')]),
          confirm: Type.String(),
          connector: Type.Optional(Type.Union([Type.Literal('enabled'), Type.Literal('disabled')])),
        }),
        response: {
          200: Type.Object({ scenario: Type.String(), connector_enabled: Type.Boolean(), central: Type.String() }),
          ...errors(400, 401, 403, 409, 503),
        },
      },
    },
    async (request) => demo.reset(request.body.scenario, request.body.confirm, request.body.connector ?? 'enabled'),
  );

  app.get(
    '/api/v1/metrics',
    {
      onRequest: adminOnly,
      schema: {
        tags: ['metrics'],
        security: bearer,
        summary: 'Technical, AI and (simulated) business metrics as JSON',
        response: {
          200: Type.Object(
            {
              api: Type.Any(),
              inventory: Type.Any(),
              outbox: Type.Any(),
              reservations: Type.Any(),
              ai: Type.Any(),
              business: Type.Any(),
            },
            { additionalProperties: true },
          ),
          ...errors(401, 403),
        },
      },
    },
    async () => metrics.snapshot(),
  );

  const ConnectorState = Type.Object({ enabled: Type.Boolean() });
  for (const [path, enabled] of [
    ['/api/v1/admin/connector/enable', true],
    ['/api/v1/admin/connector/disable', false],
  ] as const) {
    app.post(
      path,
      {
        onRequest: adminOnly,
        schema: {
          tags: ['admin'],
          security: bearer,
          summary: enabled
            ? 'Reconnect to the source system'
            : 'Disconnect from the source system: stock stops being trusted and new orders go to NEEDS_REVIEW',
          response: { 200: ConnectorState, ...errors(401, 403) },
        },
      },
      async (request) => inventory.setConnectorEnabled(enabled, request.principal!.sub),
    );
  }
}
