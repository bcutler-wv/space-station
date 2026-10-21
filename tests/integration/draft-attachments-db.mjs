import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { generate } from 'otplib';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../apps/server/dist/app.js';
import { authStore, digest } from '../../apps/server/dist/auth-store.js';
import { accounts, collectDraftAttachmentBlobs, databaseUrl, draftAttachments, loadRuntimeConfig, oauthApps, openDatabase, orbits, PrivateBlobStore } from '../../packages/db/dist/index.js';

const origin = 'https://example.com';
const key = randomBytes(32);
const dbUrl = process.env.ATTACHMENT_TEST_DATABASE_URL ?? databaseUrl(loadRuntimeConfig(process.env));
assert.ok(dbUrl);
const opened = openDatabase(dbUrl);
const db = opened.db;
const localArtifacts = path.join(process.cwd(), '.cache', 'test-results');
await mkdir(localArtifacts, { recursive: true });
const root = process.env.ATTACHMENT_TEST_BLOB_ROOT ?? await mkdtemp(path.join(localArtifacts, 'draft-attachments-'));
const blobs = path.join(root, 'blobs');
await mkdir(blobs, { recursive: true });
const store = new PrivateBlobStore(blobs);
const auth = authStore(db);
const app = buildApp(async () => {}, undefined, { db, origin, masterKey: key, store: auth }, { trustedProxyIp: '127.0.0.1' }, store);
let cookie = '';
const call = async (method, url, payload, csrf, extra = {}) => {
  const response = await app.inject({ method, url, ...(payload !== undefined ? { payload } : {}), remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin, 'x-csrf-token': csrf }), ...extra } });
  const set = response.headers['set-cookie'];
  if (set) cookie = (Array.isArray(set) ? set[0] : set).split(';')[0];
  return response;
};
const id = () => randomUUID();
const draftBody = (draftId, creationKey, accountId, orbitId) => ({ id: draftId, creationKey, accountId, orbitId,
  to: [], cc: [], bcc: [], subject: '', bodyText: '', attachmentRefs: [] });
const upload = (draftId, accountId, revision, bytes, csrf, uploadKey = id(), name = 'café.txt', extra = {}) =>
  call('POST', `/api/mail/drafts/${draftId}/attachments?accountId=${accountId}`, bytes, csrf,
    { 'content-type': 'application/octet-stream', 'x-attachment-name': encodeURIComponent(name), 'x-upload-key': uploadKey,
      'x-draft-revision': String(revision), ...extra });
