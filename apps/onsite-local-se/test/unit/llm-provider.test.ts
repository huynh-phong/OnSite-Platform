import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveLlmApiKey } from '../../src/config.js';
import { AnthropicLlmProvider, callLlm, createLlmProvider, GeminiLlmProvider, MockLlmProvider, type SuggestInput } from '../../src/connectors/llm.js';
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

describe('mock order reader', () => {
  it('quotes each line from its quantity, leaving greetings and delivery notes out', async () => {
    const catalog = [
      { sku_id: 'SE-CEM-025', name: 'Portland cement 25 kg bag', unit: 'bag' },
      { sku_id: 'SE-GYP-13-2400', name: 'Gypsum board 13 mm 900x2400', unit: 'sheet' },
    ];
    const text = 'Hej! Ring mig på [removed]. Vi behöver 20 säckar Byggcement 25kg och 2 pall gips 13mm 900x2400. Leverans tis 07:00.';
    const { lines } = (await new MockLlmProvider().parseOrder({ text, catalog })) as {
      lines: { sku_id: string; quantity: number; source_text: string }[];
    };
    expect(lines.map((line) => [line.sku_id, line.quantity, line.source_text])).toEqual([
      ['SE-CEM-025', 20, '20 säckar Byggcement 25kg'],
      ['SE-GYP-13-2400', 2, '2 pall gips 13mm 900x2400'],
    ]);
  });
});

describe('Gemini provider (against a local stand-in)', () => {
  let server: Server;
  let baseUrl: string;
  let lastUrl = '';
  let lastHeaders: IncomingHttpHeaders = {};
  let lastBody: Record<string, any> = {};
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  let calls = 0;
  let failFirst = 0;
  const answer = (text: string) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });
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
        lastUrl = request.url ?? '';
        lastHeaders = request.headers;
        lastBody = JSON.parse(Buffer.concat(chunks).toString());
        calls += 1;
        const current = calls <= failFirst ? { status: 503, body: { error: { code: 503, message: 'busy', status: 'UNAVAILABLE' } } } : reply;
        response.statusCode = current.status;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(current.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    calls = 0;
    failFirst = 0;
    reply = { status: 200, body: answer(JSON.stringify({ suggested_value: 'bag', confidence: 0.95, reason: 'säck means bag', evidence: null })) };
  });

  it('asks for schema-bound JSON, and sends only the value, field, description and allowed values', async () => {
    const provider = new GeminiLlmProvider('test-key', undefined, baseUrl);
    const result = await callLlm(provider, input, 5000);
    expect(result).toMatchObject({ kind: 'ok', suggestion: 'bag', confidence: 0.95 });
    expect(lastUrl).toContain('gemini-flash-lite-latest:generateContent');
    // The key travels in a header, never in the URL.
    expect(lastHeaders['x-goog-api-key']).toBe('test-key');
    expect(lastUrl).not.toContain('test-key');
    expect(lastBody.generationConfig.responseMimeType).toBe('application/json');
    expect(lastBody.generationConfig.responseSchema.properties.suggested_value.enum).toContain('bag');
    const sent = JSON.parse(lastBody.contents[0].parts[0].text);
    expect(Object.keys(sent).sort()).toEqual(['allowed_values', 'field', 'product_description', 'raw_value']);
  });

  it('retries once on a temporary provider error, and gives up after that', async () => {
    const provider = new GeminiLlmProvider('k', undefined, baseUrl);
    failFirst = 1;
    expect(await callLlm(provider, input, 5000)).toMatchObject({ kind: 'ok', suggestion: 'bag' });
    expect(calls).toBe(2);
    calls = 0;
    failFirst = 2;
    expect(await callLlm(provider, input, 5000)).toEqual({ kind: 'unavailable' });
    expect(calls).toBe(2);
  });

  it('does not retry a permanent error', async () => {
    const provider = new GeminiLlmProvider('k', undefined, baseUrl);
    reply = { status: 400, body: { error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT' } } };
    expect(await callLlm(provider, input, 5000)).toEqual({ kind: 'unavailable' });
    expect(calls).toBe(1);
  });

  it('uses LLM_MODEL, and reads the key from GEMINI_API_KEY', () => {
    const provider = createLlmProvider({ provider: 'gemini', apiKey: 'k', model: 'gemini-3.5-flash', timeoutMs: 1, claimLeaseSeconds: 1, maxAttempts: 1 });
    expect(provider.modelVersion).toBe('gemini-3.5-flash');
    const saved = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'from-env';
    expect(resolveLlmApiKey('gemini')).toBe('from-env');
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  });

  it('requires an API key', () => {
    expect(() =>
      createLlmProvider({ provider: 'gemini', apiKey: undefined, model: undefined, timeoutMs: 1, claimLeaseSeconds: 1, maxAttempts: 1 }),
    ).toThrow(/GEMINI_API_KEY/);
  });

  it('turns an API error, invalid output and a value outside the list into a manual review, reporting only the status', async () => {
    const provider = new GeminiLlmProvider('k', undefined, baseUrl);
    reply = { status: 404, body: { error: { code: 404, message: 'gone', status: 'NOT_FOUND' } } };
    const failures: unknown[] = [];
    expect(await callLlm(provider, input, 5000, (failure) => failures.push(failure))).toEqual({ kind: 'unavailable' });
    expect(failures).toEqual([{ status: 404, name: expect.any(String) }]);
    reply = { status: 200, body: answer('not json') };
    expect(await callLlm(provider, input, 5000)).toEqual({ kind: 'invalid' });
    reply = { status: 200, body: answer('{"suggested_value":"banana","confidence":1,"reason":"x"}') };
    expect(await callLlm(provider, input, 5000)).toEqual({ kind: 'invalid' });
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
