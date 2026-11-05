import { describe, expect, it } from 'vitest';
import { buildNormalizationKey, hashRawValue, normalizeRawValue } from '../../src/modules/normalization/key.js';

describe('normalization key builder', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeRawValue('  Byggcement   Std\t25KG  SÄCK ')).toBe('byggcement std 25kg säck');
  });

  it('hashes equivalent raw values identically', () => {
    expect(hashRawValue(' Säck ')).toBe(hashRawValue('säck'));
    expect(hashRawValue('säck')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRawValue('säck')).not.toBe(hashRawValue('sack'));
  });

  it('keys by source system and field as well as value', () => {
    const key = buildNormalizationKey('sweden-legacy', 'unit', 'Säck');
    expect(key).toEqual({ sourceSystem: 'sweden-legacy', field: 'unit', rawValueHash: hashRawValue('säck') });
    expect(buildNormalizationKey('other', 'unit', 'Säck').rawValueHash).toBe(key.rawValueHash);
  });
});
