import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { classifySearchGenerationRegistry } from '../packages/db/dist/search-generation-oracle.js';
import { buildSearchGenerationManifest } from '../packages/db/dist/search-generation-manifest.js';
import { buildExpectedSecurityPolicy, compareObservedSecurityCollections } from '../packages/search/dist/opensearch-generation-policy.js';
import { verifyProfile } from '../packages/search/dist/opensearch-runtime.js';
import { verifyV2IndexProfile } from '../packages/search/dist/opensearch-v2-profile.js';

const LIMIT = 256 * 1024;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MICRO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const fail = () => { throw new Error('Private search attestor evidence is invalid.'); };

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail();
  return value;
}

// Descriptor-first, bounded canonicalization. Repeated references (including
// compact DAGs), callbacks and custom prototypes never reach JSON.stringify.
function canonical(value, cap = LIMIT) {
  const budget = { nodes: 0, bytes: 0, seen: new Set() };
  const visit = (item, depth) => {
    if (++budget.nodes > 60_000 || depth > 12) fail();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) fail();
      return item;
    }
    if (typeof item === 'string') {
      budget.bytes += Buffer.byteLength(item, 'utf8');
      if (budget.bytes > cap) fail();
      return item;
    }
    if (!item || typeof item !== 'object' || budget.seen.has(item)) fail();
    if (item instanceof Date) {
      if (Object.getPrototypeOf(item) !== Date.prototype || Reflect.ownKeys(item).length ||
          !Number.isFinite(Date.prototype.getTime.call(item))) fail();
      return Date.prototype.toISOString.call(item);
    }
    if (Array.isArray(item) ? Object.getPrototypeOf(item) !== Array.prototype :
      Object.getPrototypeOf(item) !== Object.prototype) fail();
    budget.seen.add(item);
    const keys = Reflect.ownKeys(item);
    if (keys.length > 2_561 || keys.some(key => typeof key !== 'string')) fail();
    if (Array.isArray(item) && (item.length > 2_560 ||
        Object.keys(item).length !== item.length ||
        Object.keys(item).some((key, i) => key !== String(i)))) fail();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const output = Array.isArray(item) ? [] : {};
    for (const key of Object.keys(descriptors).filter(key => !Array.isArray(item) || key !== 'length').sort()) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || key.length > 256) fail();
      budget.bytes += Buffer.byteLength(key, 'utf8') + 16;
      if (budget.bytes > cap) fail();
      if (Array.isArray(output)) output[Number(key)] = visit(descriptor.value, depth + 1);
      else Object.defineProperty(output, key, { value: visit(descriptor.value, depth + 1),
        enumerable: true, configurable: true, writable: true });
    }
    return output;
  };
  const result = visit(value, 0);
  const bytes = Buffer.from(JSON.stringify(result), 'utf8');
  if (bytes.length > cap) fail();
  return { value: result, bytes };
}
// Shared by the private create-intent projection; this does not classify a
// partial registry as ready or expose raw snapshot bytes.
export const canonicalAttestorValue = canonical;

function timestamp(text, date) {
  if (typeof text !== 'string' || !MICRO.test(text) || !(date instanceof Date) ||
      Object.getPrototypeOf(date) !== Date.prototype || Reflect.ownKeys(date).length ||
      !Number.isFinite(Date.prototype.getTime.call(date)) ||
      text.replace(/\.(\d{3})\d{3}Z$/, '.$1Z') !== Date.prototype.toISOString.call(date)) fail();
}

function validateIdentity(identity, expectedRole = 'station_search_verifier') {
  exact(identity, ['sessionUser', 'currentUser', 'database', 'databaseOid', 'databaseOwner']);
  if (identity.sessionUser !== expectedRole || identity.currentUser !== expectedRole ||
      identity.database !== 'station' || identity.databaseOwner !== 'station' ||
      !Number.isSafeInteger(identity.databaseOid) || identity.databaseOid < 1) fail();
}

