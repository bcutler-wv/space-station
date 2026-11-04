/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { parseWriterMappingPrepareInput } from '../../scripts/search-writer-mapping-prepare-input.mjs';
import { parseWriterMappingPrepareOutput } from '../../scripts/search-writer-mapping-prepare-output.mjs';
import { runWriterMappingPrepare } from '../../scripts/search-writer-mapping-prepare-core.mjs';
import { fixture } from './search-writer-mapping-intent-pure.test.mjs';

const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const encoded = value => canonicalAttestorValue(value).bytes;
const make = (options = {}) => {
  const f = fixture(options);
  const invocation = { version: 1, project: f.roleEvidence.intent.project,
    databaseOid: f.roleEvidence.intent.databaseOid,
    systemIdentifier: f.roleEvidence.intent.systemIdentifier,
    invocationId: id, dispatchId: f.sealed.intent.dispatchId,
    ownerId: f.sealed.intent.ownerId };
  const expected = { ...invocation, createApprovedSha256: f.createEvidence.approvedSha256,
    roleApprovedSha256: f.roleEvidence.approvedSha256 };
  delete expected.version;
  const files = { intent: encoded(f.roleEvidence.intent).toString('hex'),
    binding: encoded(f.roleEvidence.binding).toString('hex'),
    createIntent: encoded(f.createEvidence.intent).toString('hex'),
    createBinding: encoded(f.createEvidence.binding).toString('hex') };
  const value = { invocation, files, priorPublicDigests: f.priorDigests,
    publicEvidence: f.publicEvidence };
  const bytes = encoded(value);
  const adminPublic = { caSha256: f.priorDigests.find(x => x.path === 'ca.pem').sha256,
    adminSha256: f.priorDigests.find(x => x.path === 'v1/admin.pem').sha256 };
  const current = { state: structuredClone(f.state), snapshot: structuredClone(f.attested),
    observed: structuredClone(f.pre), bytes, adminPublic: structuredClone(adminPublic) };
  const counts = { input: 0, state: 0, snapshot: 0, observed: 0,
    admin: 0, recheck: 0 };
  const deps = {
    readInputBytes: async () => { counts.input++; return current.bytes; },
    recheckInput: async () => { counts.recheck++; return true; },
    readState: async () => { counts.state++; return current.state; },
    readSnapshot: async () => { counts.snapshot++; return current.snapshot; },
    recheckSnapshot: async baseline =>
      encoded(baseline).equals(encoded(f.attested)),
    observe: async () => { counts.observed++; return current.observed; },
    captureAdminPublic: async () => { counts.admin++; return { public: current.adminPublic,
      recheck: async () => true }; },
  };
  return { f, expected, bytes, adminPublic, current, counts, deps };
};

for (const options of [{}, { retainedSource: true, absent: true }]) {
  test(`fixed mapping read core seals one exact attested baseline ${JSON.stringify(options)}`,
    async () => {
      const x = make(options);
      const output = await runWriterMappingPrepare(x.bytes, x.expected, x.deps);
      const parsed = parseWriterMappingPrepareOutput(output, x.bytes, x.expected,
        x.adminPublic);
      assert.equal(parsed.sha256, x.f.sealed.sha256);
      assert.equal(parsed.intent.candidateUuid, x.f.sealed.intent.candidateUuid);
      assert.equal(x.counts.snapshot, 5);
      assert.equal(x.counts.observed, 5);
      assert.equal(x.counts.recheck >= 8, true);
    });
}

test('independent old approvals and strict canonical input reject before reads', async () => {
  const x = make();
  for (const changed of [
    { ...x.expected, roleApprovedSha256: '0'.repeat(64) },
    { ...x.expected, createApprovedSha256: '0'.repeat(64) },
    { ...x.expected, dispatchId: x.f.roleEvidence.intent.dispatchId },
  ]) {
    assert.throws(() => parseWriterMappingPrepareInput(x.bytes, changed));
    await assert.rejects(runWriterMappingPrepare(x.bytes, changed, x.deps));
    assert.equal(x.counts.snapshot, 0);
  }
  assert.throws(() => parseWriterMappingPrepareInput(Buffer.concat([x.bytes,
    Buffer.from(' ')]), x.expected));
  let reads = 0;
  const hostile = { ...x.expected };
  Object.defineProperty(hostile, 'project', { enumerable: true,
    get() { reads++; throw Error('private'); } });
  assert.throws(() => parseWriterMappingPrepareInput(x.bytes, hostile));
  assert.equal(reads, 0);
});

