import type { Tone } from './ui';

const STOCKHOLM = 'Europe/Stockholm';

/** Dispatch slots and deadlines are all in Swedish time, so times are shown that way, whatever the viewer's clock. */
export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: STOCKHOLM,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatPercent(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

export function formatSek(value: number): string {
  return `${new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(value)} SEK`;
}

export function statusText(status: string): string {
  return status.replaceAll('_', ' ').toLowerCase().replace(/^./, (first) => first.toUpperCase());
}

export function orderTone(status: string): Tone {
  switch (status) {
    case 'DELIVERED':
    case 'APPROVED':
    case 'DISPATCHED':
      return 'ok';
    case 'AWAITING_APPROVAL':
    case 'DISPATCHING':
    case 'ALLOCATING':
    case 'SUBMITTED':
      return 'info';
    case 'NEEDS_REVIEW':
    case 'NEEDS_REALLOCATION':
      return 'warn';
    case 'EXPIRED':
    case 'REJECTED':
      return 'danger';
    default:
      return 'neutral';
  }
}

function stockholmParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STOCKHOLM,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** Reads a date-time input as Swedish wall-clock time, wherever the browser happens to be. */
export function stockholmInputToIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return new Date(NaN).toString();
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const p = stockholmParts(new Date(instant));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(instant / 60000) * 60000;
  };
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first)).toISOString();
}

/** The input value for noon, Swedish time, a number of days from now. */
export function stockholmNoonInput(daysAhead: number, now = new Date()): string {
  const { year, month, day } = stockholmParts(new Date(now.getTime() + daysAhead * 86400_000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T12:00`;
}