function validateSnapshot(snapshot, requireReady = true) {
  canonical(snapshot);
  exact(snapshot, ['control', 'history', 'dispatch', 'identity', 'exactTimestamps']);
  const { control, history, dispatch, identity, exactTimestamps } = snapshot;
  validateIdentity(identity, requireReady ? 'station_search_verifier' : 'station_search_transition');
  if (!Array.isArray(history) || !Array.isArray(dispatch) || history.length > 512 || dispatch.length > 2_560) fail();
  exact(exactTimestamps, ['control', 'history', 'dispatch']);
  const sideControl = exact(exactTimestamps.control, ['singleton', 'updatedAt']);
  if (sideControl.singleton !== control.singleton) fail();
  timestamp(sideControl.updatedAt, control.updatedAt);
  if (!Array.isArray(exactTimestamps.history) || exactTimestamps.history.length !== history.length ||
      !Array.isArray(exactTimestamps.dispatch) || exactTimestamps.dispatch.length !== dispatch.length) fail();
  const historyKeys = new Set(), dispatchKeys = new Set();
  for (let i = 0; i < history.length; i++) {
    const row = history[i];
    const side = exact(exactTimestamps.history[i], ['generationToken', 'createdAt']);
    if (typeof row?.generationToken !== 'string' || side.generationToken !== row.generationToken ||
        historyKeys.has(row.generationToken)) fail();
    historyKeys.add(row.generationToken);
    timestamp(side.createdAt, row.createdAt);
  }
  for (let i = 0; i < dispatch.length; i++) {
    const row = dispatch[i];
    const side = exact(exactTimestamps.dispatch[i], ['generationToken', 'operation', 'dispatchId', 'createdAt']);
    if (side.generationToken !== row?.generationToken || side.operation !== row.operation ||
        side.dispatchId !== row.dispatchId) fail();
    const key = `${row.generationToken}\0${row.operation}\0${row.dispatchId}`;
    if (dispatchKeys.has(key)) fail();
    dispatchKeys.add(key);
    timestamp(side.createdAt, row.createdAt);
  }
  const classified = classifySearchGenerationRegistry({ control, history, dispatch });
  if (requireReady && classified.status !== 'ready' || classified.status === 'incident') fail();
  return classified;
}

