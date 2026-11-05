import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.js';

describe('Checkpoint 1 skeleton', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    await h.reset('S1', { sync: false });
  });
  afterAll(async () => {
    await h.close();
  });

  it('reports Local SE health with its dependencies', async () => {
    const response = await h.api('GET', '/api/v1/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', db: 'ok', simulator: 'ok', central: 'not_configured' });
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('reports simulator health', async () => {
    const response = await h.sim.inject({ url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('serves Swagger UI and the OpenAPI document', async () => {
    expect((await h.app.inject({ url: '/docs/' })).statusCode).toBe(200);
    const document = (await h.app.inject({ url: '/docs/json' })).json() as { paths: Record<string, unknown> };
    expect(document.paths).toHaveProperty('/api/v1/health');
  });

  it('returns the uniform error body with a request id', async () => {
    const response = await h.api('GET', '/api/v1/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.request_id).toBe(response.headers['x-request-id']);
  });

  it('has the seeded reference data', async () => {
    const count = async (table: string) => Number((await h.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
    expect(await count('stores')).toBe(11);
    expect(await count('customers')).toBe(1);
    expect(await count('sites')).toBe(2);
    expect(await count('users')).toBe(5);
    expect(await count('normalization_mappings')).toBe(19);
  });

  it('stores customer contact and site address only as ciphertext', async () => {
    const { rows } = await h.pool.query(`
      SELECT encode(address_enc, 'escape') AS raw, key_id FROM sites
      UNION ALL SELECT encode(contact_enc, 'escape'), key_id FROM customers`);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.raw).not.toMatch(/Askim|Skövde|Demo|nordbygg/i);
      expect(row.key_id).toBe('se-key-v1');
    }
  });

  it('never stores demo passwords in plaintext', async () => {
    const { rows } = await h.pool.query('SELECT password_hash FROM users');
    for (const row of rows) {
      expect(row.password_hash).toMatch(/^scrypt\$/);
      expect(row.password_hash).not.toContain(h.config.demoPassword);
    }
  });

  it('enforces the required constraints and indexes', async () => {
    const { rows } = await h.pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
    const indexes = rows.map((row) => row.indexname);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'fulfilment_tasks_node_status_idx',
        'outbox_events_status_next_attempt_idx',
        'reservations_status_expires_idx',
        'normalization_review_one_pending',
      ]),
    );
    await h.pool.query(`INSERT INTO audit_logs (actor, action, resource, result) VALUES ('test', 'a', 'r', 'ok')`);
    await expect(h.pool.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    await h.pool.query('TRUNCATE audit_logs');
  });
});
