import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { classifySearchGenerationRegistry } from '../packages/db/dist/search-generation-oracle.js';
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

function timestamp(text, date) {
  if (typeof text !== 'string' || !MICRO.test(text) || !(date instanceof Date) ||
      Object.getPrototypeOf(date) !== Date.prototype || Reflect.ownKeys(date).length ||
      !Number.isFinite(Date.prototype.getTime.call(date)) ||
      text.replace(/\.(\d{3})\d{3}Z$/, '.$1Z') !== Date.prototype.toISOString.call(date)) fail();
}

function validateIdentity(identity) {
  exact(identity, ['sessionUser', 'currentUser', 'database', 'databaseOid', 'databaseOwner']);
  if (identity.sessionUser !== 'station_search_verifier' || identity.currentUser !== identity.sessionUser ||
      identity.database !== 'station' || identity.databaseOwner !== 'station' ||
      !Number.isSafeInteger(identity.databaseOid) || identity.databaseOid < 1) fail();
}

function validateSnapshot(snapshot) {
  canonical(snapshot);
  exact(snapshot, ['control', 'history', 'dispatch', 'identity', 'exactTimestamps']);
  const { control, history, dispatch, identity, exactTimestamps } = snapshot;
  validateIdentity(identity);
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
  if (classified.status !== 'ready') fail();
  return classified.expected;
}

function publicFiles(expected) {
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
  const expected = validateSnapshot(snapshot);
  const raw = canonical({ version: 'station-attestor-raw-v1', invocationId, snapshot });
  const derived = canonical(expected);
  const files = publicFiles(expected);
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
    const wanted = canonical(publicFiles(received.expected)).value;
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