try {
  await app.ready();
  assert.equal((await call('GET', `/api/mail/drafts/${id()}/attachments?accountId=${id()}`)).statusCode, 401);
  const bootstrap = randomBytes(32).toString('base64url');
  await auth.issueBootstrap(digest(bootstrap), new Date(Date.now() + 60_000));
  let csrf = (await call('GET', '/api/auth/status')).json().csrfToken;
  const enrolled = await call('POST', '/api/auth/bootstrap/password', { bootstrapToken: bootstrap,
    displayName: 'Example Owner', password: 'Example-only-password-123!' }, csrf);
  assert.equal(enrolled.statusCode, 200, enrolled.body);
  csrf = (await call('GET', '/api/auth/status')).json().csrfToken;
  const secret = new URL(enrolled.json().totpUri).searchParams.get('secret');
  assert.equal((await call('POST', '/api/auth/bootstrap/totp', { code: await generate({ secret }) }, csrf)).statusCode, 200);
  csrf = (await call('GET', '/api/auth/status')).json().csrfToken;
  const orbitA = id(), orbitB = id(), accountA = id(), accountB = id(), appId = id(), draftA = id(), draftB = id();
  await db.insert(orbits).values([{ id: orbitA, name: 'Example A', slug: 'attachment-a', colorSlot: 1, context: '', privacyDefaults: { index: 'deny', ai: 'deny' } },
    { id: orbitB, name: 'Example B', slug: 'attachment-b', colorSlot: 2, context: '', privacyDefaults: { index: 'deny', ai: 'deny' } }]);
  await db.insert(oauthApps).values({ id: appId, provider: 'google', ownerId: 'owner', clientId: 'fixture', encryptedClientSecret: 'private-secret', redirectUri: `${origin}/api/google/callback` });
  await db.insert(accounts).values([{ id: accountA, provider: 'google', appId, orbitId: orbitA, email: 'owner@example.com', encryptedRefreshToken: 'x', encryptedAccessToken: 'x', grantedScopes: [] },
    { id: accountB, provider: 'google', appId, orbitId: orbitB, email: 'other@example.com', encryptedRefreshToken: 'x', encryptedAccessToken: 'x', grantedScopes: [] }]);
  assert.equal((await call('POST', '/api/mail/drafts', draftBody(draftA, id(), accountA, orbitA), csrf)).statusCode, 201);
  assert.equal((await call('POST', '/api/mail/drafts', draftBody(draftB, id(), accountB, orbitB), csrf)).statusCode, 201);
  const bytes = Buffer.from('example attachment bytes');
  const unicodeDraft = id();
  assert.equal((await call('POST', '/api/mail/drafts', draftBody(unicodeDraft, id(), accountB, orbitB), csrf)).statusCode, 201);
  const longName = `${'a'.repeat(150)}${'😀'.repeat(30)}`;
  const expectedName = `${'a'.repeat(150)}${'😀'.repeat(15)}`;
  const unicodeUpload = await upload(unicodeDraft, accountB, 1, bytes, csrf, id(), longName);
  assert.equal(unicodeUpload.statusCode, 201, unicodeUpload.body);
  assert.equal(unicodeUpload.json().attachment.filename, expectedName);
  const unicodeList = await call('GET', `/api/mail/drafts/${unicodeDraft}/attachments?accountId=${accountB}`);
  assert.equal(unicodeList.statusCode, 200, unicodeList.body);
  assert.equal(unicodeList.json().attachments[0].filename, expectedName);
  const unicodeDownload = await call('GET', `/api/mail/drafts/${unicodeDraft}/attachments/${unicodeUpload.json().attachment.id}/download?accountId=${accountB}`);
  assert.equal(unicodeDownload.statusCode, 200, unicodeDownload.body);
  assert.deepEqual(unicodeDownload.rawPayload, bytes);
  assert.match(unicodeDownload.headers['content-disposition'], /filename\*=UTF-8''/);
  const uploadKey = id();
  assert.equal((await upload(draftA, accountA, 1, bytes, '', uploadKey)).statusCode, 403);
  assert.equal((await upload(draftA, accountA, 1, bytes, csrf, uploadKey, 'café.txt', { origin: 'https://other.example.com' })).statusCode, 403);
  assert.equal((await upload(draftA, accountB, 1, bytes, csrf, uploadKey)).statusCode, 404);
  assert.equal((await call('GET', `/api/mail/drafts/${draftA}/attachments?accountId=${accountA}&orbitId=${orbitB}`)).statusCode, 404);
  const first = await upload(draftA, accountA, 1, bytes, csrf, uploadKey, '../café.txt');
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().revision, 2);
  const attachmentId = first.json().attachment.id;
  assert.equal(first.json().attachment.filename.includes('/'), false);
  assert.equal((await upload(draftA, accountA, 1, bytes, csrf, uploadKey, '../café.txt')).statusCode, 200);
  assert.equal((await upload(draftA, accountA, 2, Buffer.from('changed'), csrf, uploadKey, '../café.txt')).statusCode, 409);
  assert.equal((await upload(draftA, accountA, 1, bytes, csrf)).statusCode, 409);
  assert.equal((await upload(draftA, accountA, 2, Buffer.alloc(8 * 1024 * 1024), csrf)).statusCode, 413);
  assert.equal((await upload(draftA, accountA, 2, Buffer.alloc(8 * 1024 * 1024 + 1), csrf)).statusCode, 413);
  assert.equal((await call('GET', `/api/mail/drafts/${draftB}/attachments/${attachmentId}/download?accountId=${accountB}`)).statusCode, 404);
  assert.equal((await call('GET', `/api/mail/drafts/${draftA}/attachments/${attachmentId}/download?accountId=${accountA}&orbitId=${orbitB}`)).statusCode, 404);
  assert.equal((await call('GET', `/api/mail/drafts/${draftA}/attachments/${attachmentId}/download?accountId=${accountA}`, undefined, undefined,
    { origin: 'https://other.example.com' })).statusCode, 403);
  const downloaded = await call('GET', `/api/mail/drafts/${draftA}/attachments/${attachmentId}/download?accountId=${accountA}`);
  assert.equal(downloaded.statusCode, 200, downloaded.body);
  assert.deepEqual(downloaded.rawPayload, bytes);
  assert.equal(downloaded.headers['content-type'], 'application/octet-stream');
  assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
  assert.match(downloaded.headers['content-disposition'], /^attachment;/);
  const restarted = buildApp(async () => {}, undefined, { db, origin, masterKey: key, store: auth },
    { trustedProxyIp: '127.0.0.1' }, store);
  await restarted.ready();
  try {
    const afterRestart = await restarted.inject({ method: 'GET',
      url: `/api/mail/drafts/${draftA}/attachments/${attachmentId}/download?accountId=${accountA}`,
      remoteAddress: '127.0.0.1', headers: { 'x-forwarded-proto': 'https', cookie } });
    assert.equal(afterRestart.statusCode, 200, afterRestart.body);
    assert.deepEqual(afterRestart.rawPayload, bytes);
  } finally { await restarted.close(); }
  assert.equal((await collectDraftAttachmentBlobs(db, store, 0)).valueOf(), 0);
  const stale = await call('PUT', `/api/mail/drafts/${draftA}?accountId=${accountA}`,
    { to: [], cc: [], bcc: [], subject: '', bodyText: '', attachmentRefs: [], revision: 2 }, csrf);
  assert.equal(stale.statusCode, 409);
  assert.equal((await call('DELETE', `/api/mail/drafts/${draftA}/attachments/${attachmentId}?accountId=${accountA}`, { revision: 2 }, '')).statusCode, 403);
  const remove = await call('DELETE', `/api/mail/drafts/${draftA}/attachments/${attachmentId}?accountId=${accountA}`, { revision: 2 }, csrf);
  assert.equal(remove.statusCode, 200, remove.body);
  assert.equal((await call('DELETE', `/api/mail/drafts/${draftA}/attachments/${attachmentId}?accountId=${accountA}`, { revision: 2 }, csrf)).statusCode, 200);
  assert.equal((await call('GET', `/api/mail/drafts/${draftA}/attachments/${attachmentId}/download?accountId=${accountA}`)).statusCode, 404);
  assert.equal((await call('PUT', `/api/mail/drafts/${draftA}?accountId=${accountA}`,
    { to: [], cc: [], bcc: [], subject: '', bodyText: '', attachmentRefs: [attachmentId], revision: 2 }, csrf)).statusCode, 409);
  assert.equal(await collectDraftAttachmentBlobs(db, store, 0), 1);
  assert.equal((await db.select().from(draftAttachments).where(eq(draftAttachments.id, attachmentId))).length, 0);
  const again = await upload(draftA, accountA, 3, bytes, csrf);
  assert.equal(again.statusCode, 201, again.body);
  assert.equal((await call('POST', `/api/mail/drafts/${draftA}/discard?accountId=${accountA}`, { revision: 4 }, csrf)).statusCode, 200);
  assert.equal(await collectDraftAttachmentBlobs(db, store, 0), 1);
  assert.equal((await db.select().from(draftAttachments).where(eq(draftAttachments.draftId, draftA))).length, 0);
  // A crashed writer leaves a durable pending row and deterministic temporary name.
  const orphanKey = PrivateBlobStore.generateKey();
  await db.insert(draftAttachments).values({ id: id(), draftId: draftB, accountId: accountB,
    blobKey: orphanKey, uploadKey: id(), digest: '0'.repeat(64), filename: 'orphan', byteSize: 1 });
  assert.equal(await collectDraftAttachmentBlobs(db, store, 0), 1);
  assert.equal((await db.select().from(draftAttachments).where(eq(draftAttachments.blobKey, orphanKey))).length, 0);
  const lockedKey = PrivateBlobStore.generateKey(), lockedId = id();
  await db.insert(draftAttachments).values({ id: lockedId, draftId: draftB, accountId: accountB,
    blobKey: lockedKey, uploadKey: id(), digest: '0'.repeat(64), filename: 'locked', byteSize: 1 });
  let unlock;
  const held = db.transaction(async (tx) => {
    await tx.select().from(draftAttachments).where(eq(draftAttachments.id, lockedId)).for('update');
    await new Promise((resolve) => { unlock = resolve; });
  });
  while (!unlock) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(await collectDraftAttachmentBlobs(db, store, 0), 0);
  unlock();
  await held;
  assert.equal(await collectDraftAttachmentBlobs(db, store, 0), 1);
  const fullId = id();
  assert.equal((await call('POST', '/api/mail/drafts', draftBody(fullId, id(), accountA, orbitA), csrf)).statusCode, 201);
  let publishStarted, resumePublish;
  const publishing = new Promise((resolve) => { publishStarted = resolve; });
  const paused = new Promise((resolve) => { resumePublish = resolve; });
  class PausedBlobStore extends PrivateBlobStore {
    async writeReserved(blobKey, content, signal) {
      publishStarted();
      await paused;
      return super.writeReserved(blobKey, content, signal);
    }
  }
  const heldApp = buildApp(async () => {}, undefined, { db, origin, masterKey: key, store: auth },
    { trustedProxyIp: '127.0.0.1' }, new PausedBlobStore(blobs));
  await heldApp.ready();
  try {
    const firstPending = heldApp.inject({ method: 'POST',
      url: `/api/mail/drafts/${fullId}/attachments?accountId=${accountA}`,
      payload: Buffer.alloc(5 * 1024 * 1024, 1), remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-proto': 'https', cookie, origin, 'x-csrf-token': csrf,
        'content-type': 'application/octet-stream', 'x-attachment-name': 'first.bin',
        'x-upload-key': id(), 'x-draft-revision': '1' } });
    await publishing;
    assert.equal((await upload(fullId, accountA, 1, Buffer.alloc(5 * 1024 * 1024, 2), csrf)).statusCode, 413);
    assert.equal(await collectDraftAttachmentBlobs(db, store, 0), 0);
    resumePublish();
    const finished = await firstPending;
    assert.equal(finished.statusCode, 201, finished.body);
  } finally { resumePublish(); await heldApp.close(); }
  const countId = id();
  assert.equal((await call('POST', '/api/mail/drafts', draftBody(countId, id(), accountA, orbitA), csrf)).statusCode, 201);
  for (let revision = 1; revision <= 64; revision++) {
    const response = await upload(countId, accountA, revision, Buffer.alloc(0), csrf);
    assert.equal(response.statusCode, 201, `${revision}: ${response.body}`);
  }
  assert.equal((await upload(countId, accountA, 65, Buffer.alloc(0), csrf)).statusCode, 413);
  const linkId = id(), linkKey = PrivateBlobStore.generateKey();
  await symlink(path.join(root, 'outside'), path.join(blobs, linkKey));
  await db.insert(draftAttachments).values({ id: linkId, draftId: draftB, accountId: accountB, blobKey: linkKey,
    uploadKey: id(), digest: '0'.repeat(64), filename: 'symlink', byteSize: 1, state: 'ready' });
  assert.equal((await call('GET', `/api/mail/drafts/${draftB}/attachments/${linkId}/download?accountId=${accountB}`)).statusCode, 503);
  console.log('draft attachment PostgreSQL HTTP/filesystem fixture passed');
} finally {
  await app.close();
  await opened.close();
  await rm(root, { recursive: true, force: true });
}
