export type StaleReason =
  | 'CONNECTOR_DISABLED'
  | 'NO_CURSOR'
  | 'NEVER_SYNCED'
  | 'CURSOR_DISCONTINUITY'
  | 'LAST_SYNC_FAILED'
  | 'SYNC_TOO_OLD';

export interface CursorState {
  lastSeq: number;
  lastSuccessfulSyncAt: Date | null;
  lastError: string | null;
  continuityOk: boolean;
}

export interface FreshnessInput {
  now: Date;
  connectorEnabled: boolean;
  cursor: CursorState | null;
  staleAfterSeconds: number;
}

export interface Freshness {
  trusted: boolean;
  staleReason: StaleReason | null;
  lastSuccessfulSyncAt: Date | null;
  verifiedAgeSeconds: number | null;
}

/**
 * Decides whether the local inventory view may back a stock commitment. Row timestamps do not take part:
 * a row that has not changed for days is still current if the complete feed was just checked. Trust
 * comes from the sync itself: the connector is on, the cursor is known and continuous, the last attempt
 * succeeded, and that verification is recent.
 */
export function assessFreshness({ now, connectorEnabled, cursor, staleAfterSeconds }: FreshnessInput): Freshness {
  const lastSuccessfulSyncAt = cursor?.lastSuccessfulSyncAt ?? null;
  const verifiedAgeSeconds = lastSuccessfulSyncAt ? (now.getTime() - lastSuccessfulSyncAt.getTime()) / 1000 : null;
  const result = (staleReason: StaleReason | null): Freshness => ({
    trusted: staleReason === null,
    staleReason,
    lastSuccessfulSyncAt,
    verifiedAgeSeconds,
  });

  if (!connectorEnabled) return result('CONNECTOR_DISABLED');
  if (!cursor) return result('NO_CURSOR');
  if (cursor.lastError) return result('LAST_SYNC_FAILED');
  if (!lastSuccessfulSyncAt || verifiedAgeSeconds === null) return result('NEVER_SYNCED');
  if (!cursor.continuityOk) return result('CURSOR_DISCONTINUITY');
  if (verifiedAgeSeconds > staleAfterSeconds) return result('SYNC_TOO_OLD');
  return result(null);
}
