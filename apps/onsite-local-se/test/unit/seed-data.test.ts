import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const load = (file: string) => JSON.parse(readFileSync(new URL(`../../seed/${file}`, import.meta.url), 'utf8'));
const loadSim = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../../sweden-simulator/seed/${file}`, import.meta.url), 'utf8'));

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

describe('Local SE seed data', () => {
  const stores = load('stores.json') as { store_id: string; lat: number; lng: number }[];
  const sites = load('customers.json')[0].sites as { site_id: string; lat: number; lng: number }[];
  const storeB = stores.find((store) => store.store_id === 'SE-STORE-B')!;
  const hub = stores.find((store) => store.store_id === 'SE-HUB-01')!;

  it('keeps its store list identical to the simulator', () => {
    expect(stores).toEqual(loadSim('stores.json'));
  });

  it('places the near site about 6 km from Store B and closer to B than to the hub', () => {
    const km = haversineKm(storeB, sites[0]!);
    expect(km).toBeGreaterThan(5.5);
    expect(km).toBeLessThan(6.5);
    expect(haversineKm(hub, sites[0]!)).toBeGreaterThan(km);
  });

  it('places the far site over 50 km from every node and over 100 km from Store B', () => {
    for (const store of stores) expect(haversineKm(store, sites[1]!)).toBeGreaterThan(50);
    expect(haversineKm(storeB, sites[1]!)).toBeGreaterThan(100);
  });

  it('pre-approves exactly the source values of the seeded catalog', () => {
    const baseline = load('normalization-baseline.json');
    const { products, ai_demo_products: demo } = loadSim('products.json');
    for (const product of products) {
      expect(baseline.unit).toContain(product.source_unit);
      expect(baseline.category).toContain(product.source_category);
    }
    expect(baseline.unit).not.toContain(demo[0].source_unit);
    expect(baseline.unit).not.toContain('st');
    const withWeight = products.filter((p: { source_description: string }) => /\bkg\b/i.test(p.source_description));
    expect(Object.keys(baseline.pack_size_kg).sort()).toEqual(
      withWeight.map((p: { source_description: string }) => p.source_description).sort(),
    );
  });

  it('seeds the five demo users', () => {
    expect((load('users.json') as { user_id: string }[]).map((user) => user.user_id)).toEqual([
      'buyer.nordbygg',
      'staff.store-b',
      'staff.hub-01',
      'staff.store-c',
      'admin.se',
    ]);
  });
});
