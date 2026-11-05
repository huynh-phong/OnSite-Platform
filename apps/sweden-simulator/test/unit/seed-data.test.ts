import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const load = (file: string) => JSON.parse(readFileSync(new URL(`../../seed/${file}`, import.meta.url), 'utf8'));
const usable = (onHand: number) => Math.max(0, onHand - Math.ceil(onHand * 0.1));

describe('simulator seed data', () => {
  it('has stores A to J and one hub', () => {
    const stores = load('stores.json') as { store_id: string; type: string; prep_minutes: number }[];
    expect(stores.filter((s) => s.type === 'STORE').map((s) => s.store_id.at(-1)).join('')).toBe('ABCDEFGHIJ');
    expect(stores.filter((s) => s.type === 'HUB').map((s) => s.store_id)).toEqual(['SE-HUB-01']);
    expect(new Set(stores.filter((s) => s.type === 'STORE').map((s) => s.prep_minutes))).toEqual(new Set([60]));
    expect(stores.find((s) => s.type === 'HUB')?.prep_minutes).toBe(90);
  });

  it('has 20 SKUs across 4 categories, with SE-CEM-025 as specified', () => {
    const { products } = load('products.json');
    expect(products).toHaveLength(20);
    expect(new Set(products.map((p: { source_category: string }) => p.source_category)).size).toBe(4);
    expect(products.find((p: { sku_id: string }) => p.sku_id === 'SE-CEM-025')).toMatchObject({
      name: 'Portland cement 25 kg bag',
      source_unit: 'bag',
      unit_price_sek: 89,
    });
  });

  it('gives the usable stock S1 and S2 require', () => {
    const { scenarios } = load('inventory-scenarios.json');
    const s1 = scenarios.S1.on_hand['SE-CEM-025'];
    const s2 = scenarios.S2.on_hand['SE-CEM-025'];
    expect([usable(s1['SE-STORE-B']), usable(s1['SE-HUB-01'])]).toEqual([54, 54]);
    expect([usable(s2['SE-STORE-B']), usable(s2['SE-HUB-01'])]).toEqual([54, 36]);
    expect(Object.keys(s1).sort()).toEqual(['SE-HUB-01', 'SE-STORE-B']);
    expect(Object.keys(s2).sort()).toEqual(['SE-HUB-01', 'SE-STORE-B']);
  });
});
