import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { formatMs, formatPercent, formatTime, statusText } from '../shared/format';
import { DashboardError, sessionFetch } from '../shared/http';
import { Alert, Badge, Card, Empty, Kpi, Loading, PageHead, type Tone } from '../shared/ui';

interface Country {
  origin_country: string;
  deployed: boolean;
  state: string;
  last_event_occurred_at: string | null;
  last_received_at: string | null;
  events_received: number;
  duplicate_events_ignored: number;
  out_of_order_events: number;
}
interface Dashboard {
  data_is_simulated: boolean;
  ingestion_offline: boolean;
  refused_while_offline: number;
  countries: Country[];
  orders_by_status: { status: string; count: number }[];
  kpis: {
    total_orders: number;
    at_risk_orders: number;
    early_shortage_detected: number;
    delivered_orders: number;
    simulated_otif_rate: number | null;
  };
  pilot_kpis?: {
    simulated_otif_rate: number | null;
    delay_warnings_sent: number;
    tasks_handled_in_onsite: number;
    tasks_missed_deadline: number;
    adoption_rate: number | null;
    deliveries_confirmed_digitally: number;
  };
  central_sync_lag_ms: { latest: number | null; p50: number | null; p95: number | null; sampled_events: number };
}
interface EventRow {
  event_id: string;
  event_type: string;
  origin_country: string;
  aggregate_id: string;
  aggregate_version: number;
  occurred_at: string;
  applied_at: string;
  projected: boolean;
  sync_lag_ms: number;
}

const COUNTRY_NAME: Record<string, string> = { SE: 'Sweden', DK: 'Denmark', NO: 'Norway' };
const STATE: Record<string, { tone: Tone; text: string }> = {
  ACTIVE: { tone: 'ok', text: 'Operational: receiving events' },
  IDLE: { tone: 'neutral', text: 'Operational: no recent order activity' },
  NO_EVENTS_YET: { tone: 'neutral', text: 'Deployed: no events yet' },
  INGESTION_OFFLINE: { tone: 'danger', text: 'Ingestion offline (simulated)' },
  FUTURE_EXPANSION: { tone: 'neutral', text: 'Future expansion: not deployed' },
};

