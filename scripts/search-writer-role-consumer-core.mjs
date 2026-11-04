/* global structuredClone */
import { Buffer } from 'node:buffer';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { parseWriterRoleApprovalArgs } from './search-writer-role-pending.mjs';
import { validateWriterRoleCopiedEvidence } from './search-writer-role-apply-evidence.mjs';
import { assessWriterRoleEvidence,
  constructApprovedWriterRoleContract } from './search-writer-role-intent-pure.mjs';

const fail = () => { throw Error('Private writer role apply failed.'); };
const micro = value => typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value) &&
  !Number.isNaN(Date.parse(value));
const same = (a, b) => canonicalAttestorValue(a, 2 * 1024 * 1024).bytes.equals(
  canonicalAttestorValue(b, 2 * 1024 * 1024).bytes);
const pin = (value, max = 2 * 1024 * 1024) => {
  canonicalAttestorValue(value, max);
  return structuredClone(value);
};
const exact = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail();
  const own = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.length !== names.length || own.some(key => typeof key !== 'string' ||
      !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) ||
      own.slice().sort().join('|') !== names.slice().sort().join('|')) fail();
};
const uuid = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const insertDispatch = (rows, row) => {
  const key = item => `${item.generationToken}|${item.operation}|${item.dispatchId}`;
  const at = rows.findIndex(item => key(item) > key(row));
  rows.splice(at < 0 ? rows.length : at, 0, row);
};

function inputValue(raw) {
  exact(raw, ['approvedSha256', 'invocationId', 'intent', 'binding', 'createEvidence',
    'transitionPassword', 'publicDigests']);
  if (!Buffer.isBuffer(raw.transitionPassword) || raw.transitionPassword.length !== 43) fail();
  const value = pin({ approvedSha256: raw.approvedSha256,
    invocationId: raw.invocationId, intent: raw.intent, binding: raw.binding,
    createEvidence: raw.createEvidence, publicDigests: raw.publicDigests }, 256 * 1024);
  return { value, password: Buffer.from(raw.transitionPassword) };
}

function entry(context, input) {
  const approved = context.approval;
  const intent = input.value.intent;
  const binding = input.value.binding;
  const old = input.value.createEvidence;
  exact(old, ['intent', 'binding']);
  const validated = validateWriterRoleCopiedEvidence({
    intent: canonicalAttestorValue(intent, 256 * 1024).bytes,
    binding: canonicalAttestorValue(binding, 1024).bytes,
    createIntent: canonicalAttestorValue(old.intent, 256 * 1024).bytes,
    createBinding: canonicalAttestorValue(old.binding, 1024).bytes,
  }, context.project);
  if (validated.approvedSha256 !== context.approval.approvedSha256 ||
      validated.invocationId !== context.invocationId) fail();
  const fields = ['approvedSha256', 'revision', 'transitionToken', 'sourceToken',
    'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex', 'candidateUuid'];
  for (const key of fields) if (approved[key] !== (key === 'approvedSha256' ?
    input.value.approvedSha256 : intent[key])) fail();
  if (binding.approvedSha256 !== approved.approvedSha256 ||
      binding.invocationId !== context.invocationId ||
      binding.dispatchId !== intent.dispatchId || binding.ownerId !== intent.ownerId ||
      input.value.invocationId !== context.invocationId ||
      intent.project !== context.project || intent.databaseOid !== context.databaseOid ||
      intent.systemIdentifier !== context.systemIdentifier ||
      !same(input.value.publicDigests, intent.publicDigests) ||
      intent.revision > 2147483642) fail();
  return { intent, createEvidence: { ...old, approvedSha256: intent.createApprovedSha256 } };
}

