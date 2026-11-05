/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fixture } from './search-writer-mapping-intent-pure.test.mjs';
import { makeWriterMappingConsumer } from '../../scripts/search-writer-mapping-consumer-core.mjs';
import { openWriterMappingApplyInput } from '../../scripts/search-writer-mapping-apply-input.mjs';
import { transferWriterMappingApplyInputs } from
  '../../scripts/search-writer-mapping-apply-transfer-core.mjs';
import { parseWriterMappingConsumerArgs, runFixedWriterMappingConsumer } from
  '../../scripts/search-writer-mapping-consumer-wrapper.mjs';
import { ensureSearchGenerationIdentity } from '../../scripts/search-generation-identity.mjs';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { issuedWriterMappingRequest } from
  '../../packages/search/dist/opensearch-writer-role-contract.js';

const date = second => new Date(`2026-10-22T18:00:${String(second).padStart(2, '0')}.123Z`);
const micro = second => `2026-10-22T18:00:${String(second).padStart(2, '0')}.123456Z`;
const insert = (rows, row) => {
  const key = item => `${item.generationToken}|${item.operation}|${item.dispatchId}`;
  const at = rows.findIndex(item => key(item) > key(row));
  rows.splice(at < 0 ? rows.length : at, 0, row);
};

function rig(options = {}) {
  const f = options.f ?? fixture(options);
  let current = structuredClone(f.attested), view = structuredClone(f.pre);
  let casCount = 0, sendCount = 0, closeCount = 0;
  const events = [];
  const approval = Object.fromEntries(['approvedSha256', 'revision', 'transitionToken',
    'sourceToken', 'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex',
    'candidateUuid'].map(key => [key, key === 'approvedSha256' ? f.sealed.sha256 :
    f.sealed.intent[key]]));
  const invocationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const context = { approval, invocationId, project: f.sealed.intent.project,
    databaseOid: f.sealed.intent.databaseOid,
    systemIdentifier: f.sealed.intent.systemIdentifier,
    databaseIdentity: structuredClone(f.attested.identity) };
  const input = () => ({ approvedSha256: f.sealed.sha256, invocationId,
    intent: structuredClone(f.sealed.intent), binding: { version: 1,
      invocationId, approvedSha256: f.sealed.sha256,
      dispatchId: f.sealed.intent.dispatchId, ownerId: f.sealed.intent.ownerId },
    createEvidence: structuredClone(f.createEvidence),
    roleEvidence: structuredClone(f.roleEvidence),
    transitionPassword: Buffer.from('a'.repeat(43)),
    priorPublicDigests: structuredClone(f.priorDigests),
    publicEvidence: structuredClone(f.publicEvidence) });
  const deps = {
    readInput: async () => {
      if (options.mutateContext && !options.mutateContext.done) {
        options.mutateContext.done = true;
        context.approval.approvedSha256 = '0'.repeat(64);
        context.systemIdentifier = 'changed';
      }
      const value = options.reader ? await options.reader.readInput() : input();
      if (options.badBinding) value.binding.ownerId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      return value;
    },
    recheckInput: async () => options.reader ? options.reader.recheck() : true,
    captureAdmin: async () => ({ public: { caSha256: f.priorDigests.find(row =>
      row.path === 'ca.pem').sha256,
    adminSha256: f.roleEvidence.intent.publicDigests.find(row =>
      row.path === 'v1/admin.pem').sha256 }, recheck: async () => true }),
    readSnapshot: async () => structuredClone(current),
    recheckSnapshot: async expected => { assert.deepEqual(expected, current); return true; },
    readState: async () => structuredClone(f.state),
    capturePriorPublic: async files => {
      if (options.mutatePublicArgument) files[0].path = 'changed';
      return options.reader ? options.reader.capturePriorPublic(files) :
        structuredClone(f.priorDigests);
    },
    captureCandidatePublic: async () => options.reader ?
      options.reader.captureCandidatePublic() : structuredClone(f.publicEvidence),
    observe: async () => structuredClone(view),
    cas: async (kind, before, operation) => {
      events.push(`cas:${kind}`); casCount++;
      assert.deepEqual(before, current);
      const next = structuredClone(current);
      next.control.revision++;
      next.control.updatedAt = date(casCount);
      next.exactTimestamps.control.updatedAt = micro(casCount);
      if (kind === 'request') next.control.stage = 'writer_mapping_requested';
      if (kind === 'arm') {
        insert(next.dispatch, { generationToken: f.sealed.intent.candidateToken,
          operation: 'writer_mapping', dispatchId: f.sealed.intent.dispatchId,
          ownerId: f.sealed.intent.ownerId, target: f.sealed.intent.target,
          bodyIdentity: f.sealed.intent.bodyIdentity, state: 'armed', createdAt: date(2) });
        insert(next.exactTimestamps.dispatch, {
          generationToken: f.sealed.intent.candidateToken, operation: 'writer_mapping',
          dispatchId: f.sealed.intent.dispatchId, createdAt: micro(2) });
      }
      const row = next.dispatch.find(item => item.generationToken ===
        f.sealed.intent.candidateToken && item.operation === 'writer_mapping');
      if (kind === 'send') row.state = 'sent_unknown';
      if (kind === 'confirm') row.state = 'response_confirmed';
      if (kind === 'attest') next.control.stage = 'writer_attested';
      assert.equal(operation?.dispatchId ?? f.sealed.intent.dispatchId,
        f.sealed.intent.dispatchId);
      current = next;
      if (options.casLost && kind === options.casLost) throw Error('private committed return');
      const returned = structuredClone(next);
      if (options.wrongArmTime && kind === 'arm')
        returned.exactTimestamps.dispatch.find(row => row.operation === 'writer_mapping')
          .createdAt = micro(9);
      return returned;
    },
    openSender: async contract => {
      const request = issuedWriterMappingRequest(contract);
      assert.equal(request.target, f.sealed.intent.target);
      if (options.openDrift) current.control.revision++;
      if (options.accessorSender) return Object.defineProperties({}, {
        sendOnce: { enumerable: true, get() { options.accessorSender.calls++; return null; } },
        close: { enumerable: true, get() { options.accessorSender.calls++; return null; } },
      });
      return { sendOnce: async () => {
        events.push('send'); sendCount++;
        if (options.sendFailure) throw Error('private original return');
        view = structuredClone(f.post);
        if (options.lostAfterEffect) throw Error('private lost return after effect');
        if (options.postDrift) view.mappings.unexpected = { users: ['other'] };
        if (options.falseAck) return { created: false };
        if (options.partialAck) return { created: true, extra: true };
        return { created: true };
      }, close: async () => {
        closeCount++;
        if (options.closeFailure) throw Error('private close sentinel');
      } };
    },
  };
  return { f, context, deps, events, get current() { return current; },
    get view() { return view; },
    get casCount() { return casCount; }, get sendCount() { return sendCount; },
    get closeCount() { return closeCount; },
    driftState() { f.state.kind = 'incomplete'; } };
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => canonicalAttestorValue(value, 256 * 1024).bytes;
const command = (name, args, cwd) => {
  const result = spawnSync(name, args, { cwd, timeout: 30_000, maxBuffer: 16_384,
    stdio: 'ignore' });
  assert.equal(result.status, 0);
};
async function realInput(t, retainedSource = false, absent = false) {
  await mkdir(path.resolve('.cache/results'), { recursive: true });
  const repository = await mkdtemp(path.resolve('.cache/results/mapping-apply-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  command(process.execPath, [path.resolve('scripts/init-search-security.mjs')], repository);
  const security = path.join(repository, '.cache/search-security');
  const generationRoot = path.join(repository, '.cache/search-generations');
  const candidateToken = '11111111-1111-4111-8111-111111111111';
  const candidate = await ensureSearchGenerationIdentity(candidateToken,
    { v1Root: security, outputRoot: generationRoot });
  let retainedFingerprints = null;
  if (retainedSource) {
    const retained = await ensureSearchGenerationIdentity(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      { v1Root: security, outputRoot: generationRoot });
    retainedFingerprints = { writer: retained.writerCertFingerprint,
      query: retained.queryCertFingerprint };
  }
  const source = fixture({ retainedSource, retainedFingerprints, absent });
  const priorBytes = new Map();
  for (const row of source.roleEvidence.intent.publicFiles) {
    const filename = row.path === 'ca.pem' ? path.join(security, 'ca.pem') :
      row.path.startsWith('v1/') ? path.join(security, row.path.slice(3)) :
        path.join(repository, '.cache/search-generations', row.path.slice('generations/'.length));
    priorBytes.set(row.path, await readFile(filename));
  }
  const candidateCa = await readFile(path.join(security, 'ca.pem'));
  const candidateWriter = await readFile(path.join(generationRoot,
    candidateToken.replaceAll('-', ''), 'writer.pem'));
  const f = fixture({ retainedSource, retainedFingerprints, absent, caPem: candidateCa,
    writerPem: candidateWriter,
    priorDigestsOverride: source.roleEvidence.intent.publicFiles.map(row =>
      ({ path: row.path, sha256: sha(priorBytes.get(row.path)) })) });
  const root = path.join(repository, 'copied');
  const scratchRoot = path.join(repository, '.cache/search-writer-mapping-apply');
  await mkdir(root, { mode: 0o700 });
  await mkdir(scratchRoot, { mode: 0o700 });
  const invocationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const entries = { 'intent.json': f.sealed.intent,
    'binding.json': { version: 1, invocationId, approvedSha256: f.sealed.sha256,
      dispatchId: f.sealed.intent.dispatchId, ownerId: f.sealed.intent.ownerId },
    'create-intent.json': f.createEvidence.intent,
    'create-binding.json': f.createEvidence.binding,
    'role-intent.json': f.roleEvidence.intent,
    'role-binding.json': f.roleEvidence.binding };
  for (const [name, value] of Object.entries(entries))
    await writeFile(path.join(root, name), canonical(value), { mode: 0o400 });
  await writeFile(path.join(root, 'transition.password'), 'a'.repeat(43), { mode: 0o400 });
  const priorRoot = path.join(root, 'prior-public');
  await mkdir(priorRoot, { mode: 0o700 });
  for (const [name, bytes] of priorBytes) {
    await mkdir(path.dirname(path.join(priorRoot, name)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(priorRoot, name), bytes, { mode: 0o400 });
  }
  const candidateRoot = path.join(root, 'candidate-public');
  const suffix = candidateToken.replaceAll('-', '');
  await mkdir(path.join(candidateRoot, 'generations', suffix),
    { recursive: true, mode: 0o700 });
  await writeFile(path.join(candidateRoot, 'ca.pem'), candidateCa, { mode: 0o400 });
  await writeFile(path.join(candidateRoot, 'generations', suffix, 'writer.pem'),
    candidateWriter, { mode: 0o400 });
  process.env.STATION_WRITER_MAPPING_APPLY_FIXTURE = '1';
  t.after(() => { delete process.env.STATION_WRITER_MAPPING_APPLY_FIXTURE; });
  const reader = await openWriterMappingApplyInput(root, scratchRoot,
    { uid: process.getuid(), gid: process.getgid() });
  return { f, reader, root, repository, security, generationRoot, candidate };
}

async function transferredInput(t, retainedSource = false, hooks = {}, skipTransfer = false) {
  const original = await realInput(t, retainedSource, retainedSource);
  const stage = path.join(original.repository, 'stage');
  await mkdir(stage, { mode: 0o700 });
  for (const name of ['prior-public', 'candidate-public'])
    await cp(path.join(original.root, name), path.join(stage, name), { recursive: true });
  const source = {}, names = {
    intentFile: 'intent.json', bindingFile: 'binding.json',
    createIntentFile: 'create-intent.json', createBindingFile: 'create-binding.json',
    roleIntentFile: 'role-intent.json', roleBindingFile: 'role-binding.json',
    passwordFile: 'transition.password',
  };
  for (const [key, name] of Object.entries(names)) {
    const parent = path.join(original.repository, `source-${key}`);
    await mkdir(parent, { mode: 0o755 });
    const file = path.join(parent, name);
    await writeFile(file, await readFile(path.join(original.root, name)), { mode: 0o400 });
    source[key] = file;
  }
  const volumeRoot = path.join(original.repository, 'volume');
  await mkdir(volumeRoot, { mode: 0o755 });
  source.publicRoot = stage;
  source.volumeRoot = volumeRoot;
  if (skipTransfer) return { ...original, source, volumeRoot };
  await transferWriterMappingApplyInputs(source, { fixture: true,
    creatorUid: process.getuid(), targetUid: process.getuid(), ...hooks });
  const reader = await openWriterMappingApplyInput(volumeRoot,
    path.join(original.repository, '.cache/search-writer-mapping-apply'),
    { uid: process.getuid(), gid: process.getgid() });
  return { ...original, source, volumeRoot, reader };
}

test('real certificate transfer feeds fixed mapping wrapper and core for both sources',
  { timeout: 180_000 }, async t => {
    for (const retainedSource of [false, true]) {
      const actual = await transferredInput(t, retainedSource);
      const r = rig({ f: actual.f, reader: actual.reader });
      const a = r.context.approval;
      const args = [a.approvedSha256, String(a.revision), a.transitionToken,
        a.sourceToken, a.sourceIndex, a.sourceUuid, a.candidateToken,
        a.candidateIndex, a.candidateUuid, r.context.invocationId,
        r.context.project, String(r.context.databaseOid), r.context.systemIdentifier];
      assert.deepEqual(await runFixedWriterMappingConsumer(
        parseWriterMappingConsumerArgs(args), { ...r.deps,
          openInput: async () => actual.reader }),
      { status: 'writer_attested', ready: false });
      assert.equal(r.casCount, 5);
      assert.equal(r.sendCount, 1);
      assert.equal(r.closeCount, 1);
      if (retainedSource)
        assert.equal(r.current.history.find(row => row.lifecycle === 'abandoned')?.indexUuid,
          null);
      assert.deepEqual((await readdir(actual.volumeRoot)).sort(),
        ['binding.json', 'candidate-public', 'create-binding.json',
          'create-intent.json', 'intent.json', 'prior-public', 'role-binding.json',
          'role-intent.json', 'transition.password']);
    }
  });

test('fixed mapping core orders five CAS results and one original response', async () => {
  const r = rig();
  const consumer = makeWriterMappingConsumer(r.context, r.deps);
  assert.deepEqual(await consumer.run(), { status: 'writer_attested', ready: false });
  assert.deepEqual(r.events, ['cas:request', 'cas:arm', 'cas:send', 'send',
    'cas:confirm', 'cas:attest']);
  assert.equal(r.casCount, 5);
  assert.equal(r.sendCount, 1);
  assert.equal(r.closeCount, 1);
  assert.equal(r.current.control.publicationEnabled, false);
  assert.equal(r.current.control.servingReady, false);
  await assert.rejects(consumer.run());
  assert.equal(r.sendCount, 1);
});

test('networkless transfer refuses late original and created-output drift',
  { timeout: 180_000 }, async t => {
    for (const fault of ['source-inventory', 'output-directory',
      'output-directory-inode', 'output-inode']) {
      const actual = await transferredInput(t, false, {}, true);
      let reached = false;
      const suffix = actual.f.sealed.intent.candidateToken.replaceAll('-', '');
      const last = `candidate-public/generations/${suffix}/writer.pem`;
      await assert.rejects(transferWriterMappingApplyInputs(actual.source, { fixture: true,
        creatorUid: process.getuid(), targetUid: process.getuid(),
        beforeSync: async relative => {
          if (relative !== last && fault !== 'output-inode' ||
              relative !== 'intent.json' && fault === 'output-inode') return;
          reached = true;
          if (fault === 'source-inventory')
            await writeFile(path.join(actual.source.publicRoot,
              'candidate-public/generations', suffix, 'unexpected'), 'x');
          else if (fault === 'output-directory')
            await chmod(path.join(actual.volumeRoot,
              'candidate-public/generations', suffix), 0o777);
          else if (fault === 'output-directory-inode') {
            const parent = path.join(actual.volumeRoot,
              'candidate-public/generations', suffix);
            await rename(parent, `${parent}-old`);
            await mkdir(parent, { mode: 0o700 });
            await rename(path.join(`${parent}-old`, 'writer.pem'),
              path.join(parent, 'writer.pem'));
          }
          else {
            const name = path.join(actual.volumeRoot, 'intent.json');
            await rename(name, `${name}.old`);
            await writeFile(name, await readFile(`${name}.old`), { mode: 0o400 });
          }
        },
      }), { message: 'Private writer mapping apply transfer failed.' });
      assert.equal(reached, true, fault);
    }
  });

test('transfer denies an extra candidate key without opening its bytes',
  { timeout: 90_000 }, async t => {
    const actual = await transferredInput(t, false, {}, true);
    const key = path.join(actual.source.publicRoot, 'candidate-public', 'private.key');
    await writeFile(key, 'PRIVATE_KEY_SENTINEL');
    const original = fs.promises.open;
    let keyReads = 0;
    try {
      fs.promises.open = (...args) => {
        if (args[0] === key) keyReads++;
        return original(...args);
      };
      syncBuiltinESMExports();
      await assert.rejects(transferWriterMappingApplyInputs(actual.source,
        { fixture: true, creatorUid: process.getuid(), targetUid: process.getuid() }),
      { message: 'Private writer mapping apply transfer failed.' });
      assert.equal(keyReads, 0);
    } finally { fs.promises.open = original; syncBuiltinESMExports(); }
  });

test('final source public leaf and output root sync remain fenced',
  { timeout: 150_000 }, async t => {
    for (const fault of ['source-final-leaf', 'output-final-root',
      'output-final-nested']) {
      const actual = await transferredInput(t, false, {}, true);
      const last = path.join(actual.source.publicRoot, 'prior-public',
        actual.f.roleEvidence.intent.publicFiles.at(-1).path);
      const outputIntent = path.join(actual.volumeRoot, 'intent.json');
      const original = fs.promises.open;
      let lastReads = 0, outputReads = 0, reached = false;
      try {
        fs.promises.open = async (...input) => {
          const handle = await original(...input);
          if (input[0] === last) {
            const close = handle.close.bind(handle);
            handle.close = async () => {
              await close(); lastReads++;
              if (fault === 'source-final-leaf' && lastReads === 3) {
                reached = true;
                await writeFile(path.join(path.dirname(last), 'unexpected'), 'x');
              }
            };
          }
          if (input[0] === outputIntent) {
            const close = handle.close.bind(handle);
            handle.close = async () => { await close(); outputReads++; };
          }
          if (input[0] === actual.volumeRoot) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
              await sync();
              if (fault.startsWith('output-final-') && outputReads >= 2 && !reached) {
                reached = true;
                if (fault === 'output-final-root') await chmod(actual.volumeRoot, 0o777);
                else await writeFile(path.join(actual.volumeRoot,
                  'candidate-public/generations',
                  actual.f.sealed.intent.candidateToken.replaceAll('-', ''),
                  'unexpected'), 'x');
              }
            };
          }
          return handle;
        };
        syncBuiltinESMExports();
        await assert.rejects(transferWriterMappingApplyInputs(actual.source,
          { fixture: true, creatorUid: process.getuid(), targetUid: process.getuid() }),
        { message: 'Private writer mapping apply transfer failed.' });
        assert.equal(reached, true, fault);
      } finally { fs.promises.open = original; syncBuiltinESMExports(); }
    }
  });

test('partial copied intent and duplicate destination are never retried or adopted',
  { timeout: 90_000 }, async t => {
    const actual = await transferredInput(t, false, {}, true);
    const name = path.join(actual.volumeRoot, 'intent.json');
    const original = fs.promises.open;
    let reached = false;
    try {
      fs.promises.open = async (...input) => {
        const handle = await original(...input);
        if (input[0] === name && !reached) {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async bytes => {
            reached = true;
            await write(Buffer.from(bytes).subarray(0, 7));
            throw Error('private partial write');
          };
        }
        return handle;
      };
      syncBuiltinESMExports();
      await assert.rejects(transferWriterMappingApplyInputs(actual.source,
        { fixture: true, creatorUid: process.getuid(), targetUid: process.getuid() }),
      { message: 'Private writer mapping apply transfer failed.' });
      assert.equal(reached, true);
    } finally { fs.promises.open = original; syncBuiltinESMExports(); }
    const before = await fs.promises.lstat(name);
    const bytes = await readFile(name);
    assert.equal(bytes.length, 7);
    await assert.rejects(transferWriterMappingApplyInputs(actual.source,
      { fixture: true, creatorUid: process.getuid(), targetUid: process.getuid() }),
    { message: 'Private writer mapping apply transfer failed.' });
    const after = await fs.promises.lstat(name);
    assert.equal(after.ino, before.ino);
    assert.deepEqual(await readFile(name), bytes);
    const healthy = await transferredInput(t);
    const originalIntent = await readFile(path.join(healthy.volumeRoot, 'intent.json'));
    await assert.rejects(transferWriterMappingApplyInputs(healthy.source,
      { fixture: true, creatorUid: process.getuid(), targetUid: process.getuid() }),
    { message: 'Private writer mapping apply transfer failed.' });
    assert.deepEqual(await readFile(path.join(healthy.volumeRoot, 'intent.json')),
      originalIntent);
  });

test('fixed wrapper pins independent context and rejects actual database identity drift',
  async () => {
    const positive = rig();
    const context = positive.context;
    const copy = {
      readInput: positive.deps.readInput,
      recheck: positive.deps.recheckInput,
      capturePriorPublic: positive.deps.capturePriorPublic,
      captureCandidatePublic: positive.deps.captureCandidatePublic,
    };
    const adapters = { ...positive.deps, openInput: async () => {
      context.project = 'changed-after-await';
      context.approval.approvedSha256 = '0'.repeat(64);
      return copy;
    } };
    assert.deepEqual(await runFixedWriterMappingConsumer(context, adapters),
      { status: 'writer_attested', ready: false });
    assert.equal(positive.casCount, 5);
    assert.equal(positive.sendCount, 1);

    const negative = rig();
    let snapshotReached = false;
    const readSnapshot = negative.deps.readSnapshot;
    const bad = { ...negative.deps,
      openInput: async () => ({ readInput: negative.deps.readInput,
        recheck: negative.deps.recheckInput,
        capturePriorPublic: negative.deps.capturePriorPublic,
        captureCandidatePublic: negative.deps.captureCandidatePublic }),
      readSnapshot: async () => {
        snapshotReached = true;
        const value = await readSnapshot();
        value.identity.databaseOid++;
        return value;
      } };
    await assert.rejects(runFixedWriterMappingConsumer(negative.context, bad),
      { message: 'Private writer mapping apply failed.' });
    assert.equal(snapshotReached, true);
    assert.equal(negative.casCount, 0);
    assert.equal(negative.sendCount, 0);
  });

test('retained v2 and absent history survive mapping execution', async () => {
  const r = rig({ retainedSource: true, absent: true });
  assert.deepEqual(await makeWriterMappingConsumer(r.context, r.deps).run(),
    { status: 'writer_attested', ready: false });
  assert.equal(r.current.history.find(row => row.lifecycle === 'abandoned').indexUuid, null);
});

test('lost original mapping response never confirms or retries', async () => {
  const r = rig({ sendFailure: true });
  await assert.rejects(makeWriterMappingConsumer(r.context, r.deps).run(),
    /Private writer mapping apply failed/);
  assert.equal(r.casCount, 3);
  assert.equal(r.sendCount, 1);
  assert.equal(r.closeCount, 1);
  assert.equal(r.current.dispatch.find(row => row.operation === 'writer_mapping').state,
    'sent_unknown');
});

test('lost return after an observed post-state effect still cannot confirm', async () => {
  const r = rig({ lostAfterEffect: true });
  await assert.rejects(makeWriterMappingConsumer(r.context, r.deps).run(),
    /Private writer mapping apply failed/);
  assert.equal(r.casCount, 3);
  assert.equal(r.sendCount, 1);
  assert.equal(r.closeCount, 1);
  assert.equal(Object.hasOwn(r.view.mappings, r.f.sealed.intent.target), true);
  assert.equal(r.current.dispatch.find(row => row.operation === 'writer_mapping').state,
    'sent_unknown');
});

test('false and partial original acknowledgments never confirm', async () => {
  for (const option of ['falseAck', 'partialAck']) {
    const r = rig({ [option]: true });
    await assert.rejects(makeWriterMappingConsumer(r.context, r.deps).run(),
      /Private writer mapping apply failed/);
    assert.equal(r.casCount, 3);
    assert.equal(r.sendCount, 1);
    assert.equal(r.closeCount, 1);
    assert.equal(r.current.dispatch.find(row => row.operation === 'writer_mapping').state,
      'sent_unknown');
  }
});

test('committed CAS with lost return stops before the next action', async () => {
  const r = rig({ casLost: 'send' });
  await assert.rejects(makeWriterMappingConsumer(r.context, r.deps).run(),
    /Private writer mapping apply failed/);
  assert.equal(r.casCount, 3);
  assert.equal(r.sendCount, 0);
  assert.equal(r.current.dispatch.find(row => row.operation === 'writer_mapping').state,
    'sent_unknown');
});

test('sender-open drift is rejected after sent_unknown before any PUT', async () => {
  const r = rig({ openDrift: true });
  await assert.rejects(makeWriterMappingConsumer(r.context, r.deps).run(),
    /Private writer mapping apply failed/);
  assert.equal(r.casCount, 3);
  assert.equal(r.sendCount, 0);
  assert.equal(r.closeCount, 1);
});

test('wrong arm microtime rejects before sender creation', async () => {
  const r = rig({ wrongArmTime: true });
  await assert.rejects(makeWriterMappingConsumer(r.context, r.deps).run(),
    /Private writer mapping apply failed/);
  assert.equal(r.casCount, 2);
  assert.equal(r.sendCount, 0);
});

test('postsend extra security resource stops confirmation', async () => {
  const r = rig({ postDrift: true });
  await assert.rejects(makeWriterMappingConsumer(r.context, r.deps).run(),
    /Private writer mapping apply failed/);
  assert.equal(r.casCount, 3);
  assert.equal(r.sendCount, 1);
  assert.equal(r.closeCount, 1);
});

test('rejected sender accessors never run during cleanup', async () => {
  const accessorSender = { calls: 0 };
  const r = rig({ accessorSender });
  await assert.rejects(makeWriterMappingConsumer(r.context, r.deps).run(),
    /Private writer mapping apply failed/);
  assert.equal(accessorSender.calls, 0);
  assert.equal(r.sendCount, 0);
});

test('validated close failure is finite and cannot report success', async () => {
  const r = rig({ closeFailure: true });
  await assert.rejects(makeWriterMappingConsumer(r.context, r.deps).run(),
    { message: 'Private writer mapping apply failed.' });
  assert.equal(r.casCount, 5);
  assert.equal(r.closeCount, 1);
});

test('independent approval and context are pinned before awaited input', async () => {
  const mutateContext = { done: false };
  const r = rig({ mutateContext });
  assert.deepEqual(await makeWriterMappingConsumer(r.context, r.deps).run(),
    { status: 'writer_attested', ready: false });
  assert.equal(mutateContext.done, true);
  assert.equal(r.sendCount, 1);
});

test('caller-supplied copied binding cannot retarget original owner', async () => {
  const r = rig({ badBinding: true });
  await assert.rejects(makeWriterMappingConsumer(r.context, r.deps).run(),
    /Private writer mapping apply failed/);
  assert.equal(r.casCount, 0);
  assert.equal(r.sendCount, 0);
});

test('public callback receives a copy of the immutable prior file list', async () => {
  const r = rig({ mutatePublicArgument: true });
  assert.deepEqual(await makeWriterMappingConsumer(r.context, r.deps).run(),
    { status: 'writer_attested', ready: false });
  assert.equal(r.sendCount, 1);
});

test('accessor authority is rejected synchronously before copied input access', () => {
  const r = rig();
  let getters = 0, reads = 0;
  const context = { ...r.context };
  Object.defineProperty(context, 'approval', { enumerable: true,
    get() { getters++; return r.context.approval; } });
  r.deps.readInput = async () => { reads++; throw Error('unexpected I/O'); };
  assert.throws(() => makeWriterMappingConsumer(context, r.deps));
  assert.equal(getters, 0);
  assert.equal(reads, 0);
});

test('real copied certificates and old evidence feed the fixed core',
  { timeout: 120_000 }, async t => {
    for (const retainedSource of [false, true]) {
      const actual = await realInput(t, retainedSource);
      const candidateNames = await readdir(path.join(actual.root, 'candidate-public/generations',
        actual.f.sealed.intent.candidateToken.replaceAll('-', '')));
      assert.deepEqual(candidateNames, ['writer.pem']);
      if (retainedSource) {
        const retainedQuery = path.join(actual.root, 'prior-public/generations',
          'cccccccccccc4ccc8ccccccccccccccc', 'query.pem');
        assert.equal((await readFile(retainedQuery)).length > 100, true);
      }
      const input = await actual.reader.readInput();
      assert.equal(input.approvedSha256, actual.f.sealed.sha256);
      assert.equal(await actual.reader.recheck(), true);
      input.intent.target = 'changed';
      assert.equal((await actual.reader.readInput()).intent.target,
        actual.f.sealed.intent.target);
      const r = rig({ f: actual.f, reader: actual.reader });
      assert.deepEqual(await makeWriterMappingConsumer(r.context, r.deps).run(),
        { status: 'writer_attested', ready: false });
      assert.equal(r.casCount, 5);
      assert.equal(r.sendCount, 1);
    }
  });

test('last awaited candidate PEM read cannot hide a new inventory leaf',
  { timeout: 90_000 }, async t => {
    const actual = await realInput(t);
    const suffix = actual.f.sealed.intent.candidateToken.replaceAll('-', '');
    const candidateDir = path.join(actual.root, 'candidate-public/generations', suffix);
    const writer = path.join(candidateDir, 'writer.pem');
    const originalOpen = fs.promises.open;
    let reached = false;
    try {
      fs.promises.open = async (name, ...args) => {
        const handle = await originalOpen(name, ...args);
        if (name === writer && !reached) {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            reached = true;
            await writeFile(path.join(candidateDir, 'unexpected'), 'x');
          };
        }
        return handle;
      };
      syncBuiltinESMExports();
      await assert.rejects(actual.reader.recheck());
      assert.equal(reached, true);
      assert.equal((await readdir(candidateDir)).includes('unexpected'), true);
    } finally {
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
    }
  });

test('last awaited prior public leaf cannot hide a new sibling',
  { timeout: 90_000 }, async t => {
    const actual = await realInput(t);
    const priorFiles = actual.f.roleEvidence.intent.publicFiles;
    const last = path.join(actual.root, 'prior-public', priorFiles.at(-1).path);
    const originalOpen = fs.promises.open;
    let reads = 0, reached = false;
    try {
      fs.promises.open = async (name, ...args) => {
        const handle = await originalOpen(name, ...args);
        if (name === last) {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            reads++;
            if (reads === 2) {
              reached = true;
              await writeFile(path.join(path.dirname(last), 'unexpected'), 'x');
            }
          };
        }
        return handle;
      };
      syncBuiltinESMExports();
      await assert.rejects(actual.reader.recheck());
      assert.equal(reached, true);
      assert.equal((await readdir(path.dirname(last))).includes('unexpected'), true);
    } finally {
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
    }
  });

