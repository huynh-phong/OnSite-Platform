// @ts-expect-error A plain ESM helper, shared with the measuring scripts.
import { assertBuilt, buildEnv, resetDatabases, startServices, stopServices } from './stack/lib.mjs';

export default async function globalSetup() {
  assertBuilt();
  const env = await buildEnv();
  await resetDatabases(env);
  const children = await startServices(env);
  // Test workers inherit these. Nothing here is a real secret: all are generated for this run.
  process.env.E2E_ENV = JSON.stringify(env);
  return async () => stopServices(children);
}
