import { callLlm, type LlmProvider } from '../../connectors/llm.js';
import type { NormalizationField } from './key.js';
import { normalizeRawValue } from './key.js';
import { allowedValues } from './values.js';

export interface LabelledExample {
  id: number;
  field: NormalizationField;
  raw: string;
  description: string;
  expected: string;
}

export type ExampleVerdict = 'correct' | 'edit_needed' | 'invalid_output' | 'unavailable';

export interface EvalRow {
  id: number;
  field: NormalizationField;
  raw: string;
  expected: string;
  suggestion: string | null;
  confidence: number | null;
  verdict: ExampleVerdict;
}

const sameValue = (field: NormalizationField, a: string, b: string) =>
  field === 'pack_size_kg' ? Number(a) === Number(b) : a === b;

/** Runs the provider over the labelled set, through the same validation as production. */
export async function runEvaluation(provider: LlmProvider, examples: LabelledExample[], timeoutMs: number): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  for (const example of examples) {
    const result = await callLlm(
      provider,
      {
        field: example.field,
        rawValue: normalizeRawValue(example.raw),
        description: example.description,
        allowedValues: allowedValues(example.field),
      },
      timeoutMs,
    );
    rows.push({
      id: example.id,
      field: example.field,
      raw: example.raw,
      expected: example.expected,
      suggestion: result.kind === 'ok' ? result.suggestion : null,
      confidence: result.kind === 'ok' ? result.confidence : null,
      verdict:
        result.kind === 'ok'
          ? sameValue(example.field, result.suggestion, example.expected)
            ? 'correct'
            : 'edit_needed'
          : result.kind === 'invalid'
            ? 'invalid_output'
            : 'unavailable',
    });
  }
  return rows;
}

function rates(rows: EvalRow[]) {
  const share = (verdict: ExampleVerdict) => (rows.length ? rows.filter((row) => row.verdict === verdict).length / rows.length : 0);
  return {
    total: rows.length,
    accuracy: share('correct'),
    edit_needed_rate: share('edit_needed'),
    invalid_output_rate: share('invalid_output'),
    unavailable_rate: share('unavailable'),
  };
}

export function summarize(rows: EvalRow[]) {
  const fields: NormalizationField[] = ['unit', 'category', 'pack_size_kg'];
  const buckets: [string, number, number][] = [
    ['0.00-0.49', 0, 0.5],
    ['0.50-0.79', 0.5, 0.8],
    ['0.80-1.00', 0.8, 1.01],
  ];
  return {
    ...rates(rows),
    by_field: Object.fromEntries(fields.map((field) => [field, rates(rows.filter((row) => row.field === field))])),
    accuracy_by_confidence: buckets.map(([label, low, high]) => {
      const bucket = rows.filter((row) => row.confidence !== null && row.confidence >= low && row.confidence < high);
      return { confidence: label, count: bucket.length, accuracy: bucket.length ? rates(bucket).accuracy : null };
    }),
  };
}
