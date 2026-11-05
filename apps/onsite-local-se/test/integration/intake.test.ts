import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

const MESSAGE =
  'Hej! Ring mig på 070-123 45 67 om något saknas. Vi behöver 20 säckar Byggcement 25kg och 2 pall gips 13mm 900x2400. Leverans tis 07:00.';

describe('Reading a free-text order with AI (a draft only)', () => {
  let h: Harness;

  const parse = async (text: string, user = 'buyer.nordbygg') =>
    h.api('POST', '/api/v1/orders/parse', { token: await h.token(user), body: { text } });

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset('S1');
  });

  it('proposes lines from the catalog, flags the unit it will not convert, and orders nothing', async () => {
    const response = await parse(MESSAGE);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ draft_only: true, dropped_lines: 0, contact_details_removed: 1, model: 'test-llm' });
    expect(response.body.lines.map((line: { sku_id: string; quantity: number; checks: string[] }) => [line.sku_id, line.quantity, line.checks])).toEqual([
      ['SE-CEM-025', 20, []],
      ['SE-GYP-13-2400', 2, ['UNIT_MISMATCH']],
    ]);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(0);
    expect((await h.stock('SE-STORE-B')).reserved).toBe(0);
  });

  it('sends the provider no phone number, and only active catalog products', async () => {
    await parse(MESSAGE);
    const [call] = h.llm.orderCalls;
    expect(call!.text).not.toContain('070');
    expect(call!.text).toContain('[removed]');
    expect(call!.catalog.length).toBeGreaterThan(10);
    expect(Object.keys(call!.catalog[0]!).sort()).toEqual(['name', 'sku_id', 'unit']);
  });

  it('drops a confident line that quotes words the customer never wrote', async () => {
    h.llm.mode = 'bad-schema';
    const response = await parse(MESSAGE);
    expect(response.body).toMatchObject({ lines: [], dropped_lines: 1 });
  });

  it('falls back to the catalog when the reader fails, times out or answers nonsense', async () => {
    for (const [mode, status, code] of [
      ['error', 503, 'AI_UNAVAILABLE'],
      ['timeout', 503, 'AI_UNAVAILABLE'],
      ['invalid-json', 422, 'AI_OUTPUT_INVALID'],
    ] as const) {
      h.llm.mode = mode;
      const response = await parse('20 säckar cement');
      expect(response.status, mode).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(response.body.error.message).toContain('catalog');
    }
    const metrics = await h.api('GET', '/api/v1/metrics', { token: await h.token('admin.se') });
    expect(metrics.status).toBe(200);
  });

  it('is for customers only, and refuses an empty or oversized text', async () => {
    expect((await parse(MESSAGE, 'staff.store-b')).status).toBe(403);
    expect((await parse('')).status).toBe(400);
    expect((await parse('x'.repeat(2001))).status).toBe(400);
  });
});
