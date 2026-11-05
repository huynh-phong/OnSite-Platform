import { unitFromText } from '../../connectors/llm.js';
import { isUnitCompatible } from '../inventory/usable.js';

export const MAX_ORDER_TEXT = 2000;
const MAX_LINES = 50;
/** Round 1: below this, a match always goes to a person. Here every line does; this one is flagged. */
export const LOW_CONFIDENCE = 0.7;

const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi;
const PHONE = /(?:\+46|\b0)[\s-]?\d{1,3}(?:[\s-]?\d{2,4}){2,4}\b/g;
const PERSONAL_NUMBER = /\b(?:19|20)?\d{6}[-+]?\d{4}\b/g;

/**
 * Contact details are removed before the text leaves Local SE: the reader needs products and quantities,
 * not who wrote the message. Returns how many were removed, so the screen can say so.
 */
export function redactContactDetails(text: string): { text: string; removed: number } {
  let removed = 0;
  const redacted = [EMAIL, PERSONAL_NUMBER, PHONE].reduce(
    (current, pattern) =>
      current.replace(pattern, () => {
        removed += 1;
        return '[removed]';
      }),
    text,
  );
  return { text: redacted, removed };
}

export interface DraftCatalogEntry {
  sku_id: string;
  name: string;
  unit: string;
}

export type DraftCheck = 'NO_PRODUCT' | 'LOW_CONFIDENCE' | 'UNIT_MISMATCH';

export interface DraftLine {
  sku_id: string | null;
  name: string | null;
  quantity: number;
  /** The unit the product is sold in. */
  unit: string | null;
  /** The unit word in the message, and what it means by fixed rules. Never converted. */
  unit_text: string;
  stated_unit: string | null;
  source_text: string;
  confidence: number;
  reason: string;
  checks: DraftCheck[];
}

const squash = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Deterministic guardrails on the reader's untrusted output. A line survives only if it quotes the message
 * word for word, its quantity is a sensible whole number written in that quote, and its product, if any, is
 * in the catalog. A surviving line is still only a suggestion: the checks tell the person what to look at.
 */
export function validateOrderDraft(
  text: string,
  catalog: DraftCatalogEntry[],
  output: unknown,
): { lines: DraftLine[]; dropped: number } | undefined {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const raw = (value as { lines?: unknown } | null)?.lines;
  if (!Array.isArray(raw) || raw.length > MAX_LINES) return undefined;

  const message = squash(text);
  const lines: DraftLine[] = [];
  let dropped = 0;
  for (const entry of raw as Record<string, unknown>[]) {
    const { sku_id: skuId, quantity, unit_text: unitText, source_text: source, confidence, reason } = entry ?? {};
    const quoted =
      typeof source === 'string' && source.trim() !== '' && message.includes(squash(source));
    const sensible =
      typeof quantity === 'number' &&
      Number.isInteger(quantity) &&
      quantity >= 1 &&
      quantity <= 1_000_000 &&
      typeof source === 'string' &&
      new RegExp(`(^|\\D)${quantity}(\\D|$)`).test(source);
    const scored = typeof confidence === 'number' && confidence >= 0 && confidence <= 1;
    if (!quoted || !sensible || !scored || (skuId !== null && typeof skuId !== 'string')) {
      dropped += 1;
      continue;
    }
    const product = typeof skuId === 'string' ? catalog.find((candidate) => candidate.sku_id === skuId) : undefined;
    const unitWord = typeof unitText === 'string' ? unitText.trim() : '';
    const stated = unitWord ? unitFromText(unitWord) : null;
    const checks: DraftCheck[] = [];
    if (!product) checks.push('NO_PRODUCT');
    if (confidence < LOW_CONFIDENCE) checks.push('LOW_CONFIDENCE');
    // The same rule as for stock: "st" counts any counted unit one to one; anything else is never converted.
    if (product && stated && !isUnitCompatible(stated, product.unit)) checks.push('UNIT_MISMATCH');
    lines.push({
      sku_id: product?.sku_id ?? null,
      name: product?.name ?? null,
      quantity,
      unit: product?.unit ?? null,
      unit_text: unitWord,
      stated_unit: stated,
      source_text: (source as string).trim(),
      confidence,
      reason: typeof reason === 'string' ? reason.slice(0, 300) : '',
      checks,
    });
  }
  return { lines, dropped };
}
