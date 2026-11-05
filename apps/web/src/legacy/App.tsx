import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { formatSek, formatTime } from '../shared/format';
import { DashboardError, sessionFetch } from '../shared/http';
import { Alert, Badge, Card, Empty, Kpi, Loading, PageHead, type Tone } from '../shared/ui';

interface Store { store_id: string; name: string; type: 'STORE' | 'HUB'; status: string }
interface StockRow { node_id: string; sku_id: string; on_hand: number; reserved: number; source_unit: string; version: number; updated_at: string }
interface Product { sku_id: string; name: string; source_unit: string; source_category: string; source_description: string; unit_price_sek: number; updated_at: string }
interface LedgerRow { entry_id: number; node_id: string; sku_id: string; type: string; qty: number; reference: string | null; occurred_at: string }
interface Connection { state: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED'; last_poll_at: string | null; onsite_process_reachable: boolean }

const CONNECTION: Record<Connection['state'], { tone: Tone; text: string; detail: string }> = {
  DISCONNECTED: { tone: 'neutral', text: 'Disconnected', detail: 'Nothing is reading this system. It carries on working regardless.' },
  CONNECTING: { tone: 'info', text: 'Connecting', detail: 'OnSite was asked to connect. Waiting for its first read.' },
  CONNECTED: { tone: 'ok', text: 'Connected', detail: 'OnSite is reading the change feed through the API.' },
  DEGRADED: { tone: 'warn', text: 'Degraded', detail: 'OnSite is trying to read, but the API is in simulated outage.' },
};

type Tab = 'overview' | 'manual' | 'catalog' | 'ledger' | 'tools';

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await sessionFetch('/ui-api/login', { method: 'POST', body: { password } });
      onDone();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return (
    <div className="center-card">
      <section className="card">
        <form className="card-body stack" onSubmit={(event) => void submit(event)}>
          <div>
            <h1>Sweden Legacy Systems</h1>
            <p className="muted">Simulated ERP/WMS. Runs on its own, with or without OnSite.</p>
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          <label className="field">
            Dashboard password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
          </label>
          <button className="btn primary" type="submit">Log in</button>
        </form>
      </section>
    </div>
  );
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [stores, setStores] = useState<Store[]>([]);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [outage, setOutage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextStores, nextStock, nextProducts, nextConnection, nextOutage] = await Promise.all([
        sessionFetch<Store[]>('/ui-api/stores'),
        sessionFetch<{ items: StockRow[] }>('/ui-api/inventory'),
        sessionFetch<{ items: Product[] }>('/ui-api/products'),
        sessionFetch<Connection>('/ui-api/connection'),
        sessionFetch<{ enabled: boolean }>('/ui-api/outage'),
      ]);
      setStores(nextStores);
      setStock(nextStock.items);
      setProducts(nextProducts.items);
      setConnection(nextConnection);
      setOutage(nextOutage.enabled);
      setError(null);
    } catch (failure) {
      if (failure instanceof DashboardError && failure.status === 401) setAuthed(false);
      else setError((failure as Error).message);
    }
  }, []);

  useEffect(() => {
    sessionFetch<{ authenticated: boolean }>('/ui-api/me')
      .then((me) => setAuthed(me.authenticated))
      .catch(() => setAuthed(false));
  }, []);
  useEffect(() => {
    if (!authed) return undefined;
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [authed, load]);

  if (authed === null) return <Loading />;
  if (!authed) return <div className="shell theme-legacy"><Login onDone={() => setAuthed(true)} /></div>;

  const tabs: [Tab, string][] = [
    ['overview', 'Stores & stock'],
    ['manual', 'Manual process'],
    ['catalog', 'Product catalog'],
    ['ledger', 'Stock ledger'],
    ['tools', 'Demo tools'],
  ];
  const state = connection ? CONNECTION[connection.state] : null;
  return (
    <div className="shell theme-legacy">
      <header className="topbar">
        <span className="brand">Sweden Legacy Systems<small>Simulated ERP/WMS</small></span>
        <nav className="nav" aria-label="Main">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" className={`link ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>
        <div className="userbox">
          <button
            type="button"
            onClick={() => void sessionFetch('/ui-api/logout', { method: 'POST' }).then(() => setAuthed(false))}
          >
            Log out
          </button>
        </div>
      </header>
      <main className="main stack">
        {error && <Alert tone="danger" title="Could not refresh">{error}</Alert>}
        {outage && (
          <Alert tone="danger" title="Simulated API outage is on">
            Outside systems get 503 from this system's API. Its own screens keep working, as a real ERP's would.
          </Alert>
        )}
        <Card>
          <div className="card-body spread">
            <div>
              <span className="small muted">OnSite connection, as seen from here</span>
              <div className="row">
                {state && <Badge tone={state.tone}>{state.text}</Badge>}
                <span className="small">{state?.detail}</span>
              </div>
            </div>
            <span className="small muted">Last read by OnSite: {formatTime(connection?.last_poll_at)}</span>
          </div>
        </Card>
        {tab === 'overview' && <Overview stores={stores} stock={stock} products={products} />}
        {tab === 'manual' && <ManualProcess stores={stores} stock={stock} products={products} />}
        {tab === 'catalog' && <Catalog products={products} />}
        {tab === 'ledger' && <Ledger stores={stores} />}
        {tab === 'tools' && <Tools stores={stores} products={products} outage={outage} connection={connection} reload={load} />}
      </main>
    </div>
  );
}

