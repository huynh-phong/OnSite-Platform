import type { Principal } from '../../auth.js';
import type { Config } from '../../config.js';
import type { Db } from '../../db.js';
import { AppError } from '../../errors.js';
import * as catalog from '../catalog/catalog.repository.js';
import { decryptAddress } from '../catalog/catalog.service.js';
import * as orders from '../orders/orders.repository.js';
import type { OrdersService } from '../orders/orders.service.js';

const CONFIRMABLE = ['APPROVED', 'DISPATCHING', 'DISPATCHED', 'DELIVERED'];

export class DocumentsService {
  constructor(
    private readonly pool: Db,
    private readonly config: Config,
    private readonly ordersService: OrdersService,
  ) {}

  private async taskDocument(task: orders.Task, order: orders.Order) {
    const [items, allocations, shipments, stores, products] = await Promise.all([
      orders.listItems(this.pool, order.order_id),
      orders.listAllocations(this.pool, order.order_id),
      orders.listShipments(this.pool, order.order_id),
      catalog.listStores(this.pool),
      catalog.getProducts(this.pool, (await orders.listItems(this.pool, order.order_id)).map((item) => item.sku_id)),
    ]);
    const shipment = shipments.find((candidate) => candidate.task_id === task.task_id);
    return {
      task_id: task.task_id,
      shipping_node: { node_id: task.node_id, name: stores.find((store) => store.store_id === task.node_id)?.name ?? null },
      status: task.status,
      eta: shipment?.eta?.toISOString() ?? null,
      approver: task.approved_by,
      approved_at: task.approved_at?.toISOString() ?? null,
      lines: allocations
        .filter((allocation) => allocation.task_id === task.task_id)
        .map((allocation) => {
          const item = items.find((candidate) => candidate.item_id === allocation.item_id)!;
          const unitPrice = Number(item.unit_price);
          return {
            sku_id: item.sku_id,
            name: products.find((product) => product.sku_id === item.sku_id)?.name ?? item.sku_id,
            quantity: allocation.quantity,
            unit: item.unit,
            unit_price_sek: unitPrice,
            line_total_sek: Math.round(unitPrice * allocation.quantity * 100) / 100,
          };
        }),
    };
  }

  private async header(order: orders.Order) {
    const [site, company, store] = await Promise.all([
      catalog.getSite(this.pool, order.site_id),
      catalog.getCustomerName(this.pool, order.customer_id),
      catalog.getStore(this.pool, order.sales_store_id),
    ]);
    return {
      not_a_tax_invoice: true as const,
      prices_are_simulated: true as const,
      order_id: order.order_id,
      customer_company: company ?? null,
      sales_store: { store_id: order.sales_store_id, name: store?.name ?? null },
      site_id: order.site_id,
      site_address: site ? decryptAddress(site, this.config) : null,
      requested_delivery_at: order.requested_delivery_at.toISOString(),
      order_status: order.status,
      eta: order.eta?.toISOString() ?? null,
      eta_is_estimate: true as const,
    };
  }

  async pickingList(taskId: string, principal: Principal) {
    const task = await orders.getTask(this.pool, taskId);
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found');
    if (principal.role === 'staff' && principal.store_id !== task.node_id) {
      throw new AppError(403, 'FORBIDDEN', 'This task belongs to another node');
    }
    const order = (await orders.getOrder(this.pool, task.order_id))!;
    return { document_type: 'picking_list' as const, ...(await this.header(order)), ...(await this.taskDocument(task, order)) };
  }

  async orderConfirmation(orderId: string, principal: Principal) {
    const order = await orders.getOrder(this.pool, orderId);
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    await this.ordersService.assertCanRead(principal, order);
    if (!CONFIRMABLE.includes(order.status)) {
      throw new AppError(409, 'ORDER_NOT_APPROVED', `There is no confirmation for an order that is ${order.status}`);
    }
    const tasks = (await orders.listTasks(this.pool, orderId)).filter((task) =>
      ['APPROVED', 'DISPATCHED', 'DELIVERED'].includes(task.status),
    );
    return {
      document_type: 'order_confirmation' as const,
      ...(await this.header(order)),
      shipments: await Promise.all(tasks.map((task) => this.taskDocument(task, order))),
    };
  }
}