export function buildAttestorPublicFiles(expected) {
  const files = [
    { path: 'ca.pem', token: 'legacy-v1', role: 'ca', principal: 'station-search-ca', fingerprint: null },
    { path: 'v1/admin.pem', token: 'legacy-v1', role: 'admin', principal: 'station-search-admin', fingerprint: null },
    { path: 'v1/query.pem', token: 'legacy-v1', role: 'query', principal: 'station-search-query', fingerprint: null },
    { path: 'v1/indexer.pem', token: 'legacy-v1', role: 'indexer', principal: 'station-search-indexer', fingerprint: null },
  ];
  const paths = new Set(files.map(row => row.path));
  for (const row of expected.generations) {
    if (row.token === 'legacy-v1' || row.presence === 'absent') continue;
    if (!UUID.test(row.token) || row.presence !== 'exact' ||
        typeof row.writerCertFingerprint !== 'string' || typeof row.queryCertFingerprint !== 'string' ||
        typeof row.writerPrincipal !== 'string' || typeof row.queryPrincipal !== 'string') fail();
    const suffix = row.token.replaceAll('-', '').toLowerCase();
    for (const [role, principal, fingerprint] of [
      ['writer', row.writerPrincipal, row.writerCertFingerprint],
      ['query', row.queryPrincipal, row.queryCertFingerprint],
    ]) {
      const path = `generations/${suffix}/${role}.pem`;
      if (paths.has(path)) fail();
      paths.add(path);
      files.push({ path, token: row.token, role, principal, fingerprint });
    }
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return files;
}

// This exported comparison also accepts a caller-supplied expected inventory.
// Check its primitive envelope before the policy helper or physical filtering:
// neither may coerce a malformed presence value into a different obligation.
function validateExpected(expected) {
  exact(expected, ['version', 'generations']);
  if (expected.version !== 'station-generation-registry-v1' ||
      !Array.isArray(expected.generations) || expected.generations.length > 512) fail();
  const nullableText = value => value === null || typeof value === 'string';
  for (const row of expected.generations) {
    exact(row, ['token', 'index', 'profile', 'presence', 'uuid', 'writerRole', 'queryRole',
      'writerPrincipal', 'queryPrincipal', 'writerCertFingerprint', 'queryCertFingerprint']);
    if (typeof row.token !== 'string' || typeof row.index !== 'string' ||
        !['station-mail-v1', 'station-mail-v2'].includes(row.profile) ||
        (row.presence !== 'exact' && row.presence !== 'absent') ||
        ![row.uuid, row.writerRole, row.queryRole, row.writerPrincipal, row.queryPrincipal,
          row.writerCertFingerprint, row.queryCertFingerprint].every(nullableText)) fail();
  }
}

function derive(snapshot, invocationId) {
  if (typeof invocationId !== 'string' || !UUID.test(invocationId)) fail();
  const expected = validateSnapshot(snapshot).expected;
  const raw = canonical({ version: 'station-attestor-raw-v1', invocationId, snapshot });
  const derived = canonical(expected);
  const files = buildAttestorPublicFiles(expected);
  const manifest = { version: 'station-attestor-manifest-v1', invocationId,
    rawDigest: createHash('sha256').update(raw.bytes).digest('hex'),
    identity: snapshot.identity, expected: derived.value, publicFiles: files };
  return canonical(manifest).value;
}

/** Build only from a complete verifier snapshot and the owner's lock-generated ID. */
export function makePreparedAttestorManifest(snapshot, invocationId) {
  try { return derive(snapshot, invocationId); } catch { fail(); }
}

/** A matching digest alone cannot approve altered derived inventory. */
export function validatePreparedAttestorManifest(snapshot, invocationId, manifest) {
  try {
    const received = canonical(manifest).value;
    exact(received, ['version', 'invocationId', 'rawDigest', 'identity', 'expected', 'publicFiles']);
    const wanted = derive(snapshot, invocationId);
    if (JSON.stringify(received) !== JSON.stringify(wanted)) fail();
    return wanted;
  } catch { fail(); }
}

/** Shape only: offline transfer has no raw snapshot and cannot attest the digest. */
export function validateOfflineAttestorManifest(invocationId, manifest) {
  try {
    if (typeof invocationId !== 'string' || !UUID.test(invocationId)) fail();
    const received = canonical(manifest).value;
    exact(received, ['version', 'invocationId', 'rawDigest', 'identity', 'expected', 'publicFiles']);
    if (received.version !== 'station-attestor-manifest-v1' ||
        received.invocationId !== invocationId ||
        typeof received.rawDigest !== 'string' || !/^[0-9a-f]{64}$/.test(received.rawDigest)) fail();
    validateIdentity(received.identity);
    validateExpected(received.expected);
    buildExpectedSecurityPolicy(received.expected);
    const wanted = canonical(buildAttestorPublicFiles(received.expected)).value;
    if (JSON.stringify(received.publicFiles) !== JSON.stringify(wanted)) fail();
    return received;
  } catch { fail(); }
}

/** Compare an already bounded fixed observer result to every ready history entry. */
export function compareReadyAttestorObservation(expected, observed) {
  try {
    canonical(expected);
    canonical(observed, 2 * 1024 * 1024);
    validateExpected(expected);
    exact(observed, ['indexes', 'roles', 'mappings']);
    const policy = buildExpectedSecurityPolicy(expected);
    if (compareObservedSecurityCollections(policy, observed.roles, observed.mappings) !== 'exact') fail();
    const indexes = observed.indexes;
    if (!indexes || typeof indexes !== 'object' || Array.isArray(indexes) ||
        Object.getPrototypeOf(indexes) !== Object.prototype) fail();
    const rows = expected.generations.filter(row => row.presence === 'exact');
    const names = rows.map(row => row.index).sort();
    if (JSON.stringify(Object.keys(indexes).sort()) !== JSON.stringify(names)) fail();
    for (const row of rows) {
      const entry = exact(indexes[row.index], ['aliases', 'mappings', 'settings']);
      if (Object.keys(exact(entry.aliases, [])).length || typeof row.uuid !== 'string') fail();
      const body = { [row.index]: entry };
      const uuid = row.profile === 'station-mail-v1' ? verifyProfile(body) :
        row.profile === 'station-mail-v2' ? verifyV2IndexProfile(body, row.index, row.uuid) : fail();
      if (uuid !== row.uuid) fail();
    }
    return 'exact';
  } catch { fail(); }
}

/** Partial create evidence is deliberately disjoint from registry readiness. */
function assessCreateEvidence(snapshot, observed, expectation, completion) {
  try {
    canonical(expectation);
    exact(expectation, ['phase', 'revision', 'stage', 'transitionToken', 'sourceToken',
      'sourceIndex', 'candidateToken', 'candidateIndex', 'dispatchId', 'ownerId', 'createdUuid']);
    if (!(completion ? ['confirmed', 'bound'] : ['precreate', 'postcreate']).includes(expectation.phase) ||
        !Number.isSafeInteger(expectation.revision) || expectation.revision < 1 ||
        !(completion ? ['create_requested', 'uuid_bound'] : ['disabled_intent', 'create_requested']).includes(expectation.stage) ||
        completion && (expectation.phase === 'confirmed') !== (expectation.stage === 'create_requested') ||
        !UUID.test(expectation.transitionToken) ||
        typeof expectation.sourceToken !== 'string' ||
        typeof expectation.sourceIndex !== 'string' ||
        !UUID.test(expectation.candidateToken) ||
        typeof expectation.candidateIndex !== 'string' ||
        (expectation.dispatchId !== null && !UUID.test(expectation.dispatchId)) ||
        (expectation.ownerId !== null && !UUID.test(expectation.ownerId)) ||
        (expectation.dispatchId === null) !== (expectation.ownerId === null) ||
        (expectation.phase === 'precreate' ? expectation.createdUuid !== null :
          typeof expectation.createdUuid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(expectation.createdUuid))) fail();
    const classified = validateSnapshot(snapshot, false);
    if (classified.status !== 'incomplete' ||
        !(completion ? ['confirmed_awaiting_advance', 'transition_in_progress'] :
          ['transition_in_progress', 'armed', 'sent_unknown']).includes(classified.reason)) fail();
    const { control, history, dispatch } = snapshot;
    if (control.revision !== expectation.revision || control.stage !== expectation.stage ||
        control.transitionToken !== expectation.transitionToken ||
        control.sourceGenerationToken !== expectation.sourceToken ||
        control.generationToken !== expectation.candidateToken ||
        control.publicationEnabled !== false || control.servingReady !== false) fail();
    const candidate = history.find(row => row.generationToken === expectation.candidateToken);
    const source = history.find(row => row.generationToken === expectation.sourceToken);
    if (!candidate || !source || source.physicalIndex !== expectation.sourceIndex ||
        candidate.physicalIndex !== expectation.candidateIndex ||
        source.lifecycle !== 'roles_attested' ||
        candidate.lifecycle !== (expectation.phase === 'bound' ? 'bound' : 'reserved') ||
        candidate.indexUuid !== (expectation.phase === 'bound' ? expectation.createdUuid : null) ||
        candidate.writerCertFingerprint !== null || candidate.queryCertFingerprint !== null ||
        candidate.profileId !== 'station-mail-v2' || control.profileId !== 'station-mail-v2' ||
        control.physicalIndex !== candidate.physicalIndex ||
        control.indexUuid !== (expectation.phase === 'bound' ? expectation.createdUuid : null) ||
        history.some(row => row !== candidate && !['roles_attested', 'retired_retained', 'abandoned'].includes(row.lifecycle))) fail();
    const create = dispatch.filter(row => row.generationToken === candidate.generationToken);
    if (create.length > 1 || create.some(row => row.operation !== 'create_index')) fail();
    if (control.stage === 'disabled_intent') {
      if (expectation.phase !== 'precreate' || create.length || expectation.dispatchId !== null) fail();
    } else if (control.stage === 'create_requested') {
      const item = create[0];
      if (!item || item.dispatchId !== expectation.dispatchId || item.ownerId !== expectation.ownerId ||
          item.state !== (expectation.phase === 'precreate' ? 'armed' :
            expectation.phase === 'confirmed' ? 'response_confirmed' : 'sent_unknown')) fail();
    } else if (control.stage === 'uuid_bound') {
      const item = create[0];
      if (expectation.phase !== 'bound' || !item || item.dispatchId !== expectation.dispatchId ||
          item.ownerId !== expectation.ownerId || item.state !== 'response_confirmed') fail();
    } else fail();
    canonical(observed, 2 * 1024 * 1024);
    exact(observed, ['indexes', 'roles', 'mappings']);
    const manifest = buildSearchGenerationManifest(history);
    const prior = manifest.filter(row => row.token !== candidate.generationToken);
    const expected = { version: 'station-generation-registry-v1', generations: prior.map(row => ({
      ...row, presence: row.presence === 'absent' ? 'absent' : 'exact',
    })) };
    const policy = buildExpectedSecurityPolicy(expected);
    if (compareObservedSecurityCollections(policy, observed.roles, observed.mappings) !== 'exact') fail();
    const names = prior.filter(row => row.presence !== 'absent').map(row => row.index);
    if (['postcreate', 'confirmed', 'bound'].includes(expectation.phase)) names.push(candidate.physicalIndex);
    exact(observed.indexes, names);
    for (const row of prior.filter(row => row.presence !== 'absent')) {
      const body = { [row.index]: exact(observed.indexes[row.index], ['aliases', 'mappings', 'settings']) };
      const found = row.profile === 'station-mail-v1' ? verifyProfile(body) :
        verifyV2IndexProfile(body, row.index, row.uuid);
      if (found !== row.uuid) fail();
    }
    if (['postcreate', 'confirmed', 'bound'].includes(expectation.phase) &&
        verifyV2IndexProfile({ [candidate.physicalIndex]:
          exact(observed.indexes[candidate.physicalIndex], ['aliases', 'mappings', 'settings']) },
        candidate.physicalIndex, expectation.createdUuid) !== expectation.createdUuid) fail();
    return { status: completion ? 'create-completion-evidence' : 'create-evidence',
      phase: expectation.phase, ready: false };
  } catch { return { status: completion ? 'create-completion-evidence-rejected' :
    'create-evidence-rejected', ready: false }; }
}

export function assessCreateIndexEvidence(snapshot, observed, expectation) {
  return assessCreateEvidence(snapshot, observed, expectation, false);
}

/** The same exact evidence at closed create stages; never a send authorization. */
export function assessCreateIndexCompletionEvidence(snapshot, observed, expectation) {
  return assessCreateEvidence(snapshot, observed, expectation, true);
}

/** Existing owner metadata uses decimal OID text; never coerce its 64-bit system ID. */
export function matchOwnerDatabaseOid(identity, ownerOidText) {
  try {
    canonical(identity);
    validateIdentity(identity);
    if (typeof ownerOidText !== 'string' || !/^[1-9][0-9]{0,9}$/.test(ownerOidText) ||
        String(identity.databaseOid) !== ownerOidText) fail();
    return true;
  } catch { fail(); }
}
