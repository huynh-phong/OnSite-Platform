import type { Config } from '../config.js';
import type { NormalizationField } from '../modules/normalization/key.js';
import { isValidNormalizedValue } from '../modules/normalization/values.js';

/**
 * Everything the provider ever sees: the value, the field, the product description and the allowed
 * values. By construction it cannot carry customer data, prices or stock.
 */
export interface SuggestInput {
  field: NormalizationField;
  rawValue: string;
  description: string | null;
  allowedValues: readonly string[] | null;
}

export interface LlmProvider {
  readonly modelVersion: string;
  /** Returns the provider's output as is. It is untrusted and validated by the caller. */
  suggest(input: SuggestInput, signal: AbortSignal): Promise<unknown>;
}

export interface ValidSuggestion {
  suggestion: string;
  confidence: number;
  reason: string;
  evidence: string | null;
}

export type LlmResult =
  | ({ kind: 'ok' } & ValidSuggestion)
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

/** Accepts only a schema-valid suggestion within the allowed values. A pack size must quote its source. */
export function validateLlmOutput(input: SuggestInput, output: unknown): ValidSuggestion | undefined {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { suggested_value: raw, confidence, reason, evidence } = value as Record<string, unknown>;
  const suggestion = typeof raw === 'number' ? String(raw) : raw;
  if (typeof suggestion !== 'string' || !isValidNormalizedValue(input.field, suggestion)) return undefined;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) return undefined;
  if (typeof reason !== 'string' || reason.trim() === '') return undefined;
  if (evidence !== undefined && evidence !== null && typeof evidence !== 'string') return undefined;
  if (input.field === 'pack_size_kg') {
    if (typeof evidence !== 'string' || evidence.trim() === '') return undefined;
    if (!input.rawValue.toLowerCase().includes(evidence.toLowerCase())) return undefined;
    if (!evidence.replace(',', '.').includes(String(Number(suggestion)))) return undefined;
  }
  return { suggestion, confidence, reason, evidence: typeof evidence === 'string' ? evidence : null };
}

