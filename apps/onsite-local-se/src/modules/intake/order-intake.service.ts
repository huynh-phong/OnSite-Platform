import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import type { LlmProvider } from '../../connectors/llm.js';
import type { Db } from '../../db.js';
import { AppError } from '../../errors.js';
import * as catalog from '../catalog/catalog.repository.js';
import { bumpCounter, COUNTERS } from '../metrics/counters.js';
import { redactContactDetails, validateOrderDraft, type DraftCatalogEntry } from './order-draft.js';

/**
 * Reads a contractor's free-text order (an email, a text message) into draft lines with the AI provider.
 * Nothing is stored and nothing is ordered: the draft goes back to the customer, who checks each line and
 * places the order the normal way. Quantities, stock, routing and prices never come from the AI.
 */
export class OrderIntakeService {
  constructor(
    private readonly pool: Db,
    private readonly config: Config,
    private readonly llm: LlmProvider,
    private readonly log: FastifyBaseLogger,
  ) {}

  async parse(text: string) {
    if (!this.llm.parseOrder) throw unavailable();
    const products = await catalog.listProducts(this.pool, false);
    const entries: DraftCatalogEntry[] = products
      .filter((product) => product.base_unit)
      .map((product) => ({ sku_id: product.sku_id, name: product.name, unit: product.base_unit! }));
    const redacted = redactContactDetails(text);

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let output: unknown;
    try {
      await bumpCounter(this.pool, COUNTERS.aiCalls);
      await bumpCounter(this.pool, COUNTERS.orderReads);
      output = await Promise.race([
        this.llm.parseOrder({ text: redacted.text, catalog: entries }, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('LLM timeout'));
          }, this.config.llm.timeoutMs);
        }),
      ]);
    } catch (error) {
      // Only the type and status: provider messages can echo the request.
      const { status, name } = error as { status?: number; name: string };
      this.log.warn({ status, name }, 'order reader unavailable');
      await bumpCounter(this.pool, COUNTERS.orderReadFailures);
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }

    const draft = validateOrderDraft(redacted.text, entries, output);
    if (!draft) {
      await bumpCounter(this.pool, COUNTERS.orderReadFailures);
      throw new AppError(422, 'AI_OUTPUT_INVALID', 'The message could not be read reliably. Add the products from the catalog instead.');
    }
    return {
      lines: draft.lines,
      dropped_lines: draft.dropped,
      contact_details_removed: redacted.removed,
      model: this.llm.modelVersion,
      draft_only: true as const,
    };
  }
}

function unavailable() {
  return new AppError(503, 'AI_UNAVAILABLE', 'The order reader is not available right now. Add the products from the catalog instead.');
}
