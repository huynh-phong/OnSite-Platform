import type pg from 'pg';
import type { Config } from '../../config.js';
import type { Db } from '../../db.js';
import { inTx, type Tx } from '../../tx.js';
import { bumpCounter, COUNTERS } from '../metrics/counters.js';
import type { NotificationHub } from '../notifications/hub.js';
import { changeOrder, listOpenOrderIds, lockOrder, type Order } from '../orders/orders.repository.js';
import { computeShipmentEta, summarizeOrderEta } from './eta.js';

interface EtaTask {
  task_id: string;
  node_id: string;
  status: string;
  approved_at: Date | null;
  dispatched_at: Date | null;
  prep_minutes: number;
  node_lat: number;
  node_lng: number;
  site_lat: number;
  site_lng: number;
  stored_eta: Date | null;
}

async function listEtaTasks(client: pg.PoolClient, orderId: string): Promise<EtaTask[]> {
  const { rows } = await client.query<EtaTask>(
    `SELECT t.task_id, t.node_id, t.status, t.approved_at, t.dispatched_at, st.prep_minutes,
            st.lat AS node_lat, st.lng AS node_lng, si.lat AS site_lat, si.lng AS site_lng, sh.eta AS stored_eta
       FROM fulfilment_tasks t
       JOIN stores st ON st.store_id = t.node_id
       JOIN orders o ON o.order_id = t.order_id
       JOIN sites si ON si.site_id = o.site_id
       JOIN shipments sh ON sh.task_id = t.task_id
      WHERE t.order_id = $1 AND t.status IN ('PENDING_APPROVAL', 'APPROVED', 'DISPATCHED', 'DELIVERED')`,
    [orderId],
  );
  return rows;
}

function swedishTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export class EtaService {
  constructor(
    private readonly pool: Db,
    private readonly hub: NotificationHub,
    private readonly config: Config,
  ) {}

  /**
   * Recalculates every shipment and the order. An ETA change is written to history rather than silently
   * overwritten, and a move to at-risk also alerts the customer and the shipping nodes.
   */
  async refresh(tx: Tx, order: Order, now = new Date()): Promise<Order> {
    const tasks = await listEtaTasks(tx.client, order.order_id);
    const shipments: { eta: Date; node_id: string }[] = [];
    for (const task of tasks) {
      if (task.status === 'DELIVERED') {
        if (task.stored_eta) shipments.push({ eta: task.stored_eta, node_id: task.node_id });
        continue;
      }
      const eta = computeShipmentEta(
        {
          approvedAt: task.approved_at ?? now,
          dispatchedAt: task.dispatched_at,
          provisional: !task.approved_at,
          prepMinutes: task.prep_minutes,
          node: { lat: task.node_lat, lng: task.node_lng },
          site: { lat: task.site_lat, lng: task.site_lng },
        },
        this.config.eta,
      );
      await tx.client.query(
        `UPDATE shipments SET dispatch_slot = $2, eta = $3, eta_inputs = $4, updated_at = now() WHERE task_id = $1`,
        [task.task_id, eta.dispatchAt, eta.eta, JSON.stringify(eta.inputs)],
      );
      shipments.push({ eta: eta.eta, node_id: task.node_id });
    }

    const { eta, atRisk } = summarizeOrderEta(shipments, order.requested_delivery_at);
    const etaChanged = (eta?.getTime() ?? null) !== (order.eta?.getTime() ?? null);
    if (!etaChanged && atRisk === order.at_risk) return order;

    const latest = shipments.reduce<{ eta: Date; node_id: string } | undefined>(
      (found, shipment) => (!found || shipment.eta > found.eta ? shipment : found),
      undefined,
    );
    const reason =
      atRisk && latest
        ? `The shipment from ${latest.node_id} is estimated at ${swedishTime(latest.eta, this.config.eta.timeZone)} Swedish time, after the requested time`
        : null;
    const type = atRisk === order.at_risk ? 'order.eta_changed' : atRisk ? 'order.at_risk' : 'order.at_risk_cleared';
    const updated = await changeOrder(
      tx,
      order,
      { eta, at_risk: atRisk, at_risk_reason: reason },
      { type, actor: 'system', data: { eta: eta?.toISOString() ?? null, reason } },
      this.config.countryCode,
    );
    if (atRisk && !order.at_risk) {
      await bumpCounter(tx.client, COUNTERS.atRiskAlerts);
      tx.notify({
        type: 'order.at_risk',
        scope: { customerId: order.customer_id, nodeIds: tasks.map((task) => task.node_id) },
        data: { order_id: order.order_id, eta: eta?.toISOString() ?? null, version: updated.version },
      });
    }
    return updated;
  }

  /** Worker: re-evaluates open orders, because time passing alone can make one late. */
  async tick(): Promise<void> {
    for (const orderId of await listOpenOrderIds(this.pool)) {
      await inTx(this.pool, this.hub, async (tx) => {
        await this.refresh(tx, await lockOrder(tx.client, orderId));
      });
    }
  }
}
