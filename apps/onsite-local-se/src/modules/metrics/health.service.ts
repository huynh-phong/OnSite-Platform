import type { SimulatorClient } from '../../connectors/simulator.js';
import type { Db } from '../../db.js';

export interface HealthReport {
  status: 'ok' | 'degraded';
  db: 'ok' | 'down';
  simulator: 'ok' | 'down' | 'disabled';
  central: 'not_configured' | 'configured';
}

export async function checkHealth(pool: Db, simulator: SimulatorClient, centralUrl?: string): Promise<HealthReport> {
  const [db, simulatorUp] = await Promise.all([
    pool.query('SELECT 1').then(
      () => 'ok' as const,
      () => 'down' as const,
    ),
    simulator.isReachable(),
  ]);
  return {
    status: db === 'ok' && simulatorUp ? 'ok' : 'degraded',
    db,
    simulator: simulatorUp ? 'ok' : simulator.enabled ? 'down' : 'disabled',
    central: centralUrl ? 'configured' : 'not_configured',
  };
}
