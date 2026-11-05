import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CEMENT, startHarness, type Harness } from './harness.js';

describe('Checkpoint 5: AI normalization (Issue 3)', () => {
  let h: Harness;
  let sequence = 0;

  const newProduct = (overrides: Record<string, unknown> = {}) => {
    sequence += 1;
    return h.simApi('POST', '/legacy/products', {
      sku_id: `SE-NEW-${sequence}`,
      name: `Ny produkt ${sequence}`,
      source_unit: 'bag',
      source_category: 'cement',
      source_description: `Produkt nummer ${sequence}`,
      unit_price_sek: 100,
      ...overrides,
    });
  };
  const reviews = async (status?: string) =>
    (
      await h.api('GET', `/api/v1/staff/normalization-reviews${status ? `?status=${status}` : ''}`, {
        token: await h.token('staff.store-b'),
      })
    ).body as { review_id: string; raw_value: string; field: string; pending_record_count: number; ai_suggestion: string | null; ai_status: string; ai_reason: string | null; confidence: number | null; model_version: string | null; status: string; outcome: string | null }[];
  const reviewFor = async (raw: string) => (await reviews()).find((review) => review.raw_value === raw);
  const approve = async (reviewId: string, value?: string) =>
    h.api('POST', `/api/v1/staff/normalization-reviews/${reviewId}/approve`, {
      token: await h.token('staff.store-b'),
      ...(value === undefined ? {} : { body: { value } }),
    });
  const reject = async (reviewId: string, reason?: string) =>
    h.api('POST', `/api/v1/staff/normalization-reviews/${reviewId}/reject`, {
      token: await h.token('staff.store-b'),
      ...(reason === undefined ? {} : { body: { reason } }),
    });
  const metric = async (name: string) =>
    Number((await h.pool.query('SELECT value FROM metric_counters WHERE name = $1', [name])).rows[0]?.value ?? 0);
  const customerSkus = async () =>
    ((await h.api('GET', '/api/v1/products', { token: await h.token('buyer.nordbygg') })).body as { sku_id: string }[]).map(
      (product) => product.sku_id,
    );
  const productStatus = async (sku: string) =>
    (await h.pool.query('SELECT status FROM products WHERE sku_id = $1', [sku])).rows[0]?.status;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset('S1');
    h.llm.calls = [];
  });

  describe('T11: a new product with free-text values', () => {
    it('one AI call per distinct unknown value, one review each, and the product stays hidden', async () => {
      const before = await metric('ai_calls_total');
      await newProduct({
        sku_id: 'SE-AI-1',
        name: 'Byggcement Extra',
        source_unit: 'sack-xl',
        source_description: 'Byggcement Extra 40kg sack-xl',
      });
      await h.sync();

      // Two unknown values: the unit and the pack-size description. The category "cement" is already approved.
      expect(h.llm.calls.map((call) => [call.field, call.rawValue]).sort()).toEqual([
        ['pack_size_kg', 'byggcement extra 40kg sack-xl'],
        ['unit', 'sack-xl'],
      ]);
      expect((await metric('ai_calls_total')) - before).toBe(2);

      const unit = await reviewFor('sack-xl');
      const pack = await reviewFor('byggcement extra 40kg sack-xl');
      expect(unit).toMatchObject({ status: 'PENDING', field: 'unit', pending_record_count: 1, ai_status: 'COMPLETED', ai_suggestion: 'bag' });
      expect(pack).toMatchObject({ status: 'PENDING', field: 'pack_size_kg', pending_record_count: 1, ai_status: 'COMPLETED', ai_suggestion: '40' });
      expect(await productStatus('SE-AI-1')).toBe('PENDING_REVIEW');
      expect(await customerSkus()).not.toContain('SE-AI-1');
    });

    it('the seeded AI demo product works the same way: säck plus its description', async () => {
      const unit = await reviewFor('säck');
      const pack = await reviewFor('byggcement std 25kg säck');
      expect(unit).toMatchObject({ field: 'unit', ai_suggestion: 'bag', status: 'PENDING', model_version: 'test-llm' });
      expect(unit!.ai_reason).toBeTruthy();
      expect(unit!.confidence).toBeGreaterThan(0);
      expect(pack).toMatchObject({ field: 'pack_size_kg', ai_suggestion: '25', status: 'PENDING' });
      expect(await productStatus('SE-CEM-STD-025')).toBe('PENDING_REVIEW');
    });

    it('the product becomes ACTIVE only after every mandatory value is approved', async () => {
      const unit = await reviewFor('säck');
      const pack = await reviewFor('byggcement std 25kg säck');
      expect((await approve(unit!.review_id)).status).toBe(200);
      expect(await productStatus('SE-CEM-STD-025')).toBe('PENDING_REVIEW');
      expect(await customerSkus()).not.toContain('SE-CEM-STD-025');

      expect((await approve(pack!.review_id)).status).toBe(200);
      expect(await productStatus('SE-CEM-STD-025')).toBe('ACTIVE');
      expect(await customerSkus()).toContain('SE-CEM-STD-025');
      const { rows } = await h.pool.query(`SELECT category, base_unit, pack_size_verified FROM products WHERE sku_id = 'SE-CEM-STD-025'`);
      expect(rows[0]).toMatchObject({ category: 'cement', base_unit: 'bag' });
      expect(Number(rows[0].pack_size_verified)).toBe(25);
    });

    it('its stock joins usable stock only after approval', async () => {
      const usable = async () =>
        (await h.app.container.inventory.usableStock(['SE-CEM-STD-025'])).reduce((sum, row) => sum + row.usable, 0);
      expect(await usable()).toBe(0);
      await approve((await reviewFor('säck'))!.review_id);
      await approve((await reviewFor('byggcement std 25kg säck'))!.review_id);
      // Nine stores at 72, the hub at 270. Store C reports in "st", which is still unapproved.
      expect(await usable()).toBe(9 * 72 + 270);
    });

    it('never sends prices, stock or customer data to the provider', async () => {
      await newProduct({ source_unit: 'sack-zz', unit_price_sek: 123456 });
      await h.simApi('POST', '/legacy/receipts', { node_id: 'SE-STORE-A', sku_id: CEMENT, qty: 1, source_unit: 'sack-yy' });
      await h.sync();
      expect(h.llm.calls.length).toBeGreaterThan(0);
      for (const call of h.llm.calls) {
        expect(Object.keys(call).sort()).toEqual(['allowedValues', 'description', 'field', 'rawValue']);
        expect(JSON.stringify(call)).not.toMatch(/123456|Nordbygg|Askim|on_hand|reserved/);
      }
    });
  });

  describe('T12: the same unknown value before review', () => {
    it('five records: one AI call, one review, pending_record_count = 5', async () => {
      for (let i = 0; i < 5; i += 1) await newProduct({ source_unit: 'knippe' });
      await h.sync();
      expect(h.llm.calls.filter((call) => call.rawValue === 'knippe')).toHaveLength(1);
      const matching = (await reviews()).filter((review) => review.raw_value === 'knippe');
      expect(matching).toHaveLength(1);
      expect(matching[0]!.pending_record_count).toBe(5);
    });

    it('arriving one sync at a time gives the same result, and spacing or case do not make it a new value', async () => {
      for (const unit of ['Knippe', '  knippe ', 'KNIPPE', 'knippe', 'knippe']) {
        await newProduct({ source_unit: unit });
        await h.sync();
      }
      expect(h.llm.calls.filter((call) => call.rawValue === 'knippe')).toHaveLength(1);
      expect((await reviewFor('knippe'))!.pending_record_count).toBe(5);
    });

    it('a record re-sent while waiting is not counted twice', async () => {
      await newProduct({ sku_id: 'SE-SAME', source_unit: 'knippe' });
      await h.sync();
      await h.simPool.query(`UPDATE products SET version = version + 1, name = 'Renamed' WHERE sku_id = 'SE-SAME'`);
      await h.simPool.query(`INSERT INTO change_feed (entity, entity_id) VALUES ('product', 'SE-SAME')`);
      await h.sync();
      expect((await reviewFor('knippe'))!.pending_record_count).toBe(1);
    });

    it('the same text in a different field is a different value', async () => {
      await newProduct({ source_unit: 'sten', source_category: 'sten' });
      await h.sync();
      const matching = (await reviews()).filter((review) => review.raw_value === 'sten');
      expect(matching.map((review) => review.field).sort()).toEqual(['category', 'unit']);
      expect(h.llm.calls.filter((call) => call.rawValue === 'sten')).toHaveLength(2);
    });
  });

  describe('T13: reuse after approval', () => {
    it('applies an approved value instantly: no AI call, cache hit +1', async () => {
      await newProduct({ sku_id: 'SE-R1', source_unit: 'knippe' });
      await h.sync();
      const review = await reviewFor('knippe');
      await approve(review!.review_id, 'piece');
      expect(await productStatus('SE-R1')).toBe('ACTIVE');

      const callsBefore = await metric('ai_calls_total');
      const hitCount = async () =>
        Number(
          (await h.pool.query(`SELECT hit_count FROM normalization_mappings WHERE raw_value = 'knippe' AND field = 'unit'`)).rows[0].hit_count,
        );
      const hitsBefore = await hitCount();
      h.llm.calls = [];

      await newProduct({ sku_id: 'SE-R2', source_unit: 'knippe' });
      await h.sync();

      expect(h.llm.calls).toEqual([]);
      expect(await metric('ai_calls_total')).toBe(callsBefore);
      expect((await hitCount()) - hitsBefore).toBe(1);
      expect(await productStatus('SE-R2')).toBe('ACTIVE');
      const { rows } = await h.pool.query(`SELECT base_unit FROM products WHERE sku_id = 'SE-R2'`);
      expect(rows[0].base_unit).toBe('piece');
    });

    it('the metric counts cache hits across values, and the rate is reported', async () => {
      const before = await metric('normalization_cache_hits_total');
      await newProduct({});
      await h.sync();
      // Its unit and category are both already approved.
      expect((await metric('normalization_cache_hits_total')) - before).toBe(2);
      const metrics = await h.api('GET', '/api/v1/metrics', { token: await h.token('admin.se') });
      expect(metrics.body.ai.normalization_cache_hit_rate).toBeGreaterThan(0);
      expect(metrics.body.ai.ai_calls_total).toBeGreaterThan(0);
    });

    it('replays waiting records of every kind, in order, when approved', async () => {
      for (let i = 0; i < 3; i += 1) await newProduct({ source_unit: 'knippe', sku_id: `SE-W${i}` });
      await h.sync();
      await approve((await reviewFor('knippe'))!.review_id, 'piece');
      for (let i = 0; i < 3; i += 1) expect(await productStatus(`SE-W${i}`)).toBe('ACTIVE');
      const { rows } = await h.pool.query(
        `SELECT r.status, count(*)::int AS n FROM pending_normalized_records r
           JOIN normalization_review_queue q USING (review_id)
          WHERE q.raw_value = 'knippe' GROUP BY r.status`,
      );
      expect(rows).toEqual([{ status: 'APPLIED', n: 3 }]);
    });

    it('a replayed old record does not overwrite a newer version', async () => {
      await newProduct({ sku_id: 'SE-OLD', source_unit: 'knippe', name: 'Old name' });
      await h.sync();
      await h.pool.query(`UPDATE products SET source_version = 99, name = 'Newer name' WHERE sku_id = 'SE-OLD'`);
      await approve((await reviewFor('knippe'))!.review_id, 'piece');
      const { rows } = await h.pool.query(`SELECT name FROM products WHERE sku_id = 'SE-OLD'`);
      expect(rows[0].name).toBe('Newer name');
    });
  });

  describe('T14: when the AI fails', () => {
    it.each([
      ['invalid-json', 'ai_outcome_invalid_output'],
      ['bad-schema', 'ai_outcome_invalid_output'],
      ['timeout', 'ai_outcome_unavailable'],
      ['error', 'ai_outcome_unavailable'],
    ] as const)('%s: a manual review with no suggestion, and ordering still works', async (mode, counter) => {
      h.llm.mode = mode;
      const before = await metric(counter);
      await newProduct({ source_unit: 'knippe' });
      await h.sync();
      expect(await reviewFor('knippe')).toMatchObject({
        status: 'PENDING',
        ai_suggestion: null,
        confidence: null,
        ai_status: 'FAILED',
        ai_reason: 'AI unavailable – manual review',
      });
      expect((await metric(counter)) - before).toBe(1);
      const order = await h.placeOrder(5);
      expect(order.body.status).toBe('AWAITING_APPROVAL');
    });

    it('a manual review needs a value from the reviewer, and stays out of the catalog until then', async () => {
      h.llm.mode = 'error';
      await newProduct({ sku_id: 'SE-M1', source_unit: 'knippe' });
      await h.sync();
      const review = await reviewFor('knippe');
      const noValue = await approve(review!.review_id);
      expect(noValue.status).toBe(422);
      expect(noValue.body.error.code).toBe('VALUE_REQUIRED');
      expect(await productStatus('SE-M1')).toBe('PENDING_REVIEW');
      expect((await approve(review!.review_id, 'piece')).body.outcome).toBe('edited');
      expect(await productStatus('SE-M1')).toBe('ACTIVE');
    });
  });

  describe('concurrency: atomic claim', () => {
    it('concurrent records of one value still cause one AI call', async () => {
      const service = h.app.container.normalization;
      const { withTransaction } = await import('../../src/db.js');
      const product = (sku: string) => ({
        sku_id: sku,
        name: sku,
        source_unit: 'rödkrita',
        source_category: 'cement',
        source_description: 'Ingen vikt',
        unit_price_sek: 1,
        version: 1,
        updated_at: new Date().toISOString(),
      });
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          withTransaction(h.pool, async (client) => {
            const session = service.newSession();
            await service.ingestProduct(client, session, product(`SE-C${i}`), false);
            await service.flush(client, session);
          }),
        ),
      );
      await Promise.all([service.processAiQueue(), service.processAiQueue(), service.processAiQueue()]);
      expect(h.llm.calls.filter((call) => call.rawValue === 'rödkrita')).toHaveLength(1);
      expect((await reviews()).filter((review) => review.raw_value === 'rödkrita')).toHaveLength(1);
      expect((await reviewFor('rödkrita'))!.pending_record_count).toBe(10);
    });

    it('two workers cannot claim the same review, even from separate instances', async () => {
      await newProduct({ source_unit: 'tvillingvärde' });
      const { buildContainer } = await import('../../src/container.js');
      const second = buildContainer(h.config, h.pool, h.app.log, { llm: h.llm });
      h.llm.calls = [];
      await h.app.container.inventory.sync();
      await Promise.all([h.app.container.normalization.processAiQueue(), second.normalization.processAiQueue()]);
      expect(h.llm.calls.filter((call) => call.rawValue === 'tvillingvärde')).toHaveLength(1);
    });

    it('holds no database transaction open during the LLM call', async () => {
      await newProduct({ source_unit: 'hållvärde' });
      await h.app.container.inventory.sync();
      let release: () => void = () => undefined;
      h.llm.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = h.app.container.normalization.processAiQueue();
      for (let i = 0; i < 100 && !h.llm.calls.some((call) => call.rawValue === 'hållvärde'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const { rows } = await h.pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND state LIKE 'idle in transaction%'`,
      );
      expect(rows[0].n).toBe(0);
      expect((await reviewFor('hållvärde'))!.ai_status).toBe('IN_PROGRESS');
      release();
      await run;
      h.llm.gate = undefined;
      expect((await reviewFor('hållvärde'))!.ai_status).not.toBe('IN_PROGRESS');
    });

    it('a value being processed does not start a second call when more records arrive', async () => {
      await newProduct({ source_unit: 'mittemellan' });
      await h.app.container.inventory.sync();
      let release: () => void = () => undefined;
      h.llm.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = h.app.container.normalization.processAiQueue();
      await newProduct({ source_unit: 'mittemellan' });
      await h.app.container.inventory.sync();
      release();
      await run;
      h.llm.gate = undefined;
      await h.app.container.normalization.processAiQueue();
      expect(h.llm.calls.filter((call) => call.rawValue === 'mittemellan')).toHaveLength(1);
      expect((await reviewFor('mittemellan'))!.pending_record_count).toBe(2);
    });
  });

  describe('retry and recovery after an interruption', () => {
    const interrupt = async (raw: string, claimedSecondsAgo: number, attempts = 1) => {
      // What a crash mid-call leaves behind: a claim with no result.
      await h.pool.query(
        `UPDATE normalization_review_queue
            SET ai_status = 'IN_PROGRESS', ai_claim_token = gen_random_uuid(), ai_attempts = $3,
                ai_claimed_at = now() - make_interval(secs => $2), ai_suggestion = NULL
          WHERE raw_value = $1`,
        [raw, claimedSecondsAgo, attempts],
      );
    };

    it('reclaims a call whose lease ran out, and completes it', async () => {
      await newProduct({ source_unit: 'avbruten' });
      await h.sync();
      await interrupt('avbruten', 3600);
      h.llm.calls = [];
      await h.app.container.normalization.processAiQueue();
      expect(h.llm.calls.map((call) => call.rawValue)).toEqual(['avbruten']);
      expect((await reviewFor('avbruten'))!.ai_status).not.toBe('IN_PROGRESS');
    });

    it('leaves a call alone while its lease is running', async () => {
      await newProduct({ source_unit: 'pågående' });
      await h.sync();
      await interrupt('pågående', 1);
      h.llm.calls = [];
      await h.app.container.normalization.processAiQueue();
      expect(h.llm.calls).toEqual([]);
      expect((await reviewFor('pågående'))!.ai_status).toBe('IN_PROGRESS');
    });

    it('gives up after the attempt limit and hands the review to a human', async () => {
      await newProduct({ source_unit: 'envis' });
      await h.sync();
      await interrupt('envis', 3600, h.config.llm.maxAttempts);
      h.llm.calls = [];
      await h.app.container.normalization.processAiQueue();
      expect(h.llm.calls).toEqual([]);
      expect(await reviewFor('envis')).toMatchObject({ ai_status: 'FAILED', ai_reason: 'AI unavailable – manual review' });
    });

    it('a late answer from an interrupted call cannot overwrite the retry', async () => {
      const { completeAiWork } = await import('../../src/modules/normalization/normalization.repository.js');
      await newProduct({ source_unit: 'sent' });
      await h.sync();
      const review = await reviewFor('sent');
      const written = await completeAiWork(h.pool, review!.review_id, '00000000-0000-4000-8000-000000000000', {
        aiStatus: 'COMPLETED',
        suggestion: 'kg',
        confidence: 1,
        reason: 'late',
        evidence: null,
        modelVersion: 'old',
      });
      expect(written).toBe(false);
    });

    it('a review can be decided by a human while the AI call is running', async () => {
      await newProduct({ sku_id: 'SE-H1', source_unit: 'snabbhand' });
      await h.app.container.inventory.sync();
      let release: () => void = () => undefined;
      h.llm.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = h.app.container.normalization.processAiQueue();
      const review = await reviewFor('snabbhand');
      expect((await approve(review!.review_id, 'piece')).status).toBe(200);
      release();
      await run;
      h.llm.gate = undefined;
      expect(await reviewFor('snabbhand')).toMatchObject({ status: 'APPROVED', final_value: 'piece' });
    });
  });

  describe('staff review', () => {
    it('approve as is counts as accepted, an edit counts as edited, and both create a versioned mapping', async () => {
      await newProduct({ source_unit: 'påse-a' });
      await newProduct({ source_unit: 'påse-b' });
      await h.sync();
      const accepted = await approve((await reviewFor('påse-a'))!.review_id);
      expect(accepted.body).toMatchObject({ status: 'APPROVED', outcome: 'accepted_as_is', final_value: 'bag', reviewed_by: 'staff.store-b' });
      const edited = await approve((await reviewFor('påse-b'))!.review_id, 'piece');
      expect(edited.body).toMatchObject({ status: 'APPROVED', outcome: 'edited', final_value: 'piece' });
      expect(await metric('ai_outcome_accepted_as_is')).toBe(1);
      expect(await metric('ai_outcome_edited')).toBe(1);
      const { rows } = await h.pool.query(`SELECT approved_by, version, status FROM normalization_mappings WHERE raw_value = 'påse-a'`);
      expect(rows[0]).toEqual({ approved_by: 'staff.store-b', version: 1, status: 'APPROVED' });
    });

    it('only allows a valid value for the field', async () => {
      await newProduct({ source_unit: 'knippe' });
      await h.sync();
      const bad = await approve((await reviewFor('knippe'))!.review_id, 'bucket');
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('INVALID_VALUE');
    });

    it('a rejected value keeps its records for manual handling, and never calls the AI again', async () => {
      await newProduct({ sku_id: 'SE-RJ1', source_unit: 'skräp' });
      await h.sync();
      const review = await reviewFor('skräp');
      const response = await reject(review!.review_id, 'Not a unit');
      expect(response.body).toMatchObject({ status: 'REJECTED', outcome: 'rejected', reject_reason: 'Not a unit' });
      expect(await metric('ai_outcome_rejected')).toBe(1);
      expect(await productStatus('SE-RJ1')).toBe('PENDING_REVIEW');
      expect(await customerSkus()).not.toContain('SE-RJ1');

      h.llm.calls = [];
      await newProduct({ sku_id: 'SE-RJ2', source_unit: 'skräp' });
      await h.sync();
      expect(h.llm.calls).toEqual([]);
      expect(await productStatus('SE-RJ2')).toBe('PENDING_REVIEW');
      const { rows } = await h.pool.query(`SELECT status, count(*)::int AS n FROM pending_normalized_records WHERE review_id = $1 GROUP BY status`, [
        review!.review_id,
      ]);
      expect(rows).toEqual([{ status: 'MANUAL', n: 2 }]);
    });

    it('a decided review cannot be decided again, and an unknown one is a 404', async () => {
      await newProduct({ source_unit: 'knippe' });
      await h.sync();
      const review = await reviewFor('knippe');
      await approve(review!.review_id, 'piece');
      const again = await approve(review!.review_id, 'bag');
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('REVIEW_NOT_PENDING');
      expect((await reject(review!.review_id)).status).toBe(409);
      expect((await approve('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    });

    it('two reviewers at once produce one decision', async () => {
      await newProduct({ source_unit: 'knippe' });
      await h.sync();
      const review = await reviewFor('knippe');
      const results = await Promise.all([approve(review!.review_id, 'piece'), approve(review!.review_id, 'bag')]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    });

    it('filters by status, and AI suggestions apply nothing by themselves', async () => {
      await newProduct({ sku_id: 'SE-F1', source_unit: 'säck-ny' });
      await h.sync();
      const review = await reviewFor('säck-ny');
      expect(review!.ai_suggestion).toBe('bag');
      const mapped = await h.pool.query(`SELECT 1 FROM normalization_mappings WHERE raw_value = 'säck-ny'`);
      expect(mapped.rowCount).toBe(0);
      expect(await productStatus('SE-F1')).toBe('PENDING_REVIEW');
      expect((await reviews('APPROVED')).length).toBe(0);
      expect((await reviews('PENDING')).length).toBeGreaterThan(0);
    });
  });

  it('never uses AI on the order path', async () => {
    h.llm.calls = [];
    await h.placeOrder(100);
    expect(h.llm.calls).toEqual([]);
  });
});
