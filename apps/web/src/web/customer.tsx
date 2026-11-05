import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { formatSek, formatTime, orderTone, statusText, stockholmInputToIso, stockholmNoonInput } from '../shared/format';
import { Alert, Badge, Card, Empty, Kpi, Loading, PageHead } from '../shared/ui';
import { api, ApiError, explainError, type Confirmation, type OrderDetail, type OrderSummary, type Product, type Site, type Store } from './api';
import { SystemBanner } from './Layout';
import { clearOrderKey, idempotencyKeyFor, type OrderBody } from './orderDraft';
import { useLiveData, useSession } from './session';

const OPEN = ['AWAITING_APPROVAL', 'APPROVED', 'DISPATCHING', 'DISPATCHED'];
const CATEGORY_LABEL: Record<string, string> = {
  cement: 'Cement',
  timber: 'Timber',
  gypsum_board: 'Gypsum board',
  insulation: 'Insulation',
  other: 'Other',
};

function AvailabilityBadge({ value }: { value: Product['availability'] }) {
  if (value === 'AVAILABLE') return <Badge tone="ok">Available</Badge>;
  if (value === 'UNAVAILABLE') return <Badge tone="danger">Out of stock</Badge>;
  return <Badge tone="warn">Cannot confirm</Badge>;
}

export function OrderStatus({ status }: { status: string }) {
  return <Badge tone={orderTone(status)}>{statusText(status)}</Badge>;
}

