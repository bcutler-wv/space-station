import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import console from 'node:console';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, connect } from 'node:net';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { accounts, auditLog, databaseUrl, loadRuntimeConfig, openDatabase, items, syncStates, outboundOperations, drafts, draftAttachments,
  mailChangeOperations } from '../../packages/db/dist/index.js';
import { GMAIL_DISCOVER_QUEUE, GMAIL_SYNC_QUEUE } from '../../apps/worker/dist/queue.js';

const fetch = globalThis.fetch;
const AbortSignal = globalThis.AbortSignal;

// CI-only control process. Production entrypoints never import this file.
const config = loadRuntimeConfig(process.env);
const dbHandle = openDatabase(databaseUrl(config));
const db = dbHandle.db;
const artifacts = process.env.M1_BROWSER_ARTIFACT_ROOT ?? `${process.cwd()}/.cache/results/m1-browser`;
const blobRoot = process.env.STATION_TEST_BLOB_ROOT;
const controlHost = process.env.M1_BROWSER_CONTROL_HOST ?? '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0'].includes(controlHost)) throw new Error('Invalid browser fixture control host');
if (!blobRoot || !config.APP_TLS_CERT_PATH || !config.APP_TLS_KEY_PATH) throw new Error('Browser fixture needs private blobs and TLS');
await mkdir(artifacts, { recursive: true });
const port = () => new Promise((resolve, reject) => {
  const server = createNetServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
});
const ports = { provider: await port(), parser: await port() };
const env = { ...process.env, FIXTURE_PROVIDER_PORT: String(ports.provider), FIXTURE_PARSER_PORT: String(ports.parser),
  FIXTURE_APP_PORT: String(config.APP_PORT), FIXTURE_BROWSER_DATA: '1', STATION_TEST_BLOB_ROOT: blobRoot };
const children = new Set();
let sequence = 0;
const launch = (name, role) => {
  const child = spawn(process.execPath, ['tests/support/process-recovery-runtime.mjs', role], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  const log = createWriteStream(`${artifacts}/${++sequence}-${name}.log`);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once('exit', (code, signal) => log.end(`\nexit ${code ?? signal}\n`));
  return child;
};
const provider = spawn(process.execPath, ['tests/support/process-recovery-provider.mjs'], {
  cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
});
children.add(provider);
provider.once('exit', () => children.delete(provider));
const providerLog = createWriteStream(`${artifacts}/0-provider.log`);
provider.stdout.pipe(providerLog, { end: false });
provider.stderr.pipe(providerLog, { end: false });
provider.once('exit', (code, signal) => providerLog.end(`\nexit ${code ?? signal}\n`));
let parser = launch('parser', 'parser');
let app = launch('app', 'browser-app');
let worker;
const kill = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await Promise.race([exited, delay(5_000).then(() => { throw new Error('Child kill timed out'); })]);
};
const requireWorker = createRequire(new URL('../../apps/worker/package.json', import.meta.url));
const { PgBoss } = requireWorker('pg-boss');
const queue = new PgBoss({ connectionString: databaseUrl(config), migrate: false, registerInstance: false,
  supervise: false, monitorIntervalSeconds: 1, superviseIntervalSeconds: 1 });
