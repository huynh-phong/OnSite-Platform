import { createHash } from 'node:crypto';

export type NormalizationField = 'unit' | 'category' | 'pack_size_kg';

export interface NormalizationKey {
  sourceSystem: string;
  field: NormalizationField;
  rawValueHash: string;
}

export function normalizeRawValue(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function hashRawValue(raw: string): string {
  return createHash('sha256').update(normalizeRawValue(raw), 'utf8').digest('hex');
}

export function buildNormalizationKey(sourceSystem: string, field: NormalizationField, raw: string): NormalizationKey {
  return { sourceSystem, field, rawValueHash: hashRawValue(raw) };
}
