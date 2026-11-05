function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function numberFrom(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function dataKey(): Buffer {
  const key = Buffer.from(required('SE_DATA_KEY'), 'base64');
  if (key.length !== 32) throw new Error('SE_DATA_KEY must be 32 bytes encoded as base64');
  return key;
}

const llmProviders = ['mock', 'anthropic', 'gemini'] as const;
export type LlmProviderName = (typeof llmProviders)[number];

function llmProvider(): LlmProviderName {
  const value = process.env.LLM_PROVIDER ?? 'mock';
  if (!(llmProviders as readonly string[]).includes(value)) {
    throw new Error(`LLM_PROVIDER must be one of: ${llmProviders.join(', ')}`);
  }
  return value as LlmProviderName;
}

/** The key for the chosen provider. Gemini also accepts its conventional variable name. */
export function resolveLlmApiKey(provider: LlmProviderName): string | undefined {
  if (provider === 'gemini') return process.env.GEMINI_API_KEY || process.env.LLM_API_KEY || undefined;
  return process.env.LLM_API_KEY || undefined;
}

export function loadConfig() {
  const provider = llmProvider();
  const jwtSecret = required('SE_JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('SE_JWT_SECRET must be at least 32 characters');
  return {
    port: Number(process.env.PORT ?? 4000),
    countryCode: required('COUNTRY_CODE'),
    databaseUrl: required('SE_DATABASE_URL'),
    jwtSecret,
    jwtTtlSeconds: 8 * 60 * 60,
    dataKey: dataKey(),
    dataKeyId: required('SE_DATA_KEY_ID'),
    simulatorBaseUrl: required('SIMULATOR_BASE_URL').replace(/\/$/, ''),
    simulatorServiceToken: required('SIMULATOR_SERVICE_TOKEN'),
    centralIngestUrl: process.env.CENTRAL_INGEST_URL || undefined,
    centralServiceToken: process.env.SE_CENTRAL_TOKEN || undefined,
    llm: {
      provider,
      apiKey: resolveLlmApiKey(provider),
      model: process.env.LLM_MODEL || undefined,
      timeoutMs: numberFrom('LLM_TIMEOUT_SECONDS', 10) * 1000,
      /** A claim older than this is treated as an interrupted call and may be retried. */
      claimLeaseSeconds: numberFrom('LLM_CLAIM_LEASE_SECONDS', 60),
      maxAttempts: 3,
    },
    demoPassword: required('DEMO_PASSWORD'),
    /** Lets an admin wipe and re-seed all demo data from the API. Off unless asked for. */
    demoResetEnabled: process.env.DEMO_RESET_ENABLED === 'true',
    sourceSystem: 'sweden-legacy',
    inventory: {
      safetyRatio: numberFrom('INVENTORY_SAFETY_RATIO', 0.1),
      syncSeconds: numberFrom('INVENTORY_SYNC_SECONDS', 10),
      /** Stock may only be committed if the complete feed was verified this recently. */
      staleAfterSeconds: numberFrom('INVENTORY_STALE_AFTER_SECONDS', 60),
    },
    reservation: {
      ttlMinutes: numberFrom('RESERVATION_TTL_MINUTES', 30),
      maxRetries: 2,
      expirySeconds: 30,
      renewalSeconds: numberFrom('RESERVATION_RENEWAL_SECONDS', 60),
      /** Approved reservations are renewed when they have less than this left. */
      renewWithinMinutes: numberFrom('RESERVATION_RENEW_WITHIN_MINUTES', 15),
      /** Allocation interrupted by a crash is closed after this long. */
      interruptedAfterSeconds: 120,
    },
    routing: { maxSourcesPerLine: 3 },
    eta: {
      timeZone: 'Europe/Stockholm',
      dispatchSlots: ['07:00', '09:00', '11:00', '13:00', '15:00'],
      avgSpeedKmh: 40,
      unloadMinutes: 15,
      watchSeconds: 60,
    },
    outbox: {
      sendSeconds: 2,
      batchSize: 50,
      maxNonRetryableFailures: 10,
      baseBackoffMs: 2000,
      maxBackoffMs: 5 * 60 * 1000,
      leaseSeconds: 30,
      timeoutMs: 5000,
    },
    sourceTimeoutMs: numberFrom('SOURCE_TIMEOUT_MS', 3000),
  };
}

export type Config = ReturnType<typeof loadConfig>;
