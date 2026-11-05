import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { Config } from '../../config.js';
import type { SourceInventory, SourceProduct } from '../../connectors/simulator.js';
import { callLlm, type LlmProvider } from '../../connectors/llm.js';
import type { Db } from '../../db.js';
import { AppError } from '../../errors.js';
import { inTx } from '../../tx.js';
import { upsertInventoryRow } from '../inventory/inventory.repository.js';
import { bumpCounter, COUNTERS, readCounters } from '../metrics/counters.js';
import type { NotificationHub } from '../notifications/hub.js';
import { hashRawValue, normalizeRawValue, type NormalizationField } from './key.js';
import * as repo from './normalization.repository.js';
import { allowedValues, isValidNormalizedValue, statesPackWeight } from './values.js';

export type Resolution = { status: 'APPROVED'; value: string } | { status: 'PENDING' } | { status: 'REJECTED' };

/** Per-transaction lookup cache and tallies, written once at the end. */
export interface ResolverSession {
  mappings: Map<string, string>;
  hits: Map<string, { field: string; hash: string; count: number }>;
  records: number;
  /** A replay after approval is not a new incoming record, so it does not count as a hit. */
  countStats: boolean;
}

const AI_UNAVAILABLE_REASON = 'AI unavailable – manual review';
const AI_BATCH = 5;

export class NormalizationService {
  private queueRun: Promise<void> | undefined;

  constructor(
    private readonly pool: Db,
    private readonly hub: NotificationHub,
    private readonly config: Config,
    private readonly llm: LlmProvider,
    private readonly log: FastifyBaseLogger,
  ) {}

  newSession(countStats = true): ResolverSession {
    return { mappings: new Map(), hits: new Map(), records: 0, countStats };
  }

  /** Mapping first, then an existing review, and only then a new one. Never calls the LLM. */
  private async resolve(
    client: pg.PoolClient,
    session: ResolverSession,
    input: {
      field: NormalizationField;
      raw: string;
      description: string | null;
      entityType: 'product' | 'inventory';
      entityId: string;
      payload: unknown;
    },
  ): Promise<Resolution> {
    const source = this.config.sourceSystem;
    const hash = hashRawValue(input.raw);
    const cacheKey = `${input.field}:${hash}`;
    if (session.countStats) session.records += 1;

    let value = session.mappings.get(cacheKey);
    if (value === undefined) {
      value = await repo.findApprovedMapping(client, source, input.field, hash);
      if (value !== undefined) session.mappings.set(cacheKey, value);
    }
    if (value !== undefined) {
      if (session.countStats) {
        const hit = session.hits.get(cacheKey) ?? { field: input.field, hash, count: 0 };
        hit.count += 1;
        session.hits.set(cacheKey, hit);
      }
      return { status: 'APPROVED', value };
    }

    const rejected = await repo.findRejectedReview(client, source, input.field, hash);
    if (rejected) {
      await repo.attachRecord(client, {
        reviewId: rejected.review_id,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: input.payload,
        status: 'MANUAL',
      });
      return { status: 'REJECTED' };
    }

    const review = await repo.findOrCreatePendingReview(client, {
      source,
      field: input.field,
      hash,
      raw: normalizeRawValue(input.raw),
      description: input.description,
    });
    await repo.attachRecord(client, {
      reviewId: review.review_id,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
      status: 'WAITING',
    });
    return { status: 'PENDING' };
  }

  /** A product is ACTIVE only once every mandatory value has an approved mapping. */
  async ingestProduct(
    client: pg.PoolClient,
    session: ResolverSession,
    item: SourceProduct,
    ignoreVersion: boolean,
  ): Promise<void> {
    const common = {
      description: item.source_description,
      entityType: 'product' as const,
      entityId: item.sku_id,
      payload: item,
    };
    const unit = await this.resolve(client, session, { ...common, field: 'unit', raw: item.source_unit });
    const category = await this.resolve(client, session, { ...common, field: 'category', raw: item.source_category });
    const pack = statesPackWeight(item.source_description)
      ? await this.resolve(client, session, { ...common, field: 'pack_size_kg', raw: item.source_description })
      : undefined;

    const approved = (resolution: Resolution | undefined) =>
      resolution?.status === 'APPROVED' ? resolution.value : null;
    const complete =
      unit.status === 'APPROVED' && category.status === 'APPROVED' && (pack === undefined || pack.status === 'APPROVED');

    await repo.upsertProduct(
      client,
      {
        sku_id: item.sku_id,
        name: item.name,
        category: approved(category),
        base_unit: approved(unit),
        pack_size_verified: approved(pack),
        unit_price: item.unit_price_sek,
        status: complete ? 'ACTIVE' : 'PENDING_REVIEW',
        source_version: item.version,
        source_unit: item.source_unit,
        source_category: item.source_category,
        source_description: item.source_description,
      },
      ignoreVersion,
    );
  }

