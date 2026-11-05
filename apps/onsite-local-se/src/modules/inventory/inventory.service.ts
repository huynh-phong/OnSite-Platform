import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import {
  SourceRejectedError,
  SourceUnavailableError,
  type FeedPage,
  type SimulatorClient,
  type SourceInventory,
  type SourceProduct,
} from '../../connectors/simulator.js';
import { withTransaction, type Db } from '../../db.js';
import { bumpCounter, COUNTERS } from '../metrics/counters.js';
import type { NormalizationService } from '../normalization/normalization.service.js';
import { assessFreshness, type Freshness } from './freshness.js';
import * as repo from './inventory.repository.js';
import { isUnitCompatible, usableStock } from './usable.js';

export interface UsableRow extends repo.StockRow {
  usable: number;
}

export interface SyncResult {
  ok: boolean;
  error?: string;
}

const MAX_PAGES = 1000;

export class InventoryService {
  private inFlight: Promise<SyncResult> | undefined;

  constructor(
    private readonly pool: Db,
    private readonly config: Config,
    private readonly simulator: SimulatorClient,
    private readonly normalization: NormalizationService,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Loads the persisted connector switch into the client. */
  async loadConnectorState(): Promise<void> {
    this.simulator.enabled = await repo.getConnectorEnabled(this.pool, this.config.sourceSystem);
  }

  async setConnectorEnabled(enabled: boolean, actor: string): Promise<{ enabled: boolean }> {
    await repo.setConnectorEnabled(this.pool, this.config.sourceSystem, enabled, actor);
    this.simulator.enabled = enabled;
    return { enabled };
  }

  /** Whether stock may be committed right now. See assessFreshness for the rule. */
  async freshness(now = new Date()): Promise<Freshness> {
    const cursor = await repo.getCursor(this.pool, this.config.sourceSystem, 'inventory');
    return assessFreshness({
      now,
      connectorEnabled: this.simulator.enabled,
      cursor,
      staleAfterSeconds: this.config.inventory.staleAfterSeconds,
    });
  }

  /** Current stock with usable applied. Records awaiting normalization or conversion count as zero. */
  async usableStock(skuIds?: string[]): Promise<UsableRow[]> {
    const rows = await repo.listStock(this.pool, skuIds);
    return rows.map((row) => ({
      ...row,
      usable:
        row.product_status === 'ACTIVE' &&
        !row.normalization_pending &&
        isUnitCompatible(row.normalized_unit, row.base_unit)
          ? usableStock(row.on_hand, row.reserved, this.config.inventory.safetyRatio)
          : 0,
    }));
  }

  applySourceStock(row: SourceInventory): Promise<void> {
    return repo.applySourceStock(this.pool, row);
  }

  /** One sync at a time per process. Callers that arrive during a run share its result. */
  sync(): Promise<SyncResult> {
    this.inFlight ??= this.runSync().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async runSync(): Promise<SyncResult> {
    if (!this.simulator.enabled) return { ok: false, error: 'CONNECTOR_DISABLED' };
    // Products first, so stock rows can be checked against an up-to-date catalog.
    const products = await this.runStream<SourceProduct>('products', (since) => this.simulator.productFeed(since));
    const inventory = await this.runStream<SourceInventory>('inventory', (since) => this.simulator.inventoryFeed(since));
    const ok = products.ok && inventory.ok;
    return ok ? { ok } : { ok, error: inventory.error ?? products.error ?? 'UNKNOWN' };
  }

  private async runStream<T extends SourceInventory | SourceProduct>(
    stream: repo.SyncStream,
    fetchPage: (since: number) => Promise<FeedPage<T>>,
  ): Promise<SyncResult> {
    const source = this.config.sourceSystem;
    let cursor = await repo.ensureCursor(this.pool, source, stream);
    let since = cursor.lastSeq;
    let recovered = false;

    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      let page: FeedPage<T>;
      try {
        page = await fetchPage(since);
      } catch (error) {
        const cursorRefused =
          error instanceof SourceRejectedError && (error.code === 'CURSOR_EXPIRED' || error.code === 'CURSOR_AHEAD');
        if (cursorRefused && !recovered) {
          // The feed cannot continue from here. Trust is withdrawn until a full snapshot has been applied.
          this.log.warn({ stream, code: error.code }, 'change feed continuity lost; taking a snapshot');
          await repo.breakContinuity(this.pool, source, stream, error.code);
          await bumpCounter(this.pool, COUNTERS.syncFailures);
          recovered = true;
          since = 0;
          continue;
        }
        const code =
          error instanceof SourceUnavailableError
            ? 'SOURCE_UNAVAILABLE'
            : error instanceof SourceRejectedError
              ? error.code
              : 'SYNC_ERROR';
        if (code === 'SYNC_ERROR') this.log.error({ err: error, stream }, 'inventory sync failed');
        await repo.recordSyncFailure(this.pool, source, stream, code);
        await bumpCounter(this.pool, COUNTERS.syncFailures);
        return { ok: false, error: code };
      }

      // The source was reset: this cursor refers to history that no longer exists.
      if (since > 0 && cursor.feedEpoch && cursor.feedEpoch !== page.feed_epoch && !recovered) {
        this.log.warn({ stream }, 'source feed epoch changed; taking a snapshot');
        await repo.breakContinuity(this.pool, source, stream, 'FEED_EPOCH_CHANGED');
        recovered = true;
        since = 0;
        continue;
      }

      const epochChanged = Boolean(cursor.feedEpoch && cursor.feedEpoch !== page.feed_epoch);
      const applied = await withTransaction(this.pool, async (client) => {
        const locked = await repo.lockCursor(client, source, stream);
        if (locked.lastSeq !== since) return false; // Another instance moved the cursor.
        const session = this.normalization.newSession();
        if (stream === 'inventory' && page.snapshot && epochChanged) await repo.clearInventoryView(client);
        for (const item of page.items) {
          if (stream === 'products') {
            await this.normalization.ingestProduct(client, session, item as SourceProduct, page.snapshot);
          } else {
            await this.normalization.ingestInventory(client, session, item as SourceInventory, page.snapshot);
          }
        }
        await this.normalization.flush(client, session);
        await repo.advanceCursor(client, source, stream, page);
        return true;
      });
      if (!applied) return { ok: true };

      since = page.next_seq;
      cursor = { ...cursor, feedEpoch: page.feed_epoch };
      if (!page.has_more) return { ok: true };
    }
    await repo.recordSyncFailure(this.pool, source, stream, 'FEED_TOO_LONG');
    return { ok: false, error: 'FEED_TOO_LONG' };
  }

  /** Worker entry point: sync, then give the AI queue a chance. Never throws. */
  async tick(): Promise<SyncResult> {
    const result = await this.sync();
    await this.normalization.processAiQueue();
    return result;
  }
}
