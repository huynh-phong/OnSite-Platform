import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { requireRole, type AuthOptions } from '../../auth.js';
import { bearer, errors, Nullable } from '../routes-common.js';
import { MAX_ORDER_TEXT } from './order-draft.js';
import type { OrderIntakeService } from './order-intake.service.js';

export function registerIntakeRoutes(app: FastifyInstance, auth: AuthOptions, intake: OrderIntakeService): void {
  app.post<{ Body: { text: string } }>(
    '/api/v1/orders/parse',
    {
      onRequest: requireRole(auth, 'customer'),
      schema: {
        tags: ['orders'],
        security: bearer,
        summary:
          'AI reads a free-text order into draft lines for the customer to check. Stores nothing and orders nothing. Contact details are removed before the text is sent.',
        body: Type.Object({ text: Type.String({ minLength: 1, maxLength: MAX_ORDER_TEXT }) }),
        response: {
          200: Type.Object({
            lines: Type.Array(
              Type.Object({
                sku_id: Nullable(Type.String()),
                name: Nullable(Type.String()),
                quantity: Type.Integer(),
                unit: Nullable(Type.String()),
                unit_text: Type.String(),
                stated_unit: Nullable(Type.String()),
                source_text: Type.String(),
                confidence: Type.Number(),
                reason: Type.String(),
                checks: Type.Array(
                  Type.Union([Type.Literal('NO_PRODUCT'), Type.Literal('LOW_CONFIDENCE'), Type.Literal('UNIT_MISMATCH')]),
                ),
              }),
            ),
            dropped_lines: Type.Integer({ description: 'Lines the reader returned that failed the checks, and were left out' }),
            contact_details_removed: Type.Integer(),
            model: Type.String(),
            draft_only: Type.Literal(true),
          }),
          ...errors(400, 401, 403, 422, 503),
        },
      },
    },
    async (request) => intake.parse(request.body.text),
  );
}
