import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { principalOf, requireRole, type AuthOptions } from '../../auth.js';
import { bearer, emptyBodyOk, errors, Nullable, Timestamp, UuidParam } from '../routes-common.js';
import type { ReviewRow } from './normalization.repository.js';
import type { NormalizationService } from './normalization.service.js';

const Review = Type.Object({
  review_id: Type.String(),
  source_system: Type.String(),
  field: Type.String(),
  raw_value: Type.String(),
  source_description: Nullable(Type.String()),
  ai_status: Type.String({ description: 'QUEUED, IN_PROGRESS, COMPLETED, or FAILED for manual review' }),
  ai_suggestion: Nullable(Type.String()),
  confidence: Nullable(Type.Number()),
  ai_reason: Nullable(Type.String()),
  ai_evidence: Nullable(Type.String()),
  model_version: Nullable(Type.String()),
  pending_record_count: Type.Integer(),
  status: Type.String(),
  outcome: Nullable(Type.String()),
  final_value: Nullable(Type.String()),
  reviewed_by: Nullable(Type.String()),
  reviewed_at: Nullable(Timestamp),
  reject_reason: Nullable(Type.String()),
  created_at: Timestamp,
  age_seconds: Type.Number(),
});

function toView(row: ReviewRow) {
  return {
    review_id: row.review_id,
    source_system: row.source_system,
    field: row.field,
    raw_value: row.raw_value,
    source_description: row.source_description,
    ai_status: row.ai_status,
    ai_suggestion: row.ai_suggestion,
    confidence: row.confidence === null ? null : Number(row.confidence),
    ai_reason: row.ai_reason,
    ai_evidence: row.ai_evidence,
    model_version: row.model_version,
    pending_record_count: row.pending_record_count,
    status: row.status,
    outcome: row.outcome,
    final_value: row.final_value,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at?.toISOString() ?? null,
    reject_reason: row.reject_reason,
    created_at: row.created_at.toISOString(),
    age_seconds: (Date.now() - row.created_at.getTime()) / 1000,
  };
}

export function registerNormalizationRoutes(app: FastifyInstance, auth: AuthOptions, service: NormalizationService): void {
  const staffOrAdmin = requireRole(auth, 'staff', 'admin');
  const conflict = errors(400, 401, 403, 404, 409, 422);

  app.get<{ Querystring: { status?: string } }>(
    '/api/v1/staff/normalization-reviews',
    {
      onRequest: staffOrAdmin,
      schema: {
        tags: ['normalization'],
        security: bearer,
        summary: 'AI suggestions waiting for a human decision',
        querystring: Type.Object({
          status: Type.Optional(
            Type.Union([Type.Literal('PENDING'), Type.Literal('APPROVED'), Type.Literal('REJECTED')]),
          ),
        }),
        response: { 200: Type.Array(Review), ...errors(401, 403) },
      },
    },
    async (request) => (await service.listReviews(request.query.status)).map(toView),
  );

  app.post<{ Params: { id: string }; Body: { value?: string } }>(
    '/api/v1/staff/normalization-reviews/:id/approve',
    {
      onRequest: staffOrAdmin,
      preValidation: emptyBodyOk,
      schema: {
        tags: ['normalization'],
        security: bearer,
        summary: 'Approve the suggestion, or approve your edited value, and replay the waiting records',
        params: UuidParam,
        body: Type.Object({ value: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }),
        response: { 200: Review, ...conflict },
      },
    },
    async (request) => toView(await service.approve(request.params.id, request.body.value, principalOf(request).sub)),
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/v1/staff/normalization-reviews/:id/reject',
    {
      onRequest: staffOrAdmin,
      preValidation: emptyBodyOk,
      schema: {
        tags: ['normalization'],
        security: bearer,
        summary: 'Reject. The waiting records stay hidden, for manual handling.',
        params: UuidParam,
        body: Type.Object({ reason: Type.Optional(Type.String({ maxLength: 500 })) }),
        response: { 200: Review, ...conflict },
      },
    },
    async (request) => toView(await service.reject(request.params.id, request.body.reason, principalOf(request).sub)),
  );
}