export function OrdersTable({ orders, base }: { orders: OrderSummary[]; base: string }) {
  const navigate = useNavigate();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Status</th>
            <th>Requested</th>
            <th>Estimated delivery</th>
            <th>Placed</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.order_id} className="clickable" onClick={() => navigate(`${base}/${order.order_id}`)}>
              <td className="nowrap">
                <Link to={`${base}/${order.order_id}`}>{order.order_id}</Link>
              </td>
              <td>
                <OrderStatus status={order.status} /> {order.at_risk && <Badge tone="danger">At risk</Badge>}
              </td>
              <td className="nowrap">{formatTime(order.requested_delivery_at)}</td>
              <td className="nowrap">{formatTime(order.eta)}</td>
              <td className="nowrap muted">{formatTime(order.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CustomerHome() {
  const orders = useLiveData(() => api<OrderSummary[]>('/orders'));
  const products = useLiveData(() => api<Product[]>('/products'), [], 30000);
  const sites = useLiveData(() => api<Site[]>('/sites'), [], 60000);
  const list = orders.data ?? [];
  const atRisk = list.filter((order) => order.at_risk && OPEN.includes(order.status));
  const review = list.filter((order) => order.status === 'NEEDS_REVIEW');
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const product of products.data ?? []) {
      const key = product.category ?? 'other';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [products.data]);
  return (
    <div className="stack">
      <PageHead
        title="Overview"
        subtitle="Your orders and what can be supplied right now"
        actions={
          <Link className="btn" to="/customer/catalog">
            Place an order
          </Link>
        }
      />
      <SystemBanner audience="customer" />
      {atRisk.map((order) => (
        <Alert key={order.order_id} tone="warn" title={`${order.order_id} may arrive late`}>
          Estimated {formatTime(order.eta)}, you asked for {formatTime(order.requested_delivery_at)}.{' '}
          <Link to={`/customer/orders/${order.order_id}`}>See the order</Link>
        </Alert>
      ))}
      <div className="kpis">
        <Kpi label="Orders in progress" value={list.filter((order) => OPEN.includes(order.status)).length} />
        <Kpi label="At risk of being late" value={atRisk.length} {...(atRisk.length ? { tone: 'warn' as const } : {})} />
        <Kpi label="Need review" value={review.length} {...(review.length ? { tone: 'warn' as const } : {})} />
        <Kpi label="Delivered" value={list.filter((order) => order.status === 'DELIVERED').length} />
      </div>
      <div className="grid grid-side">
        <Card title="Recent orders">
          {orders.loading && !orders.data ? (
            <Loading />
          ) : list.length ? (
            <OrdersTable orders={list.slice(0, 6)} base="/customer/orders" />
          ) : (
            <Empty>No orders yet. Place your first one from the catalog.</Empty>
          )}
        </Card>
        <div className="stack">
          <Card title="Construction sites">
            <div className="card-body stack small">
              {(sites.data ?? []).map((site) => (
                <div key={site.site_id}>
                  <strong>{site.site_id}</strong>
                  <div className="muted">{site.address}</div>
                </div>
              ))}
              {sites.loading && !sites.data && <Loading />}
            </div>
          </Card>
          <Card title="Catalog">
            <div className="card-body row small">
              {categories.map(([category, count]) => (
                <Badge key={category} tone="info">
                  {CATEGORY_LABEL[category] ?? category}: {count}
                </Badge>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

type Cart = Record<string, number>;

function readCart(): Cart {
  try {
    return JSON.parse(sessionStorage.getItem('onsite.cart') ?? '{}') as Cart;
  } catch {
    return {};
  }
}

export function CatalogPage() {
  const navigate = useNavigate();
  const products = useLiveData(() => api<Product[]>('/products'), [], 30000);
  const stores = useLiveData(() => api<Store[]>('/stores'), [], 60000);
  const sites = useLiveData(() => api<Site[]>('/sites'), [], 60000);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [cart, setCart] = useState<Cart>(readCart);
  const [salesStore, setSalesStore] = useState('');
  const [site, setSite] = useState('');
  const [requested, setRequested] = useState(() => stockholmNoonInput(2));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sessionStorage.setItem('onsite.cart', JSON.stringify(cart));
  }, [cart]);
  useEffect(() => {
    if (!salesStore && stores.data) setSalesStore(stores.data.find((store) => store.store_id === 'SE-STORE-B')?.store_id ?? stores.data[0]?.store_id ?? '');
  }, [stores.data, salesStore]);
  useEffect(() => {
    if (!site && sites.data?.[0]) setSite(sites.data[0].site_id);
  }, [sites.data, site]);

  const all = products.data ?? [];
  const shown = all.filter(
    (product) =>
      (!category || product.category === category) &&
      (!search || `${product.name} ${product.sku_id}`.toLowerCase().includes(search.toLowerCase())),
  );
  const lines = Object.entries(cart)
    .filter(([, quantity]) => quantity > 0)
    .map(([sku, quantity]) => ({ product: all.find((candidate) => candidate.sku_id === sku), quantity, sku }))
    .filter((line): line is { product: Product; quantity: number; sku: string } => Boolean(line.product));
  const total = lines.reduce((sum, line) => sum + line.product.unit_price_sek * line.quantity, 0);
  const requestedIsValid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(requested);
  const canSubmit = lines.length > 0 && salesStore && site && requestedIsValid && !submitting;

  const setQuantity = (sku: string, value: string) => {
    const quantity = Math.max(0, Math.floor(Number(value) || 0));
    setCart((current) => {
      const next = { ...current };
      if (quantity > 0) next[sku] = quantity;
      else delete next[sku];
      return next;
    });
  };

  const submit = async () => {
    const body: OrderBody = {
      sales_store_id: salesStore,
      site_id: site,
      requested_delivery_at: stockholmInputToIso(requested),
      items: lines.map((line) => ({ sku_id: line.sku, quantity: line.quantity, unit: line.product.base_unit ?? '' })),
    };
    setSubmitting(true);
    setError(null);
    try {
      const order = await api<OrderDetail>('/orders', {
        method: 'POST',
        body,
        headers: { 'idempotency-key': idempotencyKeyFor(body) },
      });
      clearOrderKey();
      // Written here as well: the effect that saves the cart would not run after navigating away.
      sessionStorage.setItem('onsite.cart', '{}');
      setCart({});
      navigate(`/customer/orders/${order.order_id}?new=1`);
    } catch (failure) {
      // A refusal is final for this order. A lost connection keeps the key, so trying again cannot duplicate it.
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && failure.code !== 'IDEMPOTENCY_IN_PROGRESS') {
        clearOrderKey();
      }
      setError(explainError(failure));
      setSubmitting(false);
    }
  };

  return (
    <div className="stack">
      <PageHead title="Catalog & order" subtitle="Only approved products can be ordered. Prices are simulated." />
      <SystemBanner audience="customer" />
      <div className="grid grid-side">
        <Card
          title={
            <div className="row">
              <input aria-label="Search products" placeholder="Search name or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
              <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">All categories</option>
                {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          }
          actions={all[0]?.inventory_as_of ? <span className="small muted">Stock verified {formatTime(all[0].inventory_as_of)}</span> : undefined}
        >
          {products.loading && !products.data ? (
            <Loading what="Loading products" />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Category</th>
                    <th>Supply</th>
                    <th className="num">Price</th>
                    <th className="num">Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((product) => (
                    <tr key={product.sku_id}>
                      <td>
                        {product.name}
                        <div className="small muted mono">{product.sku_id}</div>
                      </td>
                      <td className="small">{CATEGORY_LABEL[product.category ?? ''] ?? product.category}</td>
                      <td>
                        <AvailabilityBadge value={product.availability} />
                      </td>
                      <td className="num nowrap">
                        {formatSek(product.unit_price_sek)}
                        <div className="small muted">per {product.base_unit}</div>
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          min={0}
                          aria-label={`Quantity of ${product.name}`}
                          value={cart[product.sku_id] ?? ''}
                          placeholder="0"
                          onChange={(e) => setQuantity(product.sku_id, e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                  {!shown.length && (
                    <tr>
                      <td colSpan={5}>
                        <Empty>No products match.</Empty>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Your order">
          <div className="card-body stack">
            {lines.length ? (
              <div className="stack small">
                {lines.map((line) => (
                  <div key={line.sku} className="spread">
                    <span>
                      {line.quantity} {line.product.base_unit} × {line.product.name}
                    </span>
                    <button type="button" className="btn small" onClick={() => setQuantity(line.sku, '0')} aria-label={`Remove ${line.product.name}`}>
                      Remove
                    </button>
                  </div>
                ))}
                <div className="spread">
                  <strong>Simulated total</strong>
                  <strong>{formatSek(total)}</strong>
                </div>
              </div>
            ) : (
              <p className="muted small">Enter a quantity to add a product.</p>
            )}
            <label className="field">
              Sales store
              <select value={salesStore} onChange={(e) => setSalesStore(e.target.value)}>
                {(stores.data ?? []).filter((store) => store.type === 'STORE').map((store) => (
                  <option key={store.store_id} value={store.store_id}>
                    {store.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Construction site
              <select value={site} onChange={(e) => setSite(e.target.value)}>
                {(sites.data ?? []).map((option) => (
                  <option key={option.site_id} value={option.site_id}>
                    {option.address}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Requested delivery (Swedish time)
              <input type="datetime-local" value={requested} onChange={(e) => setRequested(e.target.value)} />
            </label>
            {error && <Alert tone="danger">{error}</Alert>}
            <button type="button" className="btn primary" disabled={!canSubmit} onClick={() => void submit()}>
              {submitting ? 'Checking stock and reserving…' : 'Place order'}
            </button>
            <p className="small muted">Stock is checked and reserved as you order. Nothing is promised until each shipping node approves.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

export function CustomerOrders() {
  const orders = useLiveData(() => api<OrderSummary[]>('/orders'));
  return (
    <div className="stack">
      <PageHead title="My orders" subtitle="Status updates here by itself" />
      <Card>
        {orders.loading && !orders.data ? (
          <Loading />
        ) : orders.data?.length ? (
          <OrdersTable orders={orders.data} base="/customer/orders" />
        ) : (
          <Empty>No orders yet.</Empty>
        )}
        {Boolean(orders.error) && <div className="card-body"><Alert tone="danger">{explainError(orders.error)}</Alert></div>}
      </Card>
    </div>
  );
}

const PROGRESS = ['SUBMITTED', 'ALLOCATING', 'AWAITING_APPROVAL', 'APPROVED', 'DISPATCHING', 'DISPATCHED', 'DELIVERED'];

export function OrderProgress({ status }: { status: string }) {
  const index = PROGRESS.indexOf(status);
  if (index < 0) return null;
  return (
    <div className="steps" aria-label="Order progress">
      {PROGRESS.map((step, position) => (
        <div key={step} className={`step ${position < index || status === 'DELIVERED' ? 'done' : position === index ? 'current' : ''}`}>
          {statusText(step)}
        </div>
      ))}
    </div>
  );
}

const REVIEW_TEXT: Record<string, string> = {
  INSUFFICIENT_STOCK: 'There is not enough usable stock. This was detected as you ordered, not at loading time.',
  SOURCE_UNAVAILABLE: 'The source system could not be reached, so no stock could be promised.',
  INVENTORY_STALE: 'Stock could not be verified, so nothing was promised.',
  RESERVATION_CONFLICT: 'Others reserved this stock at the same moment, and a new attempt did not succeed.',
  ALLOCATION_INTERRUPTED: 'Processing was interrupted, so nothing is being held for this order.',
};

function eventText(type: string): string {
  return statusText(type.replace('order.', '').replace('task.', 'task ').replaceAll('.', ' '));
}

export function SplitBar({ order }: { order: OrderDetail }) {
  const requested = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const allocations = order.allocations;
  if (!requested) return null;
  const covered = allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
  return (
    <div className="split-bar" role="img" aria-label={allocations.map((a) => `${a.quantity} from ${a.node_id}`).join(', ')}>
      {allocations.map((allocation, index) => (
        <div key={`${allocation.node_id}-${allocation.sku_id}-${index}`} className={`s${index % 3}`} style={{ flex: allocation.quantity }}>
          {allocation.quantity} · {allocation.node_id.replace('SE-', '')}
        </div>
      ))}
      {covered < requested && (
        <div className="short" style={{ flex: requested - covered }}>
          {requested - covered} short
        </div>
      )}
    </div>
  );
}

function ShortageCard({ order }: { order: OrderDetail }) {
  const requested = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const fulfillable = order.fulfillable_qty;
  return (
    <Alert tone="warn" title="This order was not confirmed">
      <p>{order.review_reason ? (REVIEW_TEXT[order.review_reason] ?? order.review_reason) : ''}</p>
      {fulfillable !== null && (
        <p>
          You asked for <strong style={{ display: 'inline' }}>{requested}</strong>. At most{' '}
          <strong style={{ display: 'inline' }}>{fulfillable}</strong> can be supplied now, which is {requested - fulfillable} short.
        </p>
      )}
      <p>Nothing is being held for this order. To go ahead, cancel it and place a new order for a quantity that can be supplied.</p>
    </Alert>
  );
}

export function OrderDetailView({ orderId, canCancel }: { orderId: string; canCancel: (order: OrderDetail) => boolean }) {
  const order = useLiveData(() => api<OrderDetail>(`/orders/${orderId}`), [orderId]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const data = order.data;
  if (order.loading && !data) return <Loading what="Loading the order" />;
  if (!data) return <Alert tone="danger" title="This order could not be loaded">{explainError(order.error)}</Alert>;

  const cancel = async () => {
    if (!window.confirm(`Cancel ${data.order_id}? All reserved stock will be released.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/orders/${data.order_id}/cancel`, { method: 'POST', body: { version: data.version } });
    } catch (failure) {
      setError(explainError(failure));
    }
    await order.reload();
    setBusy(false);
  };
  const showConfirmation = async () => {
    setError(null);
    try {
      setConfirmation(await api<Confirmation>(`/orders/${data.order_id}/confirmation`));
    } catch (failure) {
      setError(explainError(failure));
    }
  };

  const confirmable = ['APPROVED', 'DISPATCHING', 'DISPATCHED', 'DELIVERED'].includes(data.status);
  return (
    <div className="stack">
      <PageHead
        title={data.order_id}
        subtitle={<OrderStatus status={data.status} />}
        actions={
          <>
            {confirmable && (
              <button type="button" className="btn" onClick={() => void showConfirmation()}>
                Order confirmation
              </button>
            )}
            {canCancel(data) && (
              <button type="button" className="btn danger" disabled={busy} onClick={() => void cancel()}>
                Cancel order
              </button>
            )}
          </>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <OrderProgress status={data.status} />
      {data.status === 'NEEDS_REVIEW' && <ShortageCard order={data} />}
      {data.at_risk && (
        <Alert tone="warn" title="This delivery may be late">
          {data.at_risk_reason ?? 'The estimate is later than the time you asked for.'}
        </Alert>
      )}
      {data.status === 'AWAITING_APPROVAL' && (
        <Alert tone="info" title="Stock is reserved. Waiting for each shipping node to approve.">
          Reservation held until {formatTime(data.reservation_expires_at)}. If approval does not arrive by then, the stock is released and the order expires.
        </Alert>
      )}
      {data.status === 'DELIVERED' && (
        <Alert tone={data.otif ? 'ok' : 'warn'} title={data.otif ? 'Delivered on time and in full' : 'Delivered, but late or short'}>
          Delivered {formatTime(data.delivered_at)}.
        </Alert>
      )}
      {data.shipments.some((shipment) => shipment.reservation_health === 'LOST') && (
        <Alert tone="danger" title="Part of this order needs manual follow-up">
          The source system no longer holds stock for one shipment, so it cannot be dispatched automatically.
        </Alert>
      )}

      <div className="kpis">
        <Kpi label="You asked for delivery" value={<span style={{ fontSize: '1.05rem' }}>{formatTime(data.requested_delivery_at)}</span>} />
        <Kpi label="Estimated delivery" value={<span style={{ fontSize: '1.05rem' }}>{formatTime(data.eta)}</span>} hint="An estimate from simulated parameters" {...(data.at_risk ? { tone: 'warn' as const } : {})} />
        <Kpi label="Stock verified" value={<span style={{ fontSize: '1.05rem' }}>{formatTime(data.inventory_as_of)}</span>} />
      </div>

      <div className="grid grid-side">
        <div className="stack">
          {data.allocations.length > 0 && (
            <Card title="Where it ships from">
              <div className="card-body stack">
                <SplitBar order={data} />
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Shipping node</th>
                        <th>SKU</th>
                        <th className="num">Quantity</th>
                        <th>Why this node</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.allocations.map((allocation, index) => (
                        <tr key={`${allocation.node_id}-${allocation.sku_id}-${index}`}>
                          <td className="nowrap">{allocation.node_id}</td>
                          <td className="mono nowrap">{allocation.sku_id}</td>
                          <td className="num">{allocation.quantity}</td>
                          <td className="small">{allocation.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </Card>
          )}
          {data.shipments.length > 0 && (
            <Card title="Delivery batches">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>From</th>
                      <th>Status</th>
                      <th>Vehicle slot</th>
                      <th>Estimate</th>
                      <th className="num">Delivered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.shipments.map((shipment) => (
                      <tr key={shipment.task_id}>
                        <td className="nowrap">{shipment.node_id}</td>
                        <td>
                          <OrderStatus status={shipment.status} /> {shipment.is_short && <Badge tone="danger">Short</Badge>}
                        </td>
                        <td className="nowrap">{formatTime(shipment.dispatch_slot)}</td>
                        <td className="nowrap">
                          {formatTime(shipment.eta)} {shipment.eta_inputs?.provisional && <Badge>Provisional</Badge>}
                        </td>
                        <td className="num">{shipment.delivered_qty ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <Card title="Items">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th className="num">Quantity</th>
                    <th className="num">Unit price (simulated)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.sku_id}>
                      <td className="mono">{item.sku_id}</td>
                      <td className="num">
                        {item.quantity} {item.unit}
                      </td>
                      <td className="num">{formatSek(item.unit_price_sek)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        <Card title="History">
          <div className="card-body">
            <ol className="timeline">
              {[...data.events].reverse().map((event) => (
                <li key={`${event.version}-${event.type}`}>
                  <time>{formatTime(event.occurred_at)}</time>
                  <span>
                    {eventText(event.type)}
                    {event.actor && event.actor !== 'system' ? <span className="muted"> · {event.actor}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </Card>
      </div>
      {confirmation && <ConfirmationView document={confirmation} onClose={() => setConfirmation(null)} />}
    </div>
  );
}

export function NotATaxInvoice() {
  return <div className="doc-banner">Not a tax invoice. Prices are simulated. Tax invoices come from the accounting system.</div>;
}

function ConfirmationView({ document, onClose }: { document: Confirmation; onClose: () => void }) {
  return (
    <Card title={`Order confirmation ${document.order_id}`} actions={<button type="button" className="btn small no-print" onClick={onClose}>Close</button>}>
      <div className="card-body stack">
        <NotATaxInvoice />
        <div className="small">
          <div>
            <strong>{document.customer_company}</strong> · delivery to {document.site_address}
          </div>
          <div className="muted">
            Sales store {document.sales_store.name}. Requested {formatTime(document.requested_delivery_at)}. Estimated {formatTime(document.eta)}.
          </div>
        </div>
        {document.shipments.map((shipment) => (
          <div key={shipment.task_id}>
            <h3>
              From {shipment.shipping_node.name} · estimated {formatTime(shipment.eta)}
            </h3>
            <div className="table-wrap">
              <table>
                <tbody>
                  {shipment.lines.map((line) => (
                    <tr key={line.sku_id}>
                      <td>{line.name}</td>
                      <td className="num">
                        {line.quantity} {line.unit}
                      </td>
                      <td className="num">{formatSek(line.line_total_sek)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

const CUSTOMER_CANCELLABLE = ['SUBMITTED', 'ALLOCATING', 'AWAITING_APPROVAL', 'NEEDS_REVIEW', 'NEEDS_REALLOCATION'];

export function CustomerOrderPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { session } = useSession();
  return (
    <div className="stack">
      <div className="no-print">
        <Link to="/customer/orders">← My orders</Link>
      </div>
      {params.get('new') && <Alert tone="info">Order received. This is what the system has actually confirmed so far.</Alert>}
      <OrderDetailView orderId={id} canCancel={(order) => session?.role === 'customer' && CUSTOMER_CANCELLABLE.includes(order.status)} />
    </div>
  );
}
