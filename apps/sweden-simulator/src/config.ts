function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig() {
  return {
    port: Number(process.env.PORT ?? 5000),
    databaseUrl: required('SIM_DATABASE_URL'),
    serviceToken: required('SIMULATOR_SERVICE_TOKEN'),
    dashboardPassword: process.env.SIM_DASHBOARD_PASSWORD || undefined,
    /** Optional. The simulator works without OnSite; this only serves the connect action on the dashboard. */
    localSeUrl: process.env.LOCAL_SE_URL?.replace(/\/$/, '') || undefined,
    expirySweepSeconds: Number(process.env.SIM_EXPIRY_SWEEP_SECONDS ?? 30),
  };
}
