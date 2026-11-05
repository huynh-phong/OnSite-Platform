import { describe, expect, it } from 'vitest';
import { planAllocation, type PlanInput, type PlanNode } from '../../src/modules/routing/plan.js';

const eta = {
  timeZone: 'Europe/Stockholm',
  dispatchSlots: ['07:00', '09:00', '11:00', '13:00', '15:00'],
  avgSpeedKmh: 40,
  unloadMinutes: 15,
};
const site = { lat: 57.629, lng: 11.929 };
const nodes: PlanNode[] = [
  { node_id: 'SE-STORE-B', lat: 57.6554, lng: 12.0138, prep_minutes: 60, active: true },
  { node_id: 'SE-HUB-01', lat: 57.688, lng: 12.208, prep_minutes: 90, active: true },
  { node_id: 'SE-STORE-A', lat: 57.7089, lng: 11.9746, prep_minutes: 60, active: true },
  { node_id: 'SE-STORE-D', lat: 57.871, lng: 11.9805, prep_minutes: 60, active: true },
];
const stock = (entries: Record<string, number>, stale = false) =>
  Object.entries(entries).map(([node_id, usable]) => ({ node_id, sku_id: 'CEM', usable, stale }));
const input = (quantity: number, overrides: Partial<PlanInput> = {}): PlanInput => ({
  lines: [{ item_id: 'i1', sku_id: 'CEM', quantity }],
  site,
  salesStoreId: 'SE-STORE-B',
  now: new Date('2026-11-09T06:00:00Z'),
  nodes,
  inventory: [],
  excludedNodes: [],
  eta,
  maxSourcesPerLine: 3,
  ...overrides,
});

describe('planAllocation', () => {
  it('S1: 100 bags split 54 at Store B and 46 at the hub', () => {
    const plan = planAllocation(input(100, { inventory: stock({ 'SE-STORE-B': 54, 'SE-HUB-01': 54 }) }));
    expect(plan.status).toBe('OK');
    expect(plan.allocations.map((a) => [a.node_id, a.quantity])).toEqual([
      ['SE-STORE-B', 54],
      ['SE-HUB-01', 46],
    ]);
    expect(plan.allocations[0]!.routing_reason).toContain('usable 54');
    expect(plan.allocations[1]!.routing_reason).toContain('remaining 46');
  });

  it('S2: 100 bags is a shortage with 90 fulfillable and nothing allocated', () => {
    const plan = planAllocation(input(100, { inventory: stock({ 'SE-STORE-B': 54, 'SE-HUB-01': 36 }) }));
    expect(plan.status).toBe('SHORTAGE');
    expect(plan.fulfillable_qty).toBe(90);
    expect(plan.allocations).toEqual([]);
    expect(plan.shortages).toEqual([{ item_id: 'i1', sku_id: 'CEM', requested: 100, fulfillable: 90 }]);
  });

  it('prefers one node that covers the whole line, by earliest ETA', () => {
    const plan = planAllocation(input(30, { inventory: stock({ 'SE-STORE-B': 54, 'SE-HUB-01': 54, 'SE-STORE-D': 54 }) }));
    expect(plan.allocations.map((a) => [a.node_id, a.quantity])).toEqual([['SE-STORE-B', 30]]);
  });

  it('uses a farther node that covers the line rather than splitting', () => {
    const plan = planAllocation(input(30, { inventory: stock({ 'SE-STORE-B': 10, 'SE-HUB-01': 54 }) }));
    expect(plan.allocations.map((a) => [a.node_id, a.quantity])).toEqual([['SE-HUB-01', 30]]);
  });

  it('breaks an ETA tie by the sales store, then distance, then node id', () => {
    // The same place, so ETA and distance are equal for both.
    const twins: PlanNode[] = [
      { node_id: 'SE-Z', lat: 57.65, lng: 12, prep_minutes: 60, active: true },
      { node_id: 'SE-A', lat: 57.65, lng: 12, prep_minutes: 60, active: true },
    ];
    const inventory = stock({ 'SE-Z': 50, 'SE-A': 50 });
    expect(planAllocation(input(10, { nodes: twins, inventory, salesStoreId: 'SE-Z' })).allocations[0]!.node_id).toBe('SE-Z');
    expect(planAllocation(input(10, { nodes: twins, inventory, salesStoreId: 'OTHER' })).allocations[0]!.node_id).toBe('SE-A');
    const near = { ...twins[0]!, lat: 57.64 };
    expect(planAllocation(input(10, { nodes: [twins[1]!, near], inventory, salesStoreId: 'OTHER' })).allocations[0]!.node_id).toBe('SE-Z');
  });

  it('uses at most three sources per line', () => {
    const plan = planAllocation(input(100, { inventory: stock({ 'SE-STORE-B': 30, 'SE-HUB-01': 30, 'SE-STORE-A': 30, 'SE-STORE-D': 30 }) }));
    expect(plan.status).toBe('SHORTAGE');
    expect(plan.fulfillable_qty).toBe(90);
  });

  it('excludes stale, inactive, excluded and empty nodes', () => {
    const inventory = [
      ...stock({ 'SE-STORE-B': 50 }, true),
      ...stock({ 'SE-HUB-01': 0, 'SE-STORE-A': 50, 'SE-STORE-D': 50 }),
    ];
    const plan = planAllocation(
      input(10, {
        inventory,
        excludedNodes: ['SE-STORE-A'],
        nodes: nodes.map((node) => (node.node_id === 'SE-HUB-01' ? { ...node, active: false } : node)),
      }),
    );
    expect(plan.allocations.map((a) => a.node_id)).toEqual(['SE-STORE-D']);
  });

  it('does not promise the same stock twice across lines of one SKU', () => {
    const plan = planAllocation(
      input(0, {
        lines: [
          { item_id: 'i1', sku_id: 'CEM', quantity: 40 },
          { item_id: 'i2', sku_id: 'CEM', quantity: 40 },
        ],
        inventory: stock({ 'SE-STORE-B': 50 }),
      }),
    );
    expect(plan.status).toBe('SHORTAGE');
    expect(plan.fulfillable_qty).toBe(50);
  });

  it('is deterministic', () => {
    const request = input(100, { inventory: stock({ 'SE-STORE-B': 54, 'SE-HUB-01': 54, 'SE-STORE-A': 3 }) });
    expect(planAllocation(request)).toEqual(planAllocation(structuredClone(request)));
  });
});
