import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import { createLlmProvider, type LlmProvider } from './connectors/llm.js';
import { SimulatorClient } from './connectors/simulator.js';
import type { Db } from './db.js';
import { CatalogService } from './modules/catalog/catalog.service.js';
import { DocumentsService } from './modules/documents/documents.service.js';
import { EtaService } from './modules/eta/eta.service.js';
import { InventoryService } from './modules/inventory/inventory.service.js';
import { DemoService } from './modules/metrics/demo.service.js';
import { LatencyTracker, MetricsService } from './modules/metrics/metrics.service.js';
import { NormalizationService } from './modules/normalization/normalization.service.js';
import { NotificationHub } from './modules/notifications/hub.js';
import { OrdersService } from './modules/orders/orders.service.js';
import { OutboxSender } from './modules/outbox/outbox.service.js';
import { AllocationService } from './modules/reservations/allocation.service.js';
import { ReservationsService } from './modules/reservations/reservations.service.js';
import { TasksService } from './modules/tasks/tasks.service.js';

export interface ContainerOptions {
  /** Tests inject a provider here; otherwise LLM_PROVIDER decides. */
  llm?: LlmProvider;
}

export function buildContainer(config: Config, pool: Db, log: FastifyBaseLogger, options: ContainerOptions = {}) {
  const hub = new NotificationHub();
  const simulator = new SimulatorClient(config.simulatorBaseUrl, config.simulatorServiceToken, config.sourceTimeoutMs);
  const llm = options.llm ?? createLlmProvider(config.llm);
  const latency = new LatencyTracker();

  const normalization = new NormalizationService(pool, hub, config, llm, log);
  const inventory = new InventoryService(pool, config, simulator, normalization, log);
  const eta = new EtaService(pool, hub, config);
  const reservations = new ReservationsService(pool, hub, config, simulator, inventory, log);
  const allocation = new AllocationService(pool, hub, config, simulator, inventory, reservations, eta, log);
  const orders = new OrdersService(pool, hub, config, allocation, reservations);
  const tasks = new TasksService(pool, hub, config, simulator, inventory, reservations, allocation, eta, log);
  const documents = new DocumentsService(pool, config, orders);
  const catalog = new CatalogService(pool, config, inventory);
  const metrics = new MetricsService(pool, config, inventory, latency);
  const outbox = new OutboxSender(pool, config, log);
  const demo = new DemoService(pool, config, simulator, inventory, normalization, log);

  return {
    config,
    pool,
    hub,
    simulator,
    latency,
    normalization,
    inventory,
    eta,
    reservations,
    allocation,
    orders,
    tasks,
    documents,
    catalog,
    metrics,
    outbox,
    demo,
  };
}

export type Container = ReturnType<typeof buildContainer>;