  /** Stock whose unit is not yet approved is stored but flagged, and never counts as usable. */
  async ingestInventory(
    client: pg.PoolClient,
    session: ResolverSession,
    item: SourceInventory,
    ignoreVersion: boolean,
  ): Promise<void> {
    const resolution = await this.resolve(client, session, {
      field: 'unit',
      raw: item.source_unit,
      description: null,
      entityType: 'inventory',
      entityId: `${item.node_id}:${item.sku_id}`,
      payload: item,
    });

    await upsertInventoryRow(
      client,
      item,
      {
        normalizedUnit: resolution.status === 'APPROVED' ? resolution.value : null,
        pending: resolution.status !== 'APPROVED',
      },
      ignoreVersion,
    );
  }

  async flush(client: pg.PoolClient, session: ResolverSession): Promise<void> {
    let total = 0;
    for (const hit of session.hits.values()) {
      await repo.addMappingHits(client, this.config.sourceSystem, hit.field, hit.hash, hit.count);
      total += hit.count;
    }
    await bumpCounter(client, COUNTERS.cacheHits, total);
    await bumpCounter(client, COUNTERS.records, session.records);
  }

  /**
   * Works through queued reviews with no transaction open during the LLM call. The claim is a committed
   * row under a lease, so a crash mid-call leaves a review that can be claimed again later, and running
   * this concurrently cannot call the LLM twice for one claim.
   */
  processAiQueue(): Promise<void> {
    this.queueRun ??= this.drainAiQueue().finally(() => {
      this.queueRun = undefined;
    });
    return this.queueRun;
  }

  private async drainAiQueue(): Promise<void> {
    for (;;) {
      const token = randomUUID();
      const claimed = await repo.claimAiWork(this.pool, {
        token,
        leaseSeconds: this.config.llm.claimLeaseSeconds,
        limit: AI_BATCH,
      });
      if (claimed.length === 0) return;
      await Promise.all(claimed.map((review) => this.suggest(review, token)));
    }
  }

  private async suggest(review: repo.ReviewRow, token: string): Promise<void> {
    if (review.ai_attempts > this.config.llm.maxAttempts) {
      await this.finishManual(review, token);
      return;
    }
    const allowed = allowedValues(review.field);
    await bumpCounter(this.pool, COUNTERS.aiCalls);
    const result = await callLlm(
      this.llm,
      { field: review.field, rawValue: review.raw_value, description: review.source_description, allowedValues: allowed },
      this.config.llm.timeoutMs,
      (failure) => this.log.warn({ ...failure, review_id: review.review_id, model: this.llm.modelVersion }, 'LLM call failed'),
    );
    if (result.kind === 'ok') {
      await repo.completeAiWork(this.pool, review.review_id, token, {
        aiStatus: 'COMPLETED',
        suggestion: result.suggestion,
        confidence: result.confidence,
        reason: result.reason,
        evidence: result.evidence,
        modelVersion: this.llm.modelVersion,
      });
      this.announce(review);
      return;
    }
    await bumpCounter(this.pool, result.kind === 'invalid' ? COUNTERS.invalidOutput : COUNTERS.aiUnavailable);
    await this.finishManual(review, token);
  }

  private async finishManual(review: repo.ReviewRow, token: string): Promise<void> {
    await repo.completeAiWork(this.pool, review.review_id, token, {
      aiStatus: 'FAILED',
      suggestion: null,
      confidence: null,
      reason: AI_UNAVAILABLE_REASON,
      evidence: null,
      modelVersion: this.llm.modelVersion,
    });
    this.announce(review);
  }