function successor(before, after, kind, intent, roleTime) {
  const previous = before.control;
  const actual = pin(after);
  const expected = structuredClone(before);
  expected.control.revision++;
  expected.control.updatedAt = actual.control?.updatedAt;
  const updatedAt = actual.exactTimestamps?.control?.updatedAt;
  if (!micro(updatedAt) || !(actual.control.updatedAt instanceof Date) ||
      actual.control.updatedAt.getTime() !== Date.parse(updatedAt)) fail();
  expected.exactTimestamps.control.updatedAt = updatedAt;
  if (kind === 'request') expected.control.stage = 'writer_role_requested';
  else if (kind === 'arm') {
    const row = actual.dispatch?.find(item => item.generationToken === intent.candidateToken &&
      item.operation === 'writer_role');
    const side = actual.exactTimestamps?.dispatch?.find(item =>
      item.generationToken === intent.candidateToken && item.operation === 'writer_role');
    if (!row || !side || !micro(side.createdAt) || !(row.createdAt instanceof Date) ||
        row.createdAt.getTime() !== Date.parse(side.createdAt) ||
        roleTime !== null && side.createdAt !== roleTime) fail();
    insertDispatch(expected.dispatch, { generationToken: intent.candidateToken, operation: 'writer_role',
      dispatchId: intent.dispatchId, ownerId: intent.ownerId, target: intent.target,
      bodyIdentity: intent.bodyIdentity, state: 'armed', createdAt: row.createdAt });
    insertDispatch(expected.exactTimestamps.dispatch, { generationToken: intent.candidateToken,
      operation: 'writer_role', dispatchId: intent.dispatchId, createdAt: side.createdAt });
    roleTime = side.createdAt;
  } else {
    const row = expected.dispatch.find(item => item.generationToken === intent.candidateToken &&
      item.operation === 'writer_role');
    if (!row) fail();
    row.state = kind === 'send' ? 'sent_unknown' : 'response_confirmed';
    if (kind === 'attest') expected.control.stage = 'writer_role_attested';
  }
  if (actual.control.revision !== previous.revision + 1 || !same(actual, expected) ||
      actual.control.publicationEnabled !== false || actual.control.servingReady !== false) fail();
  return { snapshot: actual, roleTime };
}

