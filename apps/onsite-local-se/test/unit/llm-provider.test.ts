import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicLlmProvider, callLlm, createLlmProvider, MockLlmProvider, type SuggestInput } from '../../src/connectors/llm.js';
import { runEvaluation, summarize, type LabelledExample } from '../../src/modules/normalization/eval.js';
import { allowedValues, isValidNormalizedValue } from '../../src/modules/normalization/values.js';

const examples = JSON.parse(readFileSync(new URL('../../seed/normalization-testset.json', import.meta.url), 'utf8')) as LabelledExample[];

describe('the labelled test set', () => {
  it('has 50 examples with valid labels across all three fields', () => {
    expect(examples).toHaveLength(50);
    expect(new Set(examples.map((example) => example.id)).size).toBe(50);
    expect(new Set(examples.map((example) => example.field))).toEqual(new Set(['unit', 'category', 'pack_size_kg']));
    for (const example of examples) {
      expect(isValidNormalizedValue(example.field, example.expected), `#${example.id}`).toBe(true);
    }
  });

  it('runs through production validation and reports every rate', async () => {
    const rows = await runEvaluation(new MockLlmProvider(), examples, 1000);
    const summary = summarize(rows);
    expect(summary.total).toBe(50);
    const sum = summary.accuracy + summary.edit_needed_rate + summary.invalid_output_rate + summary.unavailable_rate;
    expect(sum).toBeCloseTo(1, 5);
    expect(summary.by_field.unit!.total + summary.by_field.category!.total + summary.by_field.pack_size_kg!.total).toBe(50);
  });

  it('counts a provider failure as unavailable, not as wrong', async () => {
    const broken = { modelVersion: 'x', suggest: () => Promise.reject(new Error('down')) };
    const summary = summarize(await runEvaluation(broken, examples.slice(0, 5), 100));
    expect(summary.unavailable_rate).toBe(1);
    expect(summary.accuracy).toBe(0);
  });
});

describe('Anthropic provider (against a local stand-in; the real API is not called here)', () => {
  let server: Server;
  let baseURL: string;
  let lastBody: Record<string, any> = {};
  let lastHeaders: IncomingHttpHeaders = {};
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  const message = (text: string, stop_reason = 'end_turn') => ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const input: SuggestInput = {
    field: 'unit',
    rawValue: 'säck',
    description: 'Byggcement Std 25kg säck',
    allowedValues: allowedValues('unit'),
  };

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        lastBody = JSON.parse(Buffer.concat(chunks).toString());
        lastHeaders = request.headers;
        response.statusCode = reply.status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    reply = { status: 200, body: message(JSON.stringify({ suggested_value: 'bag', confidence: 0.97, reason: 'säck means bag', evidence: null })) };
  });

  it('sends only the value, field, description and allowed values, with structured output', async () => {
    const provider = new AnthropicLlmProvider('test-key', undefined, baseURL);
    const result = await callLlm(provider, input, 5000);
    expect(result).toMatchObject({ kind: 'ok', suggestion: 'bag', confidence: 0.97 });

    expect(lastHeaders.authorization).toBe('Bearer test-key');
    expect(lastHeaders['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(lastBody.model).toBe('claude-opus-5-5');
    expect(lastBody.fallbacks).toBe('default');
    expect(lastBody.output_config.effort).toBe('low');
    expect(lastBody.output_config.format.type).toBe('json_schema');
    expect(lastBody.output_config.format.schema.properties.suggested_value.enum).toContain('bag');
    expect(lastBody.output_config.format.schema.additionalProperties).toBe(false);
    expect(lastBody.thinking).toBeUndefined();

    const sent = JSON.parse(lastBody.messages[0].content);
    expect(Object.keys(sent).sort()).toEqual(['allowed_values', 'field', 'product_description', 'raw_value']);
    expect(sent).toMatchObject({ field: 'unit', raw_value: 'säck' });
  });

  it('uses LLM_MODEL when it is set', async () => {
    const provider = createLlmProvider({ provider: 'anthropic', apiKey: 'k', model: 'claude-haiku-5-5', timeoutMs: 1, claimLeaseSeconds: 1, maxAttempts: 1 });
    expect(provider.modelVersion).toBe('claude-haiku-5-5');
  });

  it('requires an API key', () => {
    expect(() =>
      createLlmProvider({ provider: 'anthropic', apiKey: undefined, model: undefined, timeoutMs: 1, claimLeaseSeconds: 1, maxAttempts: 1 }),
    ).toThrow(/LLM_API_KEY/);
  });

  it('turns a refusal, an API error and invalid output into a manual review', async () => {
    const provider = new AnthropicLlmProvider('k', undefined, baseURL);
    reply = { status: 200, body: message('', 'refusal') };
    expect(await callLlm(provider, input, 5000)).toEqual({ kind: 'unavailable' });
    reply = { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'x' } } };
    expect(await callLlm(provider, input, 5000)).toEqual({ kind: 'unavailable' });
    reply = { status: 200, body: message('{"suggested_value":"banana","confidence":1,"reason":"x"}') };
    expect(await callLlm(provider, input, 5000)).toEqual({ kind: 'invalid' });
  });
});