  private announce(review: repo.ReviewRow): void {
    this.hub.publish({
      type: 'review.created',
      scope: { allStaff: true },
      data: { review_id: review.review_id, field: review.field },
    });
  }

  /** What staff need in order to see which provider made a suggestion, and what reuse has saved. */
  async stats() {
    const counters = await readCounters(this.pool);
    const value = (name: string) => counters[name] ?? 0;
    const records = value(COUNTERS.records);
    return {
      provider: this.config.llm.provider,
      model_version: this.llm.modelVersion,
      is_live_provider: this.config.llm.provider !== 'mock',
      auto_approval: false as const,
      ai_calls_total: value(COUNTERS.aiCalls),
      normalization_cache_hits_total: value(COUNTERS.cacheHits),
      normalization_records_total: records,
      normalization_cache_hit_rate: records === 0 ? null : value(COUNTERS.cacheHits) / records,
      outcomes: {
        accepted_as_is: value(COUNTERS.acceptedAsIs),
        edited: value(COUNTERS.edited),
        rejected: value(COUNTERS.rejected),
        invalid_output: value(COUNTERS.invalidOutput),
        unavailable: value(COUNTERS.aiUnavailable),
      },
    };
  }

  listReviews(status?: string) {
    return repo.listReviews(this.pool, status);
  }

  /** Records the human decision, stores the mapping and replays waiting records, all in one transaction. */
  async approve(reviewId: string, editedValue: string | undefined, actor: string): Promise<repo.ReviewRow> {
    return inTx(this.pool, this.hub, async ({ client }) => {
      const review = await this.lockPending(client, reviewId);
      const value = editedValue?.trim() || review.ai_suggestion;
      if (!value) {
        throw new AppError(422, 'VALUE_REQUIRED', 'This review has no AI suggestion, so a value is required');
      }
      if (!isValidNormalizedValue(review.field, value)) {
        throw new AppError(422, 'INVALID_VALUE', `"${value}" is not a valid value for ${review.field}`);
      }
      const outcome = review.ai_suggestion && value === review.ai_suggestion ? 'accepted_as_is' : 'edited';
      await repo.saveMapping(client, review, value, actor);
      const closed = await repo.closeReview(client, reviewId, {
        status: 'APPROVED',
        outcome,
        finalValue: value,
        reviewer: actor,
        rejectReason: null,
      });
      await this.replay(client, reviewId);
      await bumpCounter(client, outcome === 'edited' ? COUNTERS.edited : COUNTERS.acceptedAsIs);
      return closed;
    });
  }

  /** Waiting records stay out of the catalog and usable stock, for manual handling. */
  async reject(reviewId: string, reason: string | undefined, actor: string): Promise<repo.ReviewRow> {
    return inTx(this.pool, this.hub, async ({ client }) => {
      await this.lockPending(client, reviewId);
      const closed = await repo.closeReview(client, reviewId, {
        status: 'REJECTED',
        outcome: 'rejected',
        finalValue: null,
        reviewer: actor,
        rejectReason: reason ?? null,
      });
      await repo.markRecords(client, reviewId, 'MANUAL');
      await bumpCounter(client, COUNTERS.rejected);
      return closed;
    });
  }

  private async lockPending(client: pg.PoolClient, reviewId: string): Promise<repo.ReviewRow> {
    const review = await repo.lockReview(client, reviewId);
    if (!review) throw new AppError(404, 'REVIEW_NOT_FOUND', 'Review not found');
    if (review.status !== 'PENDING') {
      throw new AppError(409, 'REVIEW_NOT_PENDING', `Review is already ${review.status}`);
    }
    return review;
  }

  /** In received order. The version guard skips a payload older than what is already stored. */
  private async replay(client: pg.PoolClient, reviewId: string): Promise<void> {
    const records = await repo.waitingRecords(client, reviewId);
    const session = this.newSession(false);
    for (const record of records) {
      if (record.entity_type === 'product') {
        await this.ingestProduct(client, session, record.raw_payload as SourceProduct, false);
      } else {
        await this.ingestInventory(client, session, record.raw_payload as SourceInventory, false);
      }
    }
    await repo.markRecords(client, reviewId, 'APPLIED');
    this.log.info({ review_id: reviewId, records: records.length }, 'normalization records replayed');
  }
}