function Overview({ stores, stock, products }: { stores: Store[]; stock: StockRow[]; products: Product[] }) {
  const [selected, setSelected] = useState('SE-STORE-B');
  const names = useMemo(() => new Map(products.map((product) => [product.sku_id, product.name])), [products]);
  const rows = stock.filter((row) => row.node_id === selected);
  return (
    <>
      <PageHead title="Stores and hub" subtitle="Each location has its own stock records. There is no combined view, so you open them one at a time." />
      <div className="kpis">
        <Kpi label="Stores" value={stores.filter((store) => store.type === 'STORE').length} />
        <Kpi label="Hubs" value={stores.filter((store) => store.type === 'HUB').length} />
        <Kpi label="Products" value={products.length} />
        <Kpi label="Stock records" value={stock.length} />
      </div>
      <div className="store-grid">
        {stores.map((store) => (
          <button key={store.store_id} type="button" className={`store-tile ${selected === store.store_id ? 'selected' : ''}`} onClick={() => setSelected(store.store_id)}>
            <strong>{store.name}</strong>
            <div className="small muted">{store.store_id} {store.type === 'HUB' && <Badge tone="info">Hub</Badge>}</div>
          </button>
        ))}
      </div>
      <Card title={`Stock at ${stores.find((store) => store.store_id === selected)?.name ?? selected}`}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>SKU</th><th>Product</th><th>Unit in this system</th><th className="num">On hand</th><th className="num">Reserved</th><th>Last changed</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.sku_id}>
                  <td className="mono nowrap">{row.sku_id}</td>
                  <td>{names.get(row.sku_id) ?? ''}</td>
                  <td>{row.source_unit}</td>
                  <td className="num">{row.on_hand}</td>
                  <td className="num">{row.reserved}</td>
                  <td className="small nowrap muted">{formatTime(row.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

const MANUAL_STEPS = [
  'Check stock at each store, one system at a time',
  'Compare the possible sources',
  'Work out whether there is enough',
  'Phone the stores to coordinate who ships what',
  'Type the order details by hand for each shipping location',
  'Tell the customer when to expect delivery',
];

/** A walk-through using the stock that is really in the system. It deliberately claims no timings. */
function ManualProcess({ stores, stock, products }: { stores: Store[]; stock: StockRow[]; products: Product[] }) {
  const [sku, setSku] = useState('SE-CEM-025');
  const [quantity, setQuantity] = useState(100);
  const [step, setStep] = useState(0);
  const [checked, setChecked] = useState(0);
  const rows = stores.map((store) => ({ store, row: stock.find((candidate) => candidate.node_id === store.store_id && candidate.sku_id === sku) }));
  const seen = rows.slice(0, checked);
  const sources = seen.filter(({ row }) => row && row.on_hand - row.reserved > 0);
  const free = seen.reduce((sum, { row }) => sum + Math.max(0, (row?.on_hand ?? 0) - (row?.reserved ?? 0)), 0);
  const allChecked = checked >= rows.length && rows.length > 0;
  return (
    <>
      <PageHead title="How an order is handled without OnSite" subtitle="A guided illustration, using the stock currently in this system. It is not a measurement of anyone's real process, and makes no claim about time taken." />
      <Card title="A customer phones in an order">
        <div className="card-body row">
          <label className="field">Product
            <select value={sku} onChange={(e) => { setSku(e.target.value); setChecked(0); setStep(0); }}>
              {products.map((product) => <option key={product.sku_id} value={product.sku_id}>{product.name}</option>)}
            </select>
          </label>
          <label className="field">Quantity
            <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))} />
          </label>
        </div>
      </Card>
      <div className="steps">
        {MANUAL_STEPS.map((text, index) => (
          <div key={text} className={`step ${index < step ? 'done' : index === step ? 'current' : ''}`}>{index + 1}. {text}</div>
        ))}
      </div>
      {step === 0 && (
        <Card title="Step 1: open each location's records" actions={<Badge>{checked} of {rows.length} locations opened</Badge>}>
          <div className="card-body stack">
            <p className="small">There is no shared view. Open them one at a time.</p>
            <div className="row">
              <button type="button" className="btn primary" disabled={allChecked} onClick={() => setChecked((count) => count + 1)}>
                Open next location
              </button>
              <button type="button" className="btn" disabled={!allChecked} onClick={() => setStep(1)}>Next step</button>
            </div>
            <StockChecked rows={seen} />
          </div>
        </Card>
      )}
      {step === 1 && (
        <Card title="Step 2: compare the possible sources">
          <div className="card-body stack small">
            <p>{sources.length} of {rows.length} locations show this product. You still need to judge by hand which is closest to the site, and how much of the stock on hand is safe to promise, since none of these systems keeps a safety margin for you.</p>
            <StockChecked rows={sources} />
            <button type="button" className="btn primary" onClick={() => setStep(2)}>Next step</button>
          </div>
        </Card>
      )}
      {step === 2 && (
        <Card title="Step 3: is there enough?">
          <div className="card-body stack">
            <Kpi label="Free stock added up by hand (on hand minus reserved)" value={free} />
            {free >= quantity ? (
              <Alert tone="warn" title={`On paper there are enough for ${quantity}`}>
                But nothing stops someone else selling the same stock while you phone around, and this total includes stock a store may want to keep as a buffer. Any shortage might only show up at loading time.
              </Alert>
            ) : (
              <Alert tone="danger" title={`Short by ${quantity - free}`}>You would need to look for other options by phone.</Alert>
            )}
            <button type="button" className="btn primary" onClick={() => setStep(3)}>Next step</button>
          </div>
        </Card>
      )}
      {step >= 3 && (
        <Card title="Steps 4 to 6: the rest happens outside the system">
          <div className="card-body stack small">
            <ol className="checklist">
              <li>Phone each chosen store and hub, and ask them to set the stock aside. Nothing in the system records it.</li>
              <li>Type the order, quantities and site address by hand for each shipping location.</li>
              <li>Agree a delivery time with each location, and work out which is the latest.</li>
              <li>Call or email the customer. If something changes, the customer finds out when they call to ask.</li>
            </ol>
            <Alert tone="info">Compare: with OnSite these steps become one order, with an automatic split, reservations, tasks for each location, and an ETA.</Alert>
            <div><button type="button" className="btn" onClick={() => { setStep(0); setChecked(0); }}>Start again</button></div>
          </div>
        </Card>
      )}
    </>
  );
}