test('canonical binding with numeric invocation is denied before public validation',
  { timeout: 90_000 }, async t => {
    const actual = await realInput(t);
    const name = path.join(actual.root, 'binding.json');
    const value = JSON.parse((await readFile(name)).toString('utf8'));
    value.invocationId = 42;
    await chmod(name, 0o600);
    await writeFile(name, canonical(value));
    await chmod(name, 0o400);
    await assert.rejects(openWriterMappingApplyInput(actual.root,
      path.join(actual.repository, '.cache/search-writer-mapping-apply'),
      { uid: process.getuid(), gid: process.getgid() }),
    { message: 'Private writer mapping apply input failed.' });
  });

test('copied root parent replacement rejects with original child and scratch restored',
  { timeout: 90_000 }, async t => {
    const actual = await realInput(t);
    const moved = `${actual.repository}-old`;
    t.after(() => rm(moved, { recursive: true, force: true }));
    await rename(actual.repository, moved);
    await mkdir(actual.repository, { mode: 0o700 });
    await rename(path.join(moved, 'copied'), actual.root);
    await rename(path.join(moved, '.cache'), path.join(actual.repository, '.cache'));
    await assert.rejects(actual.reader.recheck());
  });

test('candidate key leaf is denied without opening its content',
  { timeout: 90_000 }, async t => {
    const actual = await realInput(t);
    const suffix = actual.f.sealed.intent.candidateToken.replaceAll('-', '');
    const key = path.join(actual.root, 'candidate-public/generations', suffix, 'writer.key');
    await writeFile(key, 'private sentinel', { mode: 0o400 });
    const originalOpen = fs.promises.open;
    let keyReads = 0;
    try {
      fs.promises.open = async (name, ...args) => {
        if (name === key) { keyReads++; throw Error('key read'); }
        return originalOpen(name, ...args);
      };
      syncBuiltinESMExports();
      await assert.rejects(openWriterMappingApplyInput(actual.root,
        path.join(actual.repository, '.cache/search-writer-mapping-apply'),
        { uid: process.getuid(), gid: process.getgid() }));
      assert.equal(keyReads, 0);
      assert.equal((await readdir(path.dirname(key))).includes('writer.key'), true);
    } finally {
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
    }
  });
