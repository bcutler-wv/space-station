import { setTimeout as delay } from 'node:timers/promises';
import { openSearchAccess, SearchEngineError } from './opensearch-runtime.js';

const deadline = performance.now() + 120_000;
let access: Awaited<ReturnType<typeof openSearchAccess>> | undefined;
let phase = 'identity';
try {
  access = await openSearchAccess({ endpoint: process.env.OPENSEARCH_URL ?? '',
    identityDir: process.env.OPENSEARCH_IDENTITY_DIR ?? '', role: 'admin' });
  phase = 'readiness';
  let ready = false;
  while (performance.now() < deadline) {
    try { await access.info(); await access.health(); ready = true; break; }
    catch { await delay(Math.min(1_000, Math.max(1, deadline - performance.now()))); }
  }
  if (!ready) throw new Error('readiness');
  phase = 'security';
  await access.verifySecurity();
  phase = 'profile';
  await access.createProfile();
  console.info('Private OpenSearch profile verified.');
} catch (error) {
  const detail = error instanceof SearchEngineError ?
    `${error.kind}${error.statusCode === undefined ? '' : `/${error.statusCode}`}` : 'unexpected';
  console.error(`Private OpenSearch bootstrap failed: ${phase}/${detail}.`);
  process.exitCode = 1;
} finally { await access?.close(); }