try {
  await queue.start();
  // Only expiry changes in this disposable queue. Production's stately, zero-retry policy remains.
  await queue.updateQueue(GMAIL_SYNC_QUEUE, { expireInSeconds: 25 });
  const [policy] = (await db.execute(sql`select policy, retry_limit, expire_seconds from pgboss.queue where name = ${GMAIL_SYNC_QUEUE}`)).rows;
  assert.equal(policy.policy, 'stately');
  assert.equal(policy.retry_limit, 0);
  assert.equal(policy.expire_seconds, 25);
} catch (error) {
  await Promise.all([...children].map((child) => kill(child).catch(() => {})));
  await queue.stop({ timeout: 5_000 }).catch(() => {});
  await dbHandle.close();
  throw error;
}
const providerBase = `http://127.0.0.1:${ports.provider}`;
const providerState = async () => (await fetch(`${providerBase}/fixture/state`, { signal: AbortSignal.timeout(3_000) })).json();
const providerControl = async (name, value) => {
  const response = await fetch(`${providerBase}/fixture/${name}`, { signal: AbortSignal.timeout(3_000), method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  if (!response.ok) throw new Error(`Provider fixture ${name} failed`);
};
const snapshot = async () => {
  const [account] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, 'owner@example.com'));
  const accountId = account?.id;
  const state = accountId ? (await db.select().from(syncStates).where(eq(syncStates.accountId, accountId)))[0] : null;
  const rows = accountId ? await db.select({ id: items.id, externalId: items.externalId, threadId: items.threadId,
    providerRevision: items.providerRevision, appliedSequence: items.appliedSequence, updatedAt: items.updatedAt,
    replyMetadata: items.replyMetadata })
    .from(items).where(eq(items.accountId, accountId)) : [];
  const jobs = (await db.execute(sql`select id, state, retry_count, singleton_key from pgboss.job where name = ${GMAIL_SYNC_QUEUE} order by created_on, id`)).rows;
  const sends = accountId ? await db.select({ id: outboundOperations.id, draftId: outboundOperations.draftId,
    state: outboundOperations.state }).from(outboundOperations).where(eq(outboundOperations.accountId, accountId)) : [];
  const savedDrafts = accountId ? await db.select({ id: drafts.id, bodyText: drafts.bodyText, revision: drafts.revision,
    state: drafts.state }).from(drafts).where(eq(drafts.accountId, accountId)) : [];
  const uploads = await db.select({ draftId: draftAttachments.draftId, state: draftAttachments.state,
    filename: draftAttachments.filename }).from(draftAttachments);
  const changes = accountId ? await db.select({ id: mailChangeOperations.id, state: mailChangeOperations.state,
    action: mailChangeOperations.action, completedAt: mailChangeOperations.completedAt })
    .from(mailChangeOperations).where(eq(mailChangeOperations.accountId, accountId)) : [];
  const audits = await db.select({ action: auditLog.action, targetId: auditLog.targetId }).from(auditLog);
  return { accountId, state, rows, jobs, sends, drafts: savedDrafts, uploads, changes, audits, provider: await providerState(),
    pids: { supervisor: process.pid, provider: provider.pid, parser: parser.pid, app: app?.pid, worker: worker?.pid } };
};
const actions = {
  async snapshot() { return snapshot(); },
  async hold(input) { await providerControl('hold', input); return { ok: true }; },
  async release() { await providerControl('release', {}); return { ok: true }; },
  async history() { await providerControl('history', {}); return { ok: true }; },
  async syncNow() { const id = await queue.send(GMAIL_DISCOVER_QUEUE, {}, { singletonKey: 'discovery' });
    return { id }; },
  async startWorker() { if (worker && worker.exitCode === null && !worker.signalCode) throw new Error('Worker already running');
    worker = launch('worker', 'worker'); return { pid: worker.pid }; },
  async killWorker() { await kill(worker); return { pid: worker?.pid }; },
  async expireWorker(input) {
    const jobId = String(input.jobId);
    const end = Date.now() + 40_000;
    while (Date.now() < end) {
      await queue.supervise(GMAIL_SYNC_QUEUE);
      const [job] = (await db.execute(sql`select state, retry_count from pgboss.job where id = ${jobId}`)).rows;
      if (job?.state === 'failed') {
        assert.equal(job.retry_count, 0);
        const [account] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, 'owner@example.com'));
        await db.update(syncStates).set({ leaseUntil: new Date(Date.now() - 1) }).where(eq(syncStates.accountId, account.id));
        return { jobId, state: job.state, retryCount: job.retry_count };
      }
      await delay(150);
    }
    throw new Error('Killed queue job did not expire');
  },
  async killApp() { await kill(app); return { pid: app?.pid }; },
  async staleSend(input) {
    await db.update(outboundOperations).set({ updatedAt: new Date(Date.now() - 31_000) })
      .where(eq(outboundOperations.id, String(input.operationId)));
    return { ok: true };
  },
  async staleChange(input) {
    await db.update(mailChangeOperations).set({ updatedAt: new Date(Date.now() - 31_000) })
      .where(eq(mailChangeOperations.id, String(input.operationId)));
    return { ok: true };
  },
  async startApp() { if (app && app.exitCode === null && !app.signalCode) throw new Error('App already running');
    app = launch('app-restarted', 'browser-app'); return { pid: app.pid }; },
};
const server = createHttpServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://fixture').pathname.slice(1);
    if (request.method !== 'POST' || !Object.hasOwn(actions, path)) { response.writeHead(404); response.end(); return; }
    const chunks = [];
    for await (const chunk of request) { chunks.push(chunk); if (Buffer.concat(chunks).length > 16_384) throw new Error('Control payload too large'); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const value = await actions[path](input);
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  } catch (error) {
    console.error('Browser fixture control failed', error);
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: String(error.message) }));
  }
});
let shuttingDown;
const shutdown = () => shuttingDown ??= (async () => {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await Promise.all([...children].map((child) => kill(child).catch(() => {})));
  await queue.stop({ timeout: 10_000 }).catch(() => {});
  await dbHandle.close();
})();
const onSignal = () => { void shutdown().then(() => { process.exitCode = 0; }); };
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
const portOpen = (value) => new Promise((resolve) => {
  const socket = connect(value, '127.0.0.1');
  socket.setTimeout(1_000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
});
const waitReady = async (label, probe) => {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if (await probe().catch(() => false)) return;
    await delay(100);
  }
  throw new Error(`${label} did not become ready`);
};
try {
  await waitReady('provider', () => portOpen(ports.provider));
  await waitReady('parser', () => portOpen(ports.parser));
  await waitReady('HTTPS app', () => portOpen(config.APP_PORT));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.M1_BROWSER_CONTROL_PORT ?? 8091), controlHost, resolve);
  });
  console.log('browser supervisor ready');
} catch (error) {
  await shutdown();
  throw error;
}
