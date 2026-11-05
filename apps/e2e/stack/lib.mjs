// Starts the real, built services on spare ports, against disposable *_e2e databases and with throwaway
// secrets. The demo databases, demo passwords and any stack on the normal ports are left alone.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');

export const PORTS = { web: 13000, local: 14000, sim: 15000, central: 16001 };
export const URLS = {
  web: `http://localhost:${PORTS.web}`,
  local: `http://localhost:${PORTS.local}`,
  sim: `http://localhost:${PORTS.sim}`,
  central: `http://localhost:${PORTS.central}`,
};

function baseDatabaseUrl(name) {
  if (process.env[name]) return process.env[name];
  const file = readFileSync(path.join(repoRoot, '.env'), 'utf8');
  const line = file.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not set in the environment or in .env`);
  return line.slice(name.length + 1);
}

async function disposableDatabase(name) {
  const url = new URL(baseDatabaseUrl(name));
  const testName = `${url.pathname.slice(1)}_e2e`;
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testName]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE ${testName}`);
  await admin.end();
  url.pathname = `/${testName}`;
  return url.toString();
}

export async function buildEnv() {
  const hex = (bytes) => randomBytes(bytes).toString('hex');
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    LOG_LEVEL: 'info',
    COUNTRY_CODE: 'SE',
    SE_DATABASE_URL: await disposableDatabase('SE_DATABASE_URL'),
    SIM_DATABASE_URL: await disposableDatabase('SIM_DATABASE_URL'),
    CENTRAL_DATABASE_URL: await disposableDatabase('CENTRAL_DATABASE_URL'),
    SE_JWT_SECRET: hex(32),
    SE_DATA_KEY: randomBytes(32).toString('base64'),
    SE_DATA_KEY_ID: 'se-key-v1',
    DEMO_PASSWORD: hex(8),
    SIM_DASHBOARD_PASSWORD: hex(8),
    CENTRAL_ADMIN_PASSWORD: hex(8),
    SIMULATOR_SERVICE_TOKEN: hex(32),
    SE_CENTRAL_TOKEN: hex(32),
    SIMULATOR_BASE_URL: URLS.sim,
    LOCAL_SE_URL: URLS.local,
    CENTRAL_INGEST_URL: `${URLS.central}/ingest/events`,
    // Deterministic. A live provider must never be called by routine tests.
    LLM_PROVIDER: 'mock',
    DEMO_RESET_ENABLED: 'true',
    INVENTORY_SYNC_SECONDS: '2',
    // Short, so the circuit breaker can be seen within a test. The design value is 300.
    NODE_HEARTBEAT_TIMEOUT_SECONDS: '4',
    NODE_HEARTBEAT_CHECK_SECONDS: '1',
  };
}

function run(cwd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited with ${code}`))));
  });
}

const dirs = {
  sim: path.join(repoRoot, 'apps/sweden-simulator'),
  local: path.join(repoRoot, 'apps/onsite-local-se'),
  central: path.join(repoRoot, 'apps/onsite-central'),
  web: path.join(repoRoot, 'apps/web'),
};

export function assertBuilt() {
  const entries = [
    [dirs.sim, 'dist/server.js'],
    [dirs.local, 'dist/server.js'],
    [dirs.central, 'dist/server.js'],
    [dirs.web, 'dist-server/index.js'],
    [dirs.web, 'dist/web/web.html'],
    [dirs.web, 'dist/legacy/legacy.html'],
    [dirs.web, 'dist/central/central.html'],
  ];
  for (const [dir, file] of entries) {
    if (!existsSync(path.join(dir, file))) throw new Error(`${file} is missing in ${dir}: build the apps first`);
  }
}

export async function resetDatabases(env, scenario = 'S1') {
  await run(dirs.sim, ['dist/cli/reset.js', scenario], env);
  await run(dirs.local, ['dist/cli/reset.js'], env);
  await run(dirs.central, ['dist/cli/reset.js'], env);
}

async function waitFor(url, children) {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      // Not up yet.
    }
    for (const child of children) {
      if (child.exitCode !== null) throw new Error(`A service exited early, code ${child.exitCode}: see ${logDir}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export const logDir = path.join(repoRoot, 'apps/e2e/test-results/service-logs');

const SERVICES = {
  simulator: { dir: dirs.sim, entry: 'dist/server.js', port: PORTS.sim, health: `${URLS.sim}/health` },
  central: { dir: dirs.central, entry: 'dist/server.js', port: PORTS.central, health: `${URLS.central}/health` },
  'local-se': { dir: dirs.local, entry: 'dist/server.js', port: PORTS.local, health: `${URLS.local}/api/v1/health` },
  web: { dir: dirs.web, entry: 'dist-server/index.js', port: PORTS.web, health: `${URLS.web}/health` },
};

export async function startService(name, env) {
  mkdirSync(logDir, { recursive: true });
  const service = SERVICES[name];
  const log = createWriteStream(path.join(logDir, `${name}.log`), { flags: 'a' });
  const child = spawn(process.execPath, [service.entry], { cwd: service.dir, env: { ...env, PORT: String(service.port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  await waitFor(service.health, [child]);
  return child;
}

export async function startServices(env) {
  mkdirSync(logDir, { recursive: true });
  for (const name of Object.keys(SERVICES)) writeFileSync(path.join(logDir, `${name}.log`), '');
  const children = [];
  for (const name of Object.keys(SERVICES)) children.push(await startService(name, env));
  return children;
}

export async function stopServices(children) {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
