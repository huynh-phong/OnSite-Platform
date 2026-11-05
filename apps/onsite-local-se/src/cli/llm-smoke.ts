import { resolveLlmApiKey, type LlmProviderName } from '../config.js';
import { callLlm, createLlmProvider, type SuggestInput } from '../connectors/llm.js';
import { allowedValues } from '../modules/normalization/values.js';

// A deliberately small connectivity check: three calls. It says nothing about accuracy, and it never
// prints the API key. Use eval:normalization for a measurement.
const provider = (process.env.LLM_PROVIDER_OVERRIDE ?? process.env.LLM_PROVIDER ?? 'mock') as LlmProviderName;
const timeoutMs = Number(process.env.LLM_TIMEOUT_SECONDS ?? 20) * 1000;
const apiKey = resolveLlmApiKey(provider);
console.log(`Provider: ${provider}; API key present: ${apiKey ? 'yes' : 'no'}`);

const llm = createLlmProvider({
  provider,
  apiKey,
  model: process.env.LLM_MODEL || undefined,
  timeoutMs,
  claimLeaseSeconds: 60,
  maxAttempts: 3,
});
console.log(`Model: ${llm.modelVersion}`);

const inputs: SuggestInput[] = [
  { field: 'unit', rawValue: 'säck', description: 'Byggcement Std 25kg säck', allowedValues: allowedValues('unit') },
  { field: 'category', rawValue: 'mineralull', description: 'Stenull 95 mm', allowedValues: allowedValues('category') },
  { field: 'pack_size_kg', rawValue: 'byggcement std 25kg säck', description: 'Byggcement Std 25kg säck', allowedValues: null },
];

let failed = 0;
for (const input of inputs) {
  const started = Date.now();
  const result = await callLlm(llm, input, timeoutMs, (failure) => console.log(`      provider error: ${JSON.stringify(failure)}`));
  const elapsed = Date.now() - started;
  if (result.kind === 'ok') {
    console.log(
      `ok    ${input.field} "${input.rawValue}" -> ${result.suggestion} (confidence ${result.confidence}, ${elapsed} ms): ${result.reason}`,
    );
  } else {
    failed += 1;
    console.log(`FAIL  ${input.field} "${input.rawValue}": ${result.kind} after ${elapsed} ms`);
  }
}
process.exit(failed ? 1 : 0);