/** The go/no-go gate of the Round 1 pilot proposal, measured here on simulated data. */
function PilotKpis({ kpis }: { kpis: NonNullable<Dashboard['pilot_kpis']> }) {
  const due = kpis.tasks_handled_in_onsite + kpis.tasks_missed_deadline;
  return (
    <Card title="Pilot go/no-go KPIs (Round 1)" actions={<Badge tone="neutral">Simulated data</Badge>}>
      <div className="card-body">
        <div className="kpis">
          <Kpi label="Simulated OTIF" value={formatPercent(kpis.simulated_otif_rate)} hint="Not a real-world result. Gate: +3 pp over the pilot baseline" />
          <Kpi
            label="Delay warnings sent before the customer asked"
            value={kpis.delay_warnings_sent}
            hint="Gate: status calls −30%. Each warning answers a call before it is made"
          />
          <Kpi
            label="Node tasks handled in OnSite"
            value={formatPercent(kpis.adoption_rate)}
            hint={`Gate: adoption >90%. ${kpis.tasks_handled_in_onsite} of ${due} decided before the deadline`}
            {...(kpis.adoption_rate !== null && kpis.adoption_rate < 0.9 ? { tone: 'warn' as const } : {})}
          />
          <Kpi label="Deliveries confirmed digitally" value={kpis.deliveries_confirmed_digitally} hint="Proof of delivery in OnSite, not on paper" />
        </div>
      </div>
    </Card>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await sessionFetch('/auth/login', { method: 'POST', body: { password } });
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
            <h1>OnSite Central</h1>
            <p className="muted">Cross-country monitoring. Holds no customer data.</p>
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          <label className="field">
            Admin password
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
  const [data, setData] = useState<Dashboard | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [dashboard, recent] = await Promise.all([
        sessionFetch<Dashboard>('/dashboard'),
        sessionFetch<EventRow[]>('/events?limit=30'),
      ]);
      setData(dashboard);
      setEvents(recent);
      setError(null);
    } catch (failure) {
      if (failure instanceof DashboardError && failure.status === 401) setAuthed(false);
      else setError((failure as Error).message);
    }
  }, []);

  useEffect(() => {
    sessionFetch<{ authenticated: boolean }>('/auth/me')
      .then((me) => setAuthed(me.authenticated))
      .catch(() => setAuthed(false));
  }, []);
  useEffect(() => {
    if (!authed) return undefined;
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [authed, load]);

  const setOffline = async (enabled: boolean) => {
    setBusy(true);
    try {
      await sessionFetch('/admin/offline', { method: 'POST', body: { enabled } });
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    }
    setBusy(false);
  };
  const logout = async () => {
    await sessionFetch('/auth/logout', { method: 'POST' });
    setAuthed(false);
  };

  if (authed === null) return <Loading />;
  if (!authed) return <div className="shell theme-central"><Login onDone={() => setAuthed(true)} /></div>;

  const maxCount = Math.max(1, ...(data?.orders_by_status ?? []).map((row) => row.count));
  const sweden = data?.countries.find((country) => country.origin_country === 'SE');
  return (
    <div className="shell theme-central">
      <header className="topbar">
        <span className="brand">OnSite Central<small>Monitoring only: orders are processed in each country</small></span>
        <span style={{ flex: 1 }} />
        <div className="userbox"><button type="button" onClick={() => void logout()}>Log out</button></div>
      </header>
      <main className="main stack">
        <PageHead
          title="Cross-country overview"
          subtitle="Near-real-time synchronization from filtered events. Figures come from a simulated environment."
          actions={
            data?.ingestion_offline ? (
              <button type="button" className="btn primary" disabled={busy} onClick={() => void setOffline(false)}>Restore ingestion</button>
            ) : (
              <button type="button" className="btn danger" disabled={busy} onClick={() => void setOffline(true)}>Simulate Central outage</button>
            )
          }
        />
        {error && <Alert tone="danger" title="Could not refresh">{error}</Alert>}
        {data?.ingestion_offline && (
          <Alert tone="danger" title="Simulated outage: Central is refusing new events">
            Local SE keeps taking and processing orders, and holds its events to retry later. Refused so far: {data.refused_while_offline}. Check "Waiting to send" in OnSite Operations.
          </Alert>
        )}
        {!data && !error && <Loading />}
        {data && (
          <>
            <Card title="Countries">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Country</th><th>State</th><th>Latest event</th><th>Last received</th><th className="num">Events</th><th className="num">Duplicates ignored</th><th className="num">Late arrivals</th></tr>
                  </thead>
                  <tbody>
                    {data.countries.map((country) => {
                      const state = STATE[country.state] ?? { tone: 'neutral' as Tone, text: country.state };
                      return (
                        <tr key={country.origin_country}>
                          <td>{COUNTRY_NAME[country.origin_country] ?? country.origin_country}</td>
                          <td><Badge tone={state.tone}>{state.text}</Badge></td>
                          <td className="nowrap">{formatTime(country.last_event_occurred_at)}</td>
                          <td className="nowrap">{formatTime(country.last_received_at)}</td>
                          <td className="num">{country.deployed ? country.events_received : '—'}</td>
                          <td className="num">{country.deployed ? country.duplicate_events_ignored : '—'}</td>
                          <td className="num">{country.deployed ? country.out_of_order_events : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

            {data.pilot_kpis && <PilotKpis kpis={data.pilot_kpis} />}

            <div className="kpis">
              <Kpi label="Orders processed" value={data.kpis.total_orders} hint="Simulated data" />
              <Kpi label="At risk now" value={data.kpis.at_risk_orders} {...(data.kpis.at_risk_orders ? { tone: 'warn' as const } : {})} />
              <Kpi label="Shortages caught at order time" value={data.kpis.early_shortage_detected} />
              <Kpi label="Delivered" value={data.kpis.delivered_orders} />
              {!data.pilot_kpis && <Kpi label="Simulated OTIF" value={formatPercent(data.kpis.simulated_otif_rate)} hint="Not a real-world result" />}
            </div>

            <div className="grid grid-2">
              <Card title="Local → Central sync lag">
                <div className="card-body stack">
                  <div className="kpis">
                    <Kpi label="Latest" value={formatMs(data.central_sync_lag_ms.latest)} />
                    <Kpi label="p50" value={formatMs(data.central_sync_lag_ms.p50)} />
                    <Kpi label="p95" value={formatMs(data.central_sync_lag_ms.p95)} />
                  </div>
                  <p className="small muted">
                    Central applied time minus the time the event happened in Local, over the last {data.central_sync_lag_ms.sampled_events} events, on the machine this runs on. After an outage it includes the time events waited. This is different from Local API latency and inventory freshness, which are on OnSite Operations.
                  </p>
                </div>
              </Card>
              <Card title="Orders by status">
                <div className="card-body">
                  {data.orders_by_status.length ? (
                    <div className="bars">
                      {data.orders_by_status.map((row) => (
                        <div key={row.status} className="bar-row">
                          <span>{statusText(row.status)}</span>
                          <span className="bar-track"><span style={{ width: `${(row.count / maxCount) * 100}%` }} /></span>
                          <span className="num">{row.count}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty>No orders received yet.</Empty>
                  )}
                </div>
              </Card>
            </div>

            <Card title="Event ingestion history" actions={<span className="small muted">Last received: {formatTime(sweden?.last_received_at)}</span>}>
              {events.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Applied</th><th>Event</th><th>Order</th><th className="num">Version</th><th className="num">Lag</th><th>Projection</th></tr>
                    </thead>
                    <tbody>
                      {events.map((event) => (
                        <tr key={event.event_id}>
                          <td className="nowrap small">{formatTime(event.applied_at)}</td>
                          <td className="mono">{event.event_type}</td>
                          <td className="nowrap">{event.aggregate_id}</td>
                          <td className="num">{event.aggregate_version}</td>
                          <td className="num">{formatMs(event.sync_lag_ms)}</td>
                          <td>{event.projected ? <Badge tone="ok">Applied</Badge> : <Badge>Older version, kept for the record</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty>No events received yet.</Empty>
              )}
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
