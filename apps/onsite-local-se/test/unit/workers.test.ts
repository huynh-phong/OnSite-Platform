import { describe, expect, it } from 'vitest';
import { runWorkers } from '../../src/workers.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = { error: () => undefined };

describe('background worker loops', () => {
  it('pause waits for the running tick, and starts no more until resumed', async () => {
    let started = 0;
    let finished = 0;
    const loops = runWorkers(
      [
        {
          name: 'w',
          seconds: 0.01,
          run: async () => {
            started += 1;
            await sleep(40);
            finished += 1;
          },
        },
      ],
      log,
    );
    await sleep(10);
    await loops.pause();
    // Nothing is mid-flight once pause resolves.
    expect(finished).toBe(started);
    const atPause = started;
    await sleep(60);
    expect(started).toBe(atPause);
    loops.resume();
    await sleep(60);
    expect(started).toBeGreaterThan(atPause);
    await loops.stop();
  });

  it('never overlaps a tick with itself', async () => {
    let active = 0;
    let peak = 0;
    const loops = runWorkers(
      [
        {
          name: 'w',
          seconds: 0.001,
          run: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await sleep(10);
            active -= 1;
          },
        },
      ],
      log,
    );
    await sleep(60);
    await loops.stop();
    expect(peak).toBe(1);
  });

  it('keeps going after a failed tick, and logs it', async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const loops = runWorkers(
      [
        {
          name: 'w',
          seconds: 0.001,
          run: async () => {
            calls += 1;
            throw new Error('boom');
          },
        },
      ],
      { error: (entry: unknown) => errors.push(entry) },
    );
    await sleep(30);
    await loops.stop();
    expect(calls).toBeGreaterThan(1);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('stop lets the running tick finish and starts nothing more', async () => {
    let finished = 0;
    let started = 0;
    const loops = runWorkers(
      [
        {
          name: 'w',
          seconds: 0.001,
          run: async () => {
            started += 1;
            await sleep(20);
            finished += 1;
          },
        },
      ],
      log,
    );
    await sleep(5);
    await loops.stop();
    expect(finished).toBe(started);
    const count = started;
    await sleep(30);
    expect(started).toBe(count);
  });
});
