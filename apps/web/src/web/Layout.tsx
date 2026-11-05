import { useState, type FormEvent } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Alert, Badge } from '../shared/ui';
import { formatAge } from '../shared/format';
import { api, explainError, type Health, type SystemStatus } from './api';
import { homeFor, LiveProvider, useLive, useLiveData, useSession, type Role } from './session';

const NAV: Record<Role, { to: string; label: string; end?: boolean }[]> = {
  customer: [
    { to: '/customer', label: 'Overview', end: true },
    { to: '/customer/catalog', label: 'Catalog & order' },
    { to: '/customer/orders', label: 'My orders' },
  ],
  staff: [
    { to: '/staff', label: 'Tasks', end: true },
    { to: '/staff/history', label: 'History' },
    { to: '/staff/reviews', label: 'AI review' },
  ],
  admin: [
    { to: '/admin', label: 'Operations', end: true },
    { to: '/admin/orders', label: 'All orders' },
    { to: '/admin/tasks', label: 'All tasks' },
    { to: '/admin/reviews', label: 'AI review' },
  ],
};

const AREA: Record<Role, string> = { customer: 'Customer', staff: 'Staff', admin: 'Regional admin' };

export function Shell() {
  const { session, logout } = useSession();
  const location = useLocation();
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <LiveProvider>
      <div className={`shell theme-${session.role}`}>
        <header className="topbar">
          <a className="brand" href={homeFor(session.role)}>
            OnSite<small>{AREA[session.role]}</small>
          </a>
          <nav className="nav" aria-label="Main">
            {NAV[session.role].map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end ?? false}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="userbox">
            <LiveIndicator />
            <span>
              {session.user_id}
              {session.store_id ? ` · ${session.store_id}` : ''}
            </span>
            <button type="button" onClick={() => logout()}>
              Log out
            </button>
          </div>
        </header>
        <main className="main">
          <Outlet />
        </main>
        <footer className="main small muted no-print" style={{ flex: 0, paddingTop: 0 }}>
          All times are Swedish time. Stores, customers, prices and travel times are simulated.
        </footer>
        <Toasts />
      </div>
    </LiveProvider>
  );
}

function LiveIndicator() {
  const { connected } = useLive();
  return (
    <span title="Live updates. Data always comes from the server; this only signals changes." className="small">
      <span className={`live-dot ${connected ? 'on' : ''}`} />
      {connected ? 'Live' : 'Reconnecting'}
    </span>
  );
}

function Toasts() {
  const { toasts } = useLive();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          {toast.text}
        </div>
      ))}
    </div>
  );
}

/** Keeps a screen from showing a route the role has no business on. The server enforces this regardless. */
export function RequireRole({ role, children }: { role: Role; children: React.ReactNode }) {
  const { session } = useSession();
  if (!session) return <Navigate to="/login" replace />;
  if (session.role !== role) {
    return (
      <div className="stack">
        <Alert tone="danger" title="This area is not for your account">
          You are logged in as {session.role}. <a href={homeFor(session.role)}>Go to your area</a>.
        </Alert>
      </div>
    );
  }
  return <>{children}</>;
}

export function LoginPage() {
  const { session, login, notice } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to={homeFor(session.role)} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (failure) {
      setError(explainError(failure));
      setBusy(false);
    }
  };

  return (
    <div className="center-card">
      <section className="card">
        <div className="card-body stack">
          <div>
            <h1>OnSite</h1>
            <p className="muted">Order fulfilment for building materials, Sweden. Demo environment with simulated data.</p>
          </div>
          {notice && <Alert tone="warn">{notice}</Alert>}
          {error && <Alert tone="danger">{error}</Alert>}
          <form className="stack" onSubmit={(event) => void submit(event)}>
            <label className="field">
              Username
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
            </label>
            <label className="field">
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </label>
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Logging in…' : 'Log in'}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}

const STALE_TEXT: Record<string, string> = {
  CONNECTOR_DISABLED: 'The connection to the source system is switched off.',
  LAST_SYNC_FAILED: 'The last check of the source system failed.',
  NO_CURSOR: 'Stock has not been synchronized yet.',
  NEVER_SYNCED: 'Stock has not been synchronized yet.',
  CURSOR_DISCONTINUITY: 'The change feed lost continuity and is being rebuilt.',
  SYNC_TOO_OLD: 'The source system has not been checked recently.',
};

/** Shown wherever stock matters. While stock can't be trusted, the system refuses to commit it. */
export function SystemBanner({ audience }: { audience: 'customer' | 'staff' }) {
  const { data } = useLiveData(() => api<SystemStatus>('/system/status'), [], 10000);
  if (!data || data.inventory_trusted) return null;
  const reason = data.stale_reason ? (STALE_TEXT[data.stale_reason] ?? data.stale_reason) : '';
  return audience === 'customer' ? (
    <Alert tone="warn" title="Stock cannot be confirmed right now">
      New orders are held for review instead of being promised. {reason}
    </Alert>
  ) : (
    <Alert tone="danger" title="Inventory is not trustworthy: no stock will be committed">
      {reason} {data.source_reachable ? '' : 'The source system is not responding.'} Last verified:{' '}
      {data.verified_age_s === null ? 'never' : `${formatAge(data.verified_age_s)} ago`}.
    </Alert>
  );
}

export function SourceBadges() {
  const { data } = useLiveData(() => api<Health>('/health'), [], 10000);
  if (!data) return null;
  return (
    <span className="row">
      <Badge tone={data.simulator === 'ok' ? 'ok' : 'danger'}>Source: {data.simulator}</Badge>
      <Badge tone={data.db === 'ok' ? 'ok' : 'danger'}>Database: {data.db}</Badge>
      <Badge tone={data.central === 'configured' ? 'ok' : 'neutral'}>Central: {data.central.replace('_', ' ')}</Badge>
    </span>
  );
}
