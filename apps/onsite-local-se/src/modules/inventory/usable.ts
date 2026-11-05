/** ceil(on_hand x ratio), computed in basis points so that 30 x 0.10 is exactly 3 rather than 4. */
export function safetyStock(onHand: number, safetyRatio: number): number {
  return Math.ceil((onHand * Math.round(safetyRatio * 10_000)) / 10_000);
}

export function usableStock(onHand: number, reserved: number, safetyRatio: number): number {
  return Math.max(0, onHand - reserved - safetyStock(onHand, safetyRatio));
}

const COUNTED_UNITS = new Set(['bag', 'piece', 'pallet', 'sheet', 'roll']);

/**
 * Whether stock reported in one unit can be counted in a product's base unit. "piece" counts sellable
 * items, so it matches any counted unit one to one. Anything else needs a verified conversion factor,
 * which does not exist in Phase 1 and is never guessed, so such stock stays out of usable.
 */
export function isUnitCompatible(reportedUnit: string | null, baseUnit: string | null): boolean {
  if (!reportedUnit || !baseUnit) return false;
  if (reportedUnit === baseUnit) return true;
  return reportedUnit === 'piece' && COUNTED_UNITS.has(baseUnit);
}