/** Uncalled fixed orchestration contract. One invocation object allows one call only. */
export function makeWriterRoleConsumer(context, deps) {
  // This entire authority capture is synchronous and occurs before any dependency I/O.
  exact(context, ['approval', 'invocationId', 'project', 'databaseOid',
    'systemIdentifier', 'databaseIdentity']);
  const authority = pin(context);
  exact(authority.databaseIdentity, ['sessionUser', 'currentUser', 'database',
    'databaseOwner', 'databaseOid']);
  exact(authority.approval, ['approvedSha256', 'revision', 'transitionToken',
    'sourceToken', 'sourceIndex', 'sourceUuid', 'candidateToken', 'candidateIndex',
    'candidateUuid']);
  const tuple = [authority.approval.approvedSha256, String(authority.approval.revision),
    authority.approval.transitionToken, authority.approval.sourceToken,
    authority.approval.sourceIndex, authority.approval.sourceUuid,
    authority.approval.candidateToken, authority.approval.candidateIndex,
    authority.approval.candidateUuid];
  if (!same(parseWriterRoleApprovalArgs(tuple), authority.approval) ||
      !uuid(authority.invocationId) || typeof authority.project !== 'string' ||
      !Number.isSafeInteger(authority.databaseOid) ||
      typeof authority.systemIdentifier !== 'string' ||
      !same(authority.databaseIdentity, { sessionUser: 'station_search_transition',
        currentUser: 'station_search_transition', database: 'station',
        databaseOwner: 'station', databaseOid: authority.databaseOid })) fail();
  let attempted = false;
  return Object.freeze({ async run() {
    if (attempted) fail();
    attempted = true;
    let closeSender;
    try {
      const original = inputValue(await deps.readInput());
      const { intent, createEvidence } = entry(authority, original);
      const admin = await deps.captureAdmin();
      exact(admin, ['public', 'recheck']);
      if (typeof admin.recheck !== 'function') fail();
      const recheckAdmin = admin.recheck.bind(admin);
      if (!same(pin(admin.public), { caSha256: intent.publicDigests.find(row =>
        row.path === 'ca.pem')?.sha256, adminSha256: intent.publicDigests.find(row =>
        row.path === 'v1/admin.pem')?.sha256 })) fail();
      let current = pin(await deps.readSnapshot());
      if (!same(current.identity, authority.databaseIdentity) ||
          current.control?.revision !== intent.revision ||
          current.control?.stage !== 'uuid_bound' ||
          current.exactTimestamps?.control?.updatedAt !== intent.boundControlUpdatedAt) fail();
      let roleTime = null;
      const fence = async phase => {
        if (!(await deps.recheckInput()) || !(await recheckAdmin()) ||
            !(await deps.recheckSnapshot(structuredClone(current)))) fail();
        const now = pin(await deps.readSnapshot());
        const state = pin(await deps.readState());
        const publicDigests = pin(await deps.capturePriorPublic(structuredClone(intent.publicFiles)));
        const observed = pin(await deps.observe());
        const after = pin(await deps.readSnapshot());
        const stateAfter = pin(await deps.readState());
        const publicAfter = pin(await deps.capturePriorPublic(structuredClone(intent.publicFiles)));
        const freshInput = inputValue(await deps.readInput());
        if (!same(now.identity, authority.databaseIdentity) ||
            !same(after.identity, authority.databaseIdentity) ||
            !same(now, current) || !same(after, current) || !same(stateAfter, state) ||
            !same(publicAfter, publicDigests) ||
            !same(freshInput.value, original.value) ||
            !freshInput.password.equals(original.password) ||
            !(await deps.recheckInput()) || !(await recheckAdmin()) ||
            !(await deps.recheckSnapshot(structuredClone(current)))) fail();
        const result = assessWriterRoleEvidence(now, observed, state, createEvidence,
          publicDigests, { intent, sha256: authority.approval.approvedSha256 }, phase,
          { controlUpdatedAt: current.exactTimestamps.control.updatedAt,
            roleCreatedAt: roleTime }, authority.approval.approvedSha256);
        if (result.status !== 'writer-role-evidence' || result.phase !== phase ||
            result.ready !== false ||
            !same(now.identity, authority.databaseIdentity)) fail();
        return { now, observed };
      };
      const bound = await fence('bound');
      const contract = constructApprovedWriterRoleContract(bound.now,
        { intent, sha256: authority.approval.approvedSha256 },
        authority.approval.approvedSha256);
      const cas = async (kind, operation, phase) => {
        const result = await deps.cas(kind, structuredClone(current), operation);
        const next = successor(current, result, kind, intent, roleTime);
        current = next.snapshot; roleTime = next.roleTime;
        await fence(phase);
      };
      await cas('request', { stage: 'writer_role_requested' }, 'requested');
      await cas('arm', { operation: 'writer_role', dispatchId: intent.dispatchId,
        ownerId: intent.ownerId, target: intent.target,
        bodyIdentity: intent.bodyIdentity }, 'armed');
      await cas('send', { operation: 'writer_role', dispatchId: intent.dispatchId,
        ownerId: intent.ownerId, state: 'sent_unknown' }, 'presend');
      const opened = await deps.openSender(contract);
      exact(opened, ['sendOnce', 'close']);
      if (typeof opened.sendOnce !== 'function' || typeof opened.close !== 'function') fail();
      const sendOnce = opened.sendOnce.bind(opened);
      const close = opened.close.bind(opened);
      closeSender = close;
      await fence('presend');
      // One local attempt; a failed original response never advances confirmation.
      const response = await sendOnce();
      if (!same(response, { created: true })) fail();
      await fence('postsend');
      await cas('confirm', { operation: 'writer_role', dispatchId: intent.dispatchId,
        ownerId: intent.ownerId, state: 'response_confirmed' }, 'confirmed');
      await cas('attest', { stage: 'writer_role_attested' }, 'attested');
      closeSender = undefined; await close();
      return Object.freeze({ status: 'writer_role_attested', ready: false });
    } catch { fail(); }
    finally {
      if (closeSender) {
        try { await closeSender(); } catch { fail(); }
      }
    }
  } });
}
