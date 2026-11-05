import type { Db } from '../db.js';

export async function isOutageEnabled(pool: Db): Promise<boolean> {
  const { rows } = await pool.query<{ outage_enabled: boolean }>('SELECT outage_enabled FROM sim_settings');
  return rows[0]?.outage_enabled ?? false;
}

export async function setOutage(pool: Db, enabled: boolean): Promise<boolean> {
  await pool.query('UPDATE sim_settings SET outage_enabled = $1', [enabled]);
  return enabled;
}
