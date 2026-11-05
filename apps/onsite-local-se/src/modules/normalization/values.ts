import type { NormalizationField } from './key.js';

export const ALLOWED_UNITS = ['bag', 'piece', 'pallet', 'sheet', 'm', 'm2', 'm3', 'kg', 'roll'] as const;
export const ALLOWED_CATEGORIES = ['cement', 'timber', 'gypsum_board', 'insulation', 'other'] as const;

export function allowedValues(field: NormalizationField): readonly string[] | null {
  if (field === 'unit') return ALLOWED_UNITS;
  if (field === 'category') return ALLOWED_CATEGORIES;
  return null;
}

/** Whether a value may be stored as a mapping for the field. Applies to AI output and to human edits. */
export function isValidNormalizedValue(field: NormalizationField, value: string): boolean {
  const allowed = allowedValues(field);
  if (allowed) return allowed.includes(value);
  const number = Number(value);
  return value.trim() !== '' && Number.isFinite(number) && number > 0 && number < 100_000;
}

/** A description only needs a verified pack size if it actually states a weight. */
export function statesPackWeight(description: string): boolean {
  return /\d\s*(kg|kilo)/i.test(description);
}
