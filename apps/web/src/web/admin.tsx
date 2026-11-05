import { useState } from 'react';
import { formatAge, formatMs, formatPercent, formatTime } from '../shared/format';
import { Alert, Badge, Card, Empty, Kpi, Loading, PageHead } from '../shared/ui';
import { api, explainError, type Metrics, type OrderSummary, type SystemStatus } from './api';
import { OrdersTable } from './customer';
import { SourceBadges, SystemBanner } from './Layout';
import { useLiveData } from './session';

export function AdminHome() {
  const metrics = useLiveData(() => api<Metrics>('/metrics'), [], 5000);
  const status = useLiveData(() => api<SystemStatus>('/system/status'), [], 5000);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connector = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api(`/admin/connector/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
      setMessage(enabled ? 'Connection on. The sync picks up within seconds.' : 'Connection off. New orders are now held for review.');
    } catch (failure) {
      setError(explainError(failure));
    }
    await Promise.all([status.reload(), metrics.reload()]);
    setBusy(false);
  };

  const m = metrics.data;
  return (
    <div className="stack">
      <PageHead title="Operations" subtitle="Local SE health and demo controls" actions={<SourceBadges />} />
      <SystemBanner audience="staff" />
      {message && <Alert tone="ok">{message}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="grid grid-2">
        <Card title="Source connection" actions={status.data && <Badge tone={status.data.connector_enabled ? 'ok' : 'neutral'}>{status.data.connector_enabled ? 'Enabled' : 'Disabled'}</Badge>}>
          <div className="card-body stack small">
            <p>Controls whether Local SE reads from the source system through its API. It does not install or configure anything in that system.</p>
            <div>
              Stock trustworthy: {status.data?.inventory_trusted ? <Badge tone="ok">Yes</Badge> : <Badge tone="danger">No</Badge>}
              {status.data?.stale_reason && <span className="muted"> ({status.data.stale_reason})</span>}
            </div>
            <div className="muted">
              Feed last verified {formatAge(status.data?.verified_age_s)} ago, at {formatTime(status.data?.last_successful_sync_at)}. Stale after {status.data?.stale_after_s} s.
            </div>
            <div className="row">
              <button type="button" className="btn primary" disabled={busy || status.data?.connector_enabled} onClick={() => void connector(true)}>
                Enable OnSite connection
              </button>
              <button type="button" className="btn" disabled={busy || !status.data?.connector_enabled} onClick={() => void connector(false)}>
                Disconnect
              </button>
            </div>
          </div>
        </Card>
        <DemoReset onDone={() => Promise.all([status.reload(), metrics.reload()])} />
      </div>

      {metrics.loading && !m && <Loading what="Loading metrics" />}
      {m && (
        <>
          <h2>Three different delays, measured separately</h2>
          <div className="kpis">
            <Kpi label="Local API latency, p50 / p95" value={<span style={{ fontSize: '1.1rem' }}>{formatMs(m.api.p50_ms)} / {formatMs(m.api.p95_ms)}</span>} hint={`${m.api.samples} requests`} />
            <Kpi label="Inventory feed verified" value={<span style={{ fontSize: '1.1rem' }}>{formatAge(m.inventory.verified_age_s)} ago</span>} hint="How current Local's stock view is" />
            <Kpi label="Oldest event not yet at Central" value={<span style={{ fontSize: '1.1rem' }}>{m.outbox.outbox_pending ? formatAge(m.outbox.outbox_oldest_age_s) : 'None'}</span>} hint="Sync lag itself is shown on Central" />
          </div>

          <h2>Events to Central</h2>
          <div className="kpis">
            <Kpi label="Waiting to send" value={m.outbox.outbox_pending} {...(m.outbox.outbox_pending > 20 ? { tone: 'warn' as const } : {})} hint="Orders carry on regardless" />
            <Kpi label="Delivered" value={m.outbox.outbox_delivered} />
            <Kpi label="Refused for good" value={m.outbox.outbox_dead} {...(m.outbox.outbox_dead ? { tone: 'danger' as const } : {})} />
          </div>

          <h2>Reservations, AI and orders</h2>
          <div className="kpis">
            <Kpi label="Orders" value={m.business.orders_total} hint="Simulated data" />
            <Kpi label="Shortages caught at order time" value={m.business.early_shortage_detected} />
            <Kpi label="At risk now" value={m.business.at_risk_count} />
            <Kpi label="OTIF" value={formatPercent(m.business.otif_rate)} hint={`Simulated, from ${m.business.delivered_orders} delivered`} />
            <Kpi label="Reservation conflicts" value={m.reservations.reservation_conflicts} />
            <Kpi label="Renewals / failures" value={<span style={{ fontSize: '1.1rem' }}>{m.reservations.renewals_total} / {m.reservations.renewal_failures_total}</span>} />
            <Kpi label="Reservations lost" value={m.reservations.lost_total} {...(m.reservations.lost_total ? { tone: 'danger' as const } : {})} />
            <Kpi label="AI calls" value={m.ai.ai_calls_total} hint={`${m.ai.review_queue_pending} waiting for review`} />
          </div>

          <Card title="Inventory by node">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Node</th><th className="num">Stock rows</th><th className="num">Last stock change at source</th></tr>
                </thead>
                <tbody>
                  {m.inventory.nodes.map((node) => (
                    <tr key={node.node_id}>
                      <td>{node.node_id}</td>
                      <td className="num">{node.rows}</td>
                      <td className="num">{formatAge(node.newest_source_change_age_s)} ago</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-body small muted">A node with no recent change is not stale: its stock is simply unchanged, and the feed confirms that.</div>
          </Card>
        </>
      )}
    </div>
  );
}

function DemoReset({ onDone }: { onDone: () => Promise<unknown> }) {
  const [scenario, setScenario] = useState<'S1' | 'S2'>('S1');
  const [connector, setConnector] = useState<'enabled' | 'disabled'>('enabled');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await api<{ scenario: string; connector_enabled: boolean; central: string }>('/admin/demo/reset', {
        method: 'POST',
        body: { scenario, confirm, connector },
      });
      setResult(`Reset to ${response.scenario}. Connection ${response.connector_enabled ? 'on' : 'off'}. Central: ${response.central.replace('_', ' ')}.`);
      setConfirm('');
    } catch (failure) {
      setError(explainError(failure));
    }
    await onDone();
    setBusy(false);
  };

  return (
    <Card title="Demo reset">
      <div className="card-body stack small">
        <Alert tone="warn">This deletes every order, task, review and event in the simulator, Local SE and Central, and restores the seeded test data.</Alert>
        <div className="row">
          <label className="field">
            Scenario
            <select value={scenario} onChange={(e) => setScenario(e.target.value as 'S1' | 'S2')}>
              <option value="S1">S1: hub 60 (100 bags split 54 + 46)</option>
              <option value="S2">S2: hub 40 (100 bags, only 90 usable)</option>
            </select>
          </label>
          <label className="field">
            Connection afterwards
            <select value={connector} onChange={(e) => setConnector(e.target.value as 'enabled' | 'disabled')}>
              <option value="enabled">On</option>
              <option value="disabled">Off (for "before OnSite")</option>
            </select>
          </label>
        </div>
        <label className="field">
          Type RESET to confirm
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <button type="button" className="btn danger" disabled={busy || confirm !== 'RESET'} onClick={() => void run()}>
          {busy ? 'Resetting…' : 'Reset all demo data'}
        </button>
        {result && <Alert tone="ok">{result}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Card>
  );
}

export function AdminOrders() {
  const orders = useLiveData(() => api<OrderSummary[]>('/orders'));
  return (
    <div className="stack">
      <PageHead title="All orders" subtitle="Everything in Sweden" />
      <Card>
        {orders.loading && !orders.data ? <Loading /> : orders.data?.length ? <OrdersTable orders={orders.data} base="/admin/orders" /> : <Empty>No orders yet.</Empty>}
      </Card>
    </div>
  );
}
