import { readFile } from 'node:fs/promises';
import { createLlmProvider } from '../connectors/llm.js';
import { runEvaluation, summarize, type LabelledExample } from '../modules/normalization/eval.js';

// Reads only what it needs, so that it runs without a database or the other secrets.
const provider = (process.env.LLM_PROVIDER ?? 'mock') as 'mock' | 'anthropic';
const timeoutMs = Number(process.env.LLM_TIMEOUT_SECONDS ?? 30) * 1000;
const llm = createLlmProvider({
  provider,
  apiKey: process.env.LLM_API_KEY || undefined,
  model: process.env.LLM_MODEL || undefined,
  timeoutMs,
  claimLeaseSeconds: 60,
  maxAttempts: 3,
});

const examples = JSON.parse(
  await readFile(new URL('../../seed/normalization-testset.json', import.meta.url), 'utf8'),
) as LabelledExample[];

const rows = await runEvaluation(llm, examples, timeoutMs);
const summary = summarize(rows);
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

console.log(`Provider: ${provider} (${llm.modelVersion})`);
if (provider === 'mock') {
  console.log('The mock provider is deterministic keyword rules, not a model. These numbers say nothing about AI quality.');
}
console.log(`Examples: ${summary.total}`);
console.log(`Accuracy:            ${percent(summary.accuracy)}`);
console.log(`Edit-needed rate:    ${percent(summary.edit_needed_rate)}`);
console.log(`Invalid-output rate: ${percent(summary.invalid_output_rate)}`);
console.log(`Unavailable rate:    ${percent(summary.unavailable_rate)}`);
console.log('\nBy field:');
for (const [field, stats] of Object.entries(summary.by_field)) {
  console.log(
    `  ${field.padEnd(14)} n=${String(stats.total).padEnd(3)} accuracy ${percent(stats.accuracy).padEnd(7)} edit ${percent(stats.edit_needed_rate).padEnd(7)} invalid ${percent(stats.invalid_output_rate).padEnd(7)} unavailable ${percent(stats.unavailable_rate)}`,
  );
}
console.log('\nAccuracy by confidence:');
for (const bucket of summary.accuracy_by_confidence) {
  console.log(`  ${bucket.confidence}  n=${String(bucket.count).padEnd(3)} ${bucket.accuracy === null ? '-' : percent(bucket.accuracy)}`);
}
const misses = rows.filter((row) => row.verdict !== 'correct');
if (misses.length) {
  console.log('\nNot correct:');
  for (const row of misses) {
    console.log(`  #${row.id} ${row.field} "${row.raw}": expected ${row.expected}, got ${row.suggestion ?? '-'} (${row.verdict})`);
  }
}
