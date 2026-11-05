import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import type { SimulatorClient } from '../../connectors/simulator.js';
import type { Db } from '../../db.js';
import { AppError } from '../../errors.js';
import { seedLocal } from '../../seed.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import type { NormalizationService } from '../normalization/normalization.service.js';

export interface WorkerControl {
  /** Resolves once no background tick is running, and none will start until resume. */
  pause: () => Promise<void>;
  resume: () => void;
}

const DEADLOCK = '40P01';
const MAX_SEED_ATTEMPTS = 5;

/** Demo control. Wipes seeded test data in all three systems, so it is off unless explicitly enabled. */
export class DemoService {
  private workers: WorkerControl | undefined;
  private resetting = false;

  constructor(
    private readonly pool: Db,
    private readonly config: Config,
    private readonly simulator: SimulatorClient,
    private readonly inventory: InventoryService,
    private readonly normalization: NormalizationService,
    private readonly log: FastifyBaseLogger,
  ) {}

  attachWorkers(workers: WorkerControl): void {
    this.workers = workers;
  }

  async reset(scenario: 'S1' | 'S2', confirm: string, connector: 'enabled' | 'disabled') {
    if (!this.config.demoResetEnabled) throw new AppError(403, 'DEMO_RESET_DISABLED', 'Demo reset is not enabled here');
    if (confirm !== 'RESET') throw new AppError(400, 'CONFIRMATION_REQUIRED', 'Send confirm="RESET" to wipe the demo data');
    if (this.resetting) throw new AppError(409, 'RESET_IN_PROGRESS', 'A demo reset is already running');

    this.resetting = true;
    // Background work holds locks on the same tables, and could send old events to Central afterwards.
    await this.workers?.pause();
    try {
      try {
        await this.simulator.resetDemo(scenario);
      } catch {
        throw new AppError(503, 'SOURCE_UNAVAILABLE', 'The simulator could not be reset, so nothing was changed');
      }
      await this.seedWithRetry();
      const central = await this.resetCentral();

      const enabled = connector === 'enabled';
      await this.inventory.setConnectorEnabled(enabled, 'demo-reset');
      if (enabled) {
        await this.inventory.sync();
        // Suggestions may take a while with a real provider; the worker carries on with them.
        void this.normalization.processAiQueue().catch((error: unknown) => this.log.error({ err: error }, 'AI queue failed'));
      }
      this.log.warn({ scenario, connector, central }, 'demo data was reset');
      return { scenario, connector_enabled: enabled, central };
    } finally {
      this.workers?.resume();
      this.resetting = false;
    }
  }

  /** A request still in flight can lock tables in another order than TRUNCATE does. That passes on a retry. */
  private async seedWithRetry(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await seedLocal(this.pool, this.config);
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== DEADLOCK || attempt >= MAX_SEED_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      }
    }
  }

  private async resetCentral(): Promise<'reset' | 'not_configured' | 'unreachable'> {
    const ingest = this.config.centralIngestUrl;
    if (!ingest) return 'not_configured';
    try {
      const response = await fetch(new URL('/admin/reset', ingest), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.centralServiceToken ?? ''}` },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok ? 'reset' : 'unreachable';
    } catch {
      return 'unreachable';
    }
  }
}
