import { computeShipmentEta, haversineKm, type EtaParams, type LatLng } from '../eta/eta.js';

export interface PlanLine {
  item_id: string;
  sku_id: string;
  quantity: number;
}

export interface PlanNode extends LatLng {
  node_id: string;
  prep_minutes: number;
  active: boolean;
}

export interface PlanStock {
  node_id: string;
  sku_id: string;
  usable: number;
  stale: boolean;
}

export interface PlanInput {
  lines: PlanLine[];
  site: LatLng;
  salesStoreId: string;
  now: Date;
  nodes: PlanNode[];
  inventory: PlanStock[];
  excludedNodes: string[];
  eta: EtaParams;
  maxSourcesPerLine: number;
}

export interface PlannedAllocation {
  item_id: string;
  sku_id: string;
  node_id: string;
  quantity: number;
  routing_reason: string;
}

export interface LineShortage {
  item_id: string;
  sku_id: string;
  requested: number;
  fulfillable: number;
}

export type AllocationPlan =
  | { status: 'OK'; allocations: PlannedAllocation[]; fulfillable_qty: number; shortages: [] }
  | { status: 'SHORTAGE'; allocations: []; fulfillable_qty: number; shortages: LineShortage[] };

interface Candidate {
  node: PlanNode;
  usable: number;
  etaMs: number;
  distanceKm: number;
}

const km = (value: number) => `${value.toFixed(1)} km`;

/**
 * Pure and deterministic: the same input always gives the same plan. Filters nodes, prefers one node
 * that covers the line, otherwise splits greedily by ETA up to the source limit. Ties break by sales
 * store, then distance, then node id.
 */
export function planAllocation(input: PlanInput): AllocationPlan {
  const excluded = new Set(input.excludedNodes);
  // Tracks what earlier lines took, for orders with several lines of the same SKU.
  const remaining = new Map(input.inventory.map((row) => [`${row.node_id}:${row.sku_id}`, row]));
  const left = new Map(input.inventory.map((row) => [`${row.node_id}:${row.sku_id}`, row.usable]));

  const allocations: PlannedAllocation[] = [];
  const shortages: LineShortage[] = [];
  let fulfillable = 0;

  for (const line of input.lines) {
    const candidates: Candidate[] = [];
    for (const node of input.nodes) {
      const key = `${node.node_id}:${line.sku_id}`;
      const row = remaining.get(key);
      const usable = left.get(key) ?? 0;
      if (!node.active || excluded.has(node.node_id) || !row || row.stale || usable <= 0) continue;
      const shipment = computeShipmentEta(
        { approvedAt: input.now, provisional: true, prepMinutes: node.prep_minutes, node, site: input.site },
        input.eta,
      );
      candidates.push({ node, usable, etaMs: shipment.eta.getTime(), distanceKm: haversineKm(node, input.site) });
    }
    candidates.sort(
      (a, b) =>
        a.etaMs - b.etaMs ||
        Number(b.node.node_id === input.salesStoreId) - Number(a.node.node_id === input.salesStoreId) ||
        a.distanceKm - b.distanceKm ||
        a.node.node_id.localeCompare(b.node.node_id),
    );

    const single = candidates.find((candidate) => candidate.usable >= line.quantity);
    const lineAllocations: PlannedAllocation[] = [];
    if (single) {
      lineAllocations.push({
        item_id: line.item_id,
        sku_id: line.sku_id,
        node_id: single.node.node_id,
        quantity: line.quantity,
        routing_reason: `Earliest ETA among nodes covering the line (${km(single.distanceKm)} from site), usable ${single.usable}`,
      });
    } else {
      let open = line.quantity;
      for (const candidate of candidates.slice(0, input.maxSourcesPerLine)) {
        if (open === 0) break;
        const quantity = Math.min(open, candidate.usable);
        lineAllocations.push({
          item_id: line.item_id,
          sku_id: line.sku_id,
          node_id: candidate.node.node_id,
          quantity,
          routing_reason:
            open === line.quantity
              ? `Earliest ETA (${km(candidate.distanceKm)} from site), usable ${candidate.usable}; line is split`
              : `Covers the remaining ${open} (${km(candidate.distanceKm)} from site), usable ${candidate.usable}`,
        });
        open -= quantity;
      }
    }

    const covered = lineAllocations.reduce((total, allocation) => total + allocation.quantity, 0);
    fulfillable += covered;
    for (const allocation of lineAllocations) {
      const key = `${allocation.node_id}:${allocation.sku_id}`;
      left.set(key, (left.get(key) ?? 0) - allocation.quantity);
    }
    if (covered < line.quantity) {
      shortages.push({ item_id: line.item_id, sku_id: line.sku_id, requested: line.quantity, fulfillable: covered });
    }
    allocations.push(...lineAllocations);
  }

  return shortages.length
    ? { status: 'SHORTAGE', allocations: [], fulfillable_qty: fulfillable, shortages }
    : { status: 'OK', allocations, fulfillable_qty: fulfillable, shortages: [] };
}
