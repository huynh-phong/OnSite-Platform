function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig() {
  return {
    port: Number(process.env.PORT ?? 6001),
    databaseUrl: required('CENTRAL_DATABASE_URL'),
    /** Authenticates each Local deployment. Sweden is the only one in the MVP. */
    ingestToken: required('SE_CENTRAL_TOKEN'),
    adminPassword: required('CENTRAL_ADMIN_PASSWORD'),
  };
}

export type Config = ReturnType<typeof loadConfig>;
