import type { FastifyBaseLogger } from 'fastify';
import type { Container } from './container.js';

export interface Worker {
  name: string;
  seconds: number;
  run: () => Promise<unknown>;
}

export interface WorkerLoops {
  pause: () => Promise<void>;
  resume: () => void;
  stop: () => Promise<void>;
}

/**
 * A loop never overlaps itself, and a failed tick is logged and does not stop it, so a source or database that
 * comes back is picked up without a restart. Pausing lets running ticks finish and starts no new ones.
 */
export function runWorkers(workers: Worker[], log: Pick<FastifyBaseLogger, 'error'>): WorkerLoops {
  let stopped = false;
  let paused = false;
  const timers = new Set<NodeJS.Timeout>();
  const running = new Set<Promise<unknown>>();

  const schedule = (worker: Worker, delayMs: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void loop(worker);
    }, delayMs);
    timers.add(timer);
  };
  const loop = async (worker: Worker) => {
    if (stopped) return;
    if (!paused) {
      const work = worker.run().catch((error: unknown) => log.error({ err: error, worker: worker.name }, 'worker tick failed'));
      running.add(work);
      await work;
      running.delete(work);
    }
    if (!stopped) schedule(worker, worker.seconds * 1000);
  };
  for (const worker of workers) void loop(worker);

  return {
    pause: async () => {
      paused = true;
      await Promise.all(running);
    },
    resume: () => {
      paused = false;
    },
    stop: async () => {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      await Promise.all(running);
    },
  };
}

/** Starts the background loops of Local SE. */
export function startWorkers(container: Container, log: FastifyBaseLogger): () => Promise<void> {
  const { config } = container;
  const loops = runWorkers(
    [
      // Separate loops: a slow AI provider must never delay the sync and make stock look stale.
      { name: 'inventory-sync', seconds: config.inventory.syncSeconds, run: () => container.inventory.sync() },
      { name: 'normalization-ai', seconds: 2, run: () => container.normalization.processAiQueue() },
      { name: 'reservation-expiry', seconds: config.reservation.expirySeconds, run: () => container.reservations.tick() },
      { name: 'reservation-renewal', seconds: config.reservation.renewalSeconds, run: () => container.reservations.renewDue() },
      { name: 'allocation-recovery', seconds: 60, run: () => container.allocation.recoverInterrupted() },
      { name: 'eta-watcher', seconds: config.eta.watchSeconds, run: () => container.eta.tick() },
      { name: 'outbox-sender', seconds: config.outbox.sendSeconds, run: () => container.outbox.tick() },
    ],
    log,
  );
  container.demo.attachWorkers(loops);
  return loops.stop;
}