/** Runs the provider with a timeout. Never throws: failure means the review is handled manually. */
export async function callLlm(
  provider: LlmProvider,
  input: SuggestInput,
  timeoutMs: number,
  onError?: (failure: { status?: number; name: string }) => void,
): Promise<LlmResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('LLM timeout'));
    }, timeoutMs);
  });
  try {
    const output = await Promise.race([provider.suggest(input, controller.signal), timeout]);
    const valid = validateLlmOutput(input, output);
    return valid ? { kind: 'ok', ...valid } : { kind: 'invalid' };
  } catch (error) {
    // Only the status and type: provider messages can echo request details.
    const { status, name } = error as { status?: number; name: string };
    onError?.({ ...(typeof status === 'number' ? { status } : {}), name });
    return { kind: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

const UNIT_RULES: [RegExp, string][] = [
  [/\b(säck|säckar|sack|sk|bag|bags|påse|påsar)\b/, 'bag'],
  [/\b(st|styck|stycken|pcs|pc|piece|pieces)\b/, 'piece'],
  [/\b(pall|pallar|pallet|pallets|eur-pall)\b/, 'pallet'],
  [/\b(skiva|skivor|sheet|sheets|platta|plattor)\b/, 'sheet'],
  [/\b(rulle|rullar|roll|rolls)\b/, 'roll'],
  [/(^|\s)(m2|m²|kvm|kvadratmeter|sqm)(\s|$)/, 'm2'],
  [/(^|\s)(m3|m³|kbm|kubikmeter|cbm)(\s|$)/, 'm3'],
  [/\b(kg|kilo|kilogram)\b/, 'kg'],
  [/\b(m|meter|metre|lm|lpm|löpmeter)\b/, 'm'],
];

const CATEGORY_RULES: [RegExp, string][] = [
  [/gips|gypsum|plasterboard/, 'gypsum_board'],
  [/isoler|insulation|mineralull|glasull|stenull|cellplast|glass wool|stone wool|rock wool|eps|xps/, 'insulation'],
  [/cement|betong|bruk|mortel|mortar|concrete/, 'cement'],
  [/virke|timber|trä|regel|reglar|plank|panel|plywood|lumber|wood|bräd|board/, 'timber'],
];

/** Deterministic keyword rules, for tests and for running without a provider. Not a real model. */
export class MockLlmProvider implements LlmProvider {
  readonly modelVersion = 'mock-rules-v1';

  async suggest(input: SuggestInput): Promise<unknown> {
    const text = input.rawValue.trim().toLowerCase();
    if (input.field === 'pack_size_kg') {
      const match = /(\d+(?:[.,]\d+)?)\s*(?:kg|kilo)/i.exec(input.rawValue);
      if (!match) return { suggested_value: null, confidence: 0, reason: 'No weight in the text' };
      return {
        suggested_value: match[1]!.replace(',', '.'),
        confidence: 0.9,
        reason: 'Weight stated in the description',
        evidence: match[0],
      };
    }
    const rules = input.field === 'unit' ? UNIT_RULES : CATEGORY_RULES;
    for (const [pattern, value] of rules) {
      if (pattern.test(text)) {
        return { suggested_value: value, confidence: 0.85, reason: `Keyword rule matched "${text}"` };
      }
    }
    if (input.field === 'category') {
      return { suggested_value: 'other', confidence: 0.3, reason: 'No known keyword' };
    }
    return { suggested_value: null, confidence: 0, reason: 'No known keyword' };
  }
}

const SYSTEM_PROMPT = `You normalize free-text product data from a Swedish building-materials retailer's source systems.
Return a suggestion for one field. A human reviews every suggestion before it is used.

- unit: choose the single allowed value that the source unit means. "st"/"styck" means piece; "säck" means bag; "pall" means pallet.
- category: choose the single allowed value that fits the product.
- pack_size_kg: return the weight of one pack in kilograms as a number, only if the text states it, and put the exact words from the text that state it in "evidence". Never estimate.

confidence is your probability from 0 to 1 that the suggestion is correct. reason is one short sentence.
If nothing fits, use the closest value and a low confidence.`;

function buildUserPrompt(input: SuggestInput): string {
  return JSON.stringify({
    field: input.field,
    raw_value: input.rawValue,
    product_description: input.description,
    allowed_values: input.allowedValues,
  });
}

function outputSchema(input: SuggestInput) {
  return {
    type: 'object',
    properties: {
      suggested_value: input.allowedValues ? { type: 'string', enum: [...input.allowedValues] } : { type: 'string' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
      evidence: { type: ['string', 'null'] },
    },
    required: ['suggested_value', 'confidence', 'reason', 'evidence'],
    additionalProperties: false,
  };
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/** Real provider. The SDK loads only when this provider is selected. */
export class AnthropicLlmProvider implements LlmProvider {
  readonly modelVersion: string;
  private client: Promise<import('@anthropic-ai/sdk').default> | undefined;

  constructor(
    private readonly apiKey: string,
    model?: string,
    private readonly baseURL?: string,
  ) {
    this.modelVersion = model ?? DEFAULT_ANTHROPIC_MODEL;
  }

  private getClient() {
    this.client ??= import('@anthropic-ai/sdk').then(({ default: Anthropic }) => new Anthropic({ apiKey: this.apiKey, ...(this.baseURL ? { baseURL: this.baseURL } : {}) }));
    return this.client;
  }

  async suggest(input: SuggestInput, signal: AbortSignal): Promise<unknown> {
    const client = await this.getClient();
    const params = {
      model: this.modelVersion,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: outputSchema(input) } },
      // Lets the API retry on another model if a safety classifier declines this short request.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: buildUserPrompt(input) }],
    };
    const response = await client.beta.messages.create(params as never, { signal, maxRetries: 0 });
    const message = response as unknown as { stop_reason: string; content: { type: string; text?: string }[] };
    if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') {
      throw new Error(`LLM stopped: ${message.stop_reason}`);
    }
    return message.content.find((block) => block.type === 'text')?.text;
  }
}

// An alias, because Google retires specific model ids for new keys. Pin one with LLM_MODEL if needed.
const DEFAULT_GEMINI_MODEL = 'gemini-flash-lite-latest';

/** Gemini's schema dialect: upper-case types, and nullable instead of a type list. */
function geminiSchema(input: SuggestInput) {
  return {
    type: 'OBJECT',
    properties: {
      suggested_value: input.allowedValues
        ? { type: 'STRING', enum: [...input.allowedValues] }
        : { type: 'STRING' },
      confidence: { type: 'NUMBER' },
      reason: { type: 'STRING' },
      evidence: { type: 'STRING', nullable: true },
    },
    required: ['suggested_value', 'confidence', 'reason'],
  };
}

/** Real provider, through Google's official SDK, which loads only when this provider is selected. */
export class GeminiLlmProvider implements LlmProvider {
  readonly modelVersion: string;
  private client: Promise<import('@google/genai').GoogleGenAI> | undefined;

  constructor(
    private readonly apiKey: string,
    model?: string,
    private readonly baseUrl?: string,
  ) {
    this.modelVersion = model ?? DEFAULT_GEMINI_MODEL;
  }

  private getClient() {
    this.client ??= import('@google/genai').then(
      ({ GoogleGenAI }) =>
        new GoogleGenAI({
          apiKey: this.apiKey,
          ...(this.baseUrl ? { httpOptions: { baseUrl: this.baseUrl } } : {}),
        }),
    );
    return this.client;
  }

  async suggest(input: SuggestInput, signal: AbortSignal): Promise<unknown> {
    const client = await this.getClient();
    const request = () =>
      client.models.generateContent({
        model: this.modelVersion,
        contents: buildUserPrompt(input),
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: geminiSchema(input) as never,
          abortSignal: signal,
        },
      });
    try {
      return (await request()).text;
    } catch (error) {
      // One quick retry for a provider hiccup, inside the same overall timeout. Anything else goes to a human.
      const { status } = error as { status?: number };
      if (status !== 429 && !(typeof status === 'number' && status >= 500)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return (await request()).text;
    }
  }
}

export function createLlmProvider(config: Config['llm']): LlmProvider {
  if (config.provider === 'mock') return new MockLlmProvider();
  if (config.provider === 'gemini') {
    if (!config.apiKey) throw new Error('GEMINI_API_KEY is required when LLM_PROVIDER is gemini');
    return new GeminiLlmProvider(config.apiKey, config.model);
  }
  if (!config.apiKey) throw new Error('LLM_API_KEY is required when LLM_PROVIDER is anthropic');
  return new AnthropicLlmProvider(config.apiKey, config.model);
}
