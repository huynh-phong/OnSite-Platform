import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

const ALERT_ICON: Record<Exclude<Tone, 'neutral'>, LucideIcon> = { ok: CircleCheck, warn: TriangleAlert, danger: CircleAlert, info: Info };

export function Alert({ tone = 'info', title, children }: { tone?: Exclude<Tone, 'neutral'>; title?: string; children?: ReactNode }) {
  const Icon = ALERT_ICON[tone];
  return (
    <div className={`alert ${tone}`} role={tone === 'danger' || tone === 'warn' ? 'alert' : 'status'}>
      <Icon className="alert-icon" size={18} aria-hidden="true" />
      <div className="alert-body">
        {title && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** The value comes first in the markup, then the label: the layout puts the label on top. */
export function Kpi({ label, value, hint, tone, icon: Icon }: { label: string; value: ReactNode; hint?: string; tone?: 'warn' | 'danger'; icon?: LucideIcon }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
      {hint && <div className="hint">{hint}</div>}
      {Icon && (
        <span className="kpi-icon">
          <Icon size={16} aria-hidden="true" />
        </span>
      )}
    </div>
  );
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-ring" aria-hidden="true" />
      {what}…
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

/** The OnSite mark: a stack of building blocks, drawn inline so it needs no file or network. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M9 21.5h14M9 16.5h14" stroke="#fff" strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round" />
      <rect x="8" y="9" width="7" height="5" rx="1.2" fill="#fff" />
      <rect x="17" y="9" width="7" height="5" rx="1.2" fill="#fff" fillOpacity="0.8" />
      <rect x="12.5" y="18" width="7" height="5" rx="1.2" fill="#fff" fillOpacity="0.9" />
    </svg>
  );
}