function StockChecked({ rows }: { rows: { store: Store; row: StockRow | undefined }[] }) {
  if (!rows.length) return null;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Location</th><th>Unit</th><th className="num">On hand</th><th className="num">Reserved</th></tr></thead>
        <tbody>
          {rows.map(({ store, row }) => (
            <tr key={store.store_id}>
              <td>{store.name}</td>
              <td>{row?.source_unit ?? '—'}</td>
              <td className="num">{row?.on_hand ?? 0}</td>
              <td className="num">{row?.reserved ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Catalog({ products }: { products: Product[] }) {
  return (
    <>
      <PageHead title="Product catalog" subtitle="Units and categories are free text, as each source system recorded them." />
      <Card>
        <div className="table-wrap">
          <table>
            <thead><tr><th>SKU</th><th>Description</th><th>Unit (raw)</th><th>Category (raw)</th><th className="num">Price</th></tr></thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.sku_id}>
                  <td className="mono nowrap">{product.sku_id}</td>
                  <td>{product.source_description}</td>
                  <td>{product.source_unit}</td>
                  <td>{product.source_category}</td>
                  <td className="num nowrap">{formatSek(product.unit_price_sek)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

const LEDGER_TONE: Record<string, Tone> = { INBOUND: 'ok', OUTBOUND: 'info', RESERVE: 'neutral', RELEASE: 'neutral', EXPIRE: 'warn' };

function Ledger({ stores }: { stores: Store[] }) {
  const [node, setNode] = useState('');
  const [hideOpening, setHideOpening] = useState(true);
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      sessionFetch<LedgerRow[]>(`/ui-api/transactions?limit=200${node ? `&node_id=${node}` : ''}`)
        .then((next) => { if (live) { setRows(next); setError(null); } })
        .catch((failure: Error) => { if (live) setError(failure.message); });
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => { live = false; clearInterval(timer); };
  }, [node]);
  const shown = (rows ?? []).filter((row) => !hideOpening || row.reference !== 'opening-balance');
  return (
    <>
      <PageHead title="Stock ledger" subtitle="Every stock movement, append-only. Outbound rows appear when stock is really dispatched." />
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title={
        <div className="row">
          <select aria-label="Location" value={node} onChange={(e) => setNode(e.target.value)}>
            <option value="">All locations</option>
            {stores.map((store) => <option key={store.store_id} value={store.store_id}>{store.name}</option>)}
          </select>
          <label className="row small"><input type="checkbox" checked={hideOpening} onChange={(e) => setHideOpening(e.target.checked)} /> Hide opening balances</label>
        </div>
      }>
        {rows === null ? <Loading /> : shown.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Location</th><th>SKU</th><th>Type</th><th className="num">Quantity</th><th>Reference</th></tr></thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.entry_id}>
                    <td className="nowrap small">{formatTime(row.occurred_at)}</td>
                    <td className="nowrap">{row.node_id}</td>
                    <td className="mono nowrap">{row.sku_id}</td>
                    <td><Badge tone={LEDGER_TONE[row.type] ?? 'neutral'}>{row.type}</Badge></td>
                    <td className="num">{row.qty}</td>
                    <td className="small muted mono">{row.reference?.slice(0, 18)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No movements yet.</Empty>}
      </Card>
    </>
  );
}

function Tools({ stores, products, outage, connection, reload }: { stores: Store[]; products: Product[]; outage: boolean; connection: Connection | null; reload: () => Promise<void> }) {
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [node, setNode] = useState('SE-STORE-B');
  const [sku, setSku] = useState('SE-CEM-025');
  const [qty, setQty] = useState(40);
  const [product, setProduct] = useState({ sku_id: '', name: 'Byggcement Extra', source_unit: 'knippe', source_category: 'cement', source_description: 'Byggcement Extra 35kg knippe', unit_price_sek: 99 });
  const [scenario, setScenario] = useState<'S1' | 'S2'>('S1');
  const [confirm, setConfirm] = useState('');
  const [adminUser, setAdminUser] = useState('admin.se');
  const [adminPassword, setAdminPassword] = useState('');

  const run = async (work: () => Promise<unknown>, done: string) => {
    setMessage(null);
    try {
      await work();
      setMessage({ tone: 'ok', text: done });
      await reload();
    } catch (failure) {
      setMessage({ tone: 'danger', text: (failure as Error).message });
    }
  };
  const connector = (enabled: boolean) =>
    run(async () => {
      await sessionFetch('/ui-api/onsite/connector', { method: 'POST', body: { enabled, username: adminUser, password: adminPassword } });
      setAdminPassword('');
    }, enabled ? 'OnSite was asked to connect. It should start reading within seconds.' : 'OnSite was asked to disconnect.');

  return (
    <>
      <PageHead title="Demo tools" subtitle="Controlled changes for the demonstration. All data here is simulated." />
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      <div className="grid grid-2">
        <Card title="OnSite connection">
          <div className="card-body stack small">
            <p>This asks OnSite Local SE, as one of its admins, to start or stop reading this system's API. It does not install or configure anything here, and the login is not kept.</p>
            {connection && !connection.onsite_process_reachable && <Alert tone="warn">OnSite Local SE is not running right now. This system works fine without it.</Alert>}
            <div className="row">
              <label className="field">OnSite admin<input value={adminUser} onChange={(e) => setAdminUser(e.target.value)} /></label>
              <label className="field">Password<input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} /></label>
            </div>
            <div className="row">
              <button type="button" className="btn primary" disabled={!adminPassword} onClick={() => void connector(true)}>Enable OnSite connection</button>
              <button type="button" className="btn" disabled={!adminPassword} onClick={() => void connector(false)}>Disconnect</button>
            </div>
          </div>
        </Card>
        <Card title="Simulated API outage" actions={outage ? <Badge tone="danger">On</Badge> : <Badge tone="ok">Off</Badge>}>
          <div className="card-body stack small">
            <p>While on, outside systems get 503 from this system's API. OnSite should stop trusting stock and hold new orders, then recover by itself.</p>
            <div className="row">
              <button type="button" className="btn danger" disabled={outage} onClick={() => void run(() => sessionFetch('/ui-api/outage', { method: 'POST', body: { enabled: true } }), 'Outage is on.')}>Start outage</button>
              <button type="button" className="btn primary" disabled={!outage} onClick={() => void run(() => sessionFetch('/ui-api/outage', { method: 'POST', body: { enabled: false } }), 'Outage is off.')}>Recover</button>
            </div>
          </div>
        </Card>
        <Card title="Receive stock">
          <div className="card-body stack small">
            <div className="row">
              <label className="field">Location
                <select value={node} onChange={(e) => setNode(e.target.value)}>
                  {stores.map((store) => <option key={store.store_id} value={store.store_id}>{store.name}</option>)}
                </select>
              </label>
              <label className="field">Product
                <select value={sku} onChange={(e) => setSku(e.target.value)}>
                  {products.map((option) => <option key={option.sku_id} value={option.sku_id}>{option.name}</option>)}
                </select>
              </label>
              <label className="field">Quantity
                <input type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
              </label>
            </div>
            <div><button type="button" className="btn primary" disabled={qty < 1} onClick={() => void run(() => sessionFetch('/ui-api/receipts', { method: 'POST', body: { node_id: node, sku_id: sku, qty, reference: 'demo-receipt' } }), `Received ${qty} at ${node}.`)}>Receive</button></div>
          </div>
        </Card>
        <Card title="New product with free-text data">
          <div className="card-body stack small">
            <p>Create a product the way a supplier feed would describe it. Unknown values go to OnSite's AI review queue.</p>
            <div className="row">
              <label className="field">SKU<input placeholder="SE-NEW-1" value={product.sku_id} onChange={(e) => setProduct({ ...product, sku_id: e.target.value })} /></label>
              <label className="field">Unit (free text)<input value={product.source_unit} onChange={(e) => setProduct({ ...product, source_unit: e.target.value })} /></label>
              <label className="field">Category (free text)<input value={product.source_category} onChange={(e) => setProduct({ ...product, source_category: e.target.value })} /></label>
            </div>
            <label className="field">Description<input value={product.source_description} onChange={(e) => setProduct({ ...product, source_description: e.target.value, name: e.target.value })} /></label>
            <div><button type="button" className="btn primary" disabled={!product.sku_id.trim()} onClick={() => void run(() => sessionFetch('/ui-api/products', { method: 'POST', body: { ...product, sku_id: product.sku_id.trim() } }), `Created ${product.sku_id}.`)}>Create product</button></div>
          </div>
        </Card>
        <Card title="Reset the simulator only">
          <div className="card-body stack small">
            <Alert tone="warn">This replaces all data in the simulator with a seeded scenario. It does not touch OnSite: if OnSite is running, use the demo reset on OnSite Operations instead, which resets everything together.</Alert>
            <div className="row">
              <label className="field">Scenario
                <select value={scenario} onChange={(e) => setScenario(e.target.value as 'S1' | 'S2')}>
                  <option value="S1">S1</option>
                  <option value="S2">S2</option>
                </select>
              </label>
              <label className="field">Type RESET to confirm<input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
            </div>
            <div><button type="button" className="btn danger" disabled={confirm !== 'RESET'} onClick={() => void run(async () => { await sessionFetch('/ui-api/demo/reset', { method: 'POST', body: { scenario, confirm } }); setConfirm(''); }, `Simulator reset to ${scenario}.`)}>Reset simulator</button></div>
          </div>
        </Card>
      </div>
    </>
  );
}
