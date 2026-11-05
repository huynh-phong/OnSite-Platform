import type { FastifyBaseLogger } from 'fastify';
import type { Container } from './container.js';

interface Worker {
  name: string;
  seconds: number;
  run: () => Promise<unknown>;
}

/**
 * Starts the background loops. A loop never overlaps itself, and a failed tick is logged and does not
 * stop it, so a source or database that comes back is picked up without a restart.
 */
export function startWorkers(container: Container, log: FastifyBaseLogger): () => Promise<void> {
  const { config } = container;
  const workers: Worker[] = [
    // Separate loops: a slow AI provider must never delay the sync and make stock look stale.
    { name: 'inventory-sync', seconds: config.inventory.syncSeconds, run: () => container.inventory.sync() },
    { name: 'normalization-ai', seconds: 2, run: () => container.normalization.processAiQueue() },
    { name: 'reservation-expiry', seconds: config.reservation.expirySeconds, run: () => container.reservations.tick() },
    { name: 'reservation-renewal', seconds: config.reservation.renewalSeconds, run: () => container.reservations.renewDue() },
    { name: 'allocation-recovery', seconds: 60, run: () => container.allocation.recoverInterrupted() },
    { name: 'eta-watcher', seconds: config.eta.watchSeconds, run: () => container.eta.tick() },
    { name: 'outbox-sender', seconds: config.outbox.sendSeconds, run: () => container.outbox.tick() },
  ];

  let stopped = false;
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<Promise<unknown>>();

  for (const worker of workers) {
    const loop = async () => {
      if (stopped) return;
      const work = worker.run().catch((error: unknown) => log.error({ err: error, worker: worker.name }, 'worker tick failed'));
      running.add(work);
      await work;
      running.delete(work);
      if (!stopped) timers.push(setTimeout(() => void loop(), worker.seconds * 1000));
    };
    void loop();
  }

  return async () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    await Promise.all(running);
  };
}
