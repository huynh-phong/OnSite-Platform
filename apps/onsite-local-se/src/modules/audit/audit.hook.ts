import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** For a route that identifies its caller itself, like login. */
    auditActor?: string;
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Records every state-changing request and every refused one: who, what, which resource, the outcome and
 * the request id. The resource is the path only, and bodies are never stored, so no token or raw PII can
 * end up here. Awaited before the response is sent, so a refusal is on record by the time the caller sees it.
 */
export function registerAuditHook(app: FastifyInstance, pool: Db): void {
  app.addHook('onSend', async (request, reply) => {
    const refused = reply.statusCode === 401 || reply.statusCode === 403;
    if (READ_METHODS.has(request.method) && !refused) return;
    const route = request.routeOptions.url;
    if (!route) return;
    try {
      await pool.query(
        `INSERT INTO audit_logs (actor, action, resource, result, request_id) VALUES ($1, $2, $3, $4, $5)`,
        [
          request.principal?.sub ?? request.auditActor ?? 'anonymous',
          `${request.method} ${route}`,
          request.url.split('?')[0],
          String(reply.statusCode),
          request.id,
        ],
      );
    } catch (error) {
      request.log.error({ err: error }, 'audit write failed');
    }
  });
}