test('read changes and prior returned-object mutation cannot rebase original', async () => {
  for (const kind of ['snapshot-micro', 'engine', 'state', 'input', 'admin',
    'returned-snapshot']) {
    const x = make();
    const original = x.deps.recheckSnapshot;
    x.deps.recheckSnapshot = async baseline => {
      if (kind === 'snapshot-micro')
        x.current.snapshot.exactTimestamps.control.updatedAt =
          '2026-10-22T18:00:00.123457Z';
      if (kind === 'engine') x.current.observed.roles.extraneous = {};
      if (kind === 'state') x.current.state.phase = 'missing';
      if (kind === 'input') x.current.bytes = Buffer.from('{}');
      if (kind === 'admin') x.current.adminPublic.adminSha256 = '0'.repeat(64);
      if (kind === 'returned-snapshot') {
        baseline.control.revision = 99;
        x.current.snapshot.control.revision = 99;
      }
      return original(baseline);
    };
    await assert.rejects(runWriterMappingPrepare(x.bytes, x.expected, x.deps),
      /Private writer mapping preparation failed/);
    assert.equal(x.counts.snapshot >= 1, true, kind);
  }
});

test('late fences reject same-millisecond microsecond drift without output', async () => {
  for (const reached of [3, 5, 7]) {
    const x = make();
    const original = x.deps.recheckSnapshot;
    let calls = 0;
    x.deps.recheckSnapshot = async baseline => {
      calls++;
      if (calls === reached)
        x.current.snapshot.exactTimestamps.control.updatedAt =
          '2026-10-22T18:00:00.123457Z';
      return original(baseline);
    };
    await assert.rejects(runWriterMappingPrepare(x.bytes, x.expected, x.deps),
      /Private writer mapping preparation failed/);
    assert.equal(calls, reached);
    assert.equal(x.counts.snapshot, (reached + 3) / 2);
  }
});

test('caller mutation during an awaited read cannot change pinned approval or input', async () => {
  const x = make();
  const original = x.deps.readState;
  x.deps.readState = async () => {
    x.expected.roleApprovedSha256 = '0'.repeat(64);
    x.bytes.fill(32);
    return original();
  };
  await assert.rejects(runWriterMappingPrepare(x.bytes, x.expected, x.deps),
    /Private writer mapping preparation failed/);
  assert.equal(x.counts.state, 1);
  assert.equal(x.counts.snapshot, 1);
});

test('expected-only caller mutation cannot change the pinned approved SHAs', async () => {
  const x = make();
  const originalExpected = structuredClone(x.expected);
  const original = x.deps.readState;
  x.deps.readState = async () => {
    x.expected.roleApprovedSha256 = '0'.repeat(64);
    x.expected.createApprovedSha256 = '0'.repeat(64);
    return original();
  };
  const output = await runWriterMappingPrepare(x.bytes, x.expected, x.deps);
  const parsed = parseWriterMappingPrepareOutput(output, x.bytes, originalExpected,
    x.adminPublic);
  assert.equal(parsed.sha256, x.f.sealed.sha256);
  assert.equal(x.counts.snapshot, 5);
});

test('a recheck may mutate only its defensive baseline copy without rebasing', async () => {
  const x = make();
  let calls = 0;
  x.deps.recheckSnapshot = async baseline => {
    calls++;
    baseline.control.revision = 999;
    baseline.exactTimestamps.control.updatedAt = '2026-10-22T18:00:00.123457Z';
    return true;
  };
  const output = await runWriterMappingPrepare(x.bytes, x.expected, x.deps);
  const parsed = parseWriterMappingPrepareOutput(output, x.bytes, x.expected,
    x.adminPublic);
  assert.equal(parsed.sha256, x.f.sealed.sha256);
  assert.equal(calls, 8);
  assert.equal(x.current.snapshot.control.revision, 12);
});

test('output parser refuses altered body, extra keys and self-rehashed old approval', async () => {
  const x = make();
  const output = await runWriterMappingPrepare(x.bytes, x.expected, x.deps);
  const raw = JSON.parse(output.toString('utf8'));
  for (const mutate of [v => { v.intent.bodySha256 = '0'.repeat(64); },
    v => { v.intent.bodyIdentity = '0'.repeat(64); },
    v => { v.extra = true; }, v => { v.intent.roleApprovedSha256 = '0'.repeat(64); }]) {
    const value = structuredClone(raw);
    mutate(value);
    value.sha256 = createHash('sha256').update(encoded(value.intent)).digest('hex');
    assert.throws(() => parseWriterMappingPrepareOutput(
      Buffer.concat([encoded(value), Buffer.from('\n')]), x.bytes, x.expected,
      x.adminPublic));
  }
  assert.throws(() => parseWriterMappingPrepareOutput(output.subarray(0, -1),
    x.bytes, x.expected, x.adminPublic));
});
