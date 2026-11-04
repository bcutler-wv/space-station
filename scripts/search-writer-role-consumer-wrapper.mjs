import { mkdir, lstat, realpath } from 'node:fs/promises';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { parseWriterRoleApprovalArgs } from './search-writer-role-pending.mjs';
import { makeWriterRoleConsumer } from './search-writer-role-consumer-core.mjs';
import { openWriterRoleApplyInput } from './search-writer-role-apply-input.mjs';
import { captureCreateIntentAdminVolume } from './search-create-intent-admin-volume.mjs';
import { withSearchAdminDatabase, readSearchAdminRegistrySnapshot,
  recheckSearchAdminRegistrySnapshot } from '../packages/db/dist/search-admin-connection.js';
import { runWriterRoleCas } from '../packages/db/dist/search-writer-role-cas.js';
import { readBootstrapState } from '../packages/search/dist/opensearch-bootstrap-state.js';
import { openSearchAdminObserver, openSearchAdminWriterRoleSender } from
  '../packages/search/dist/opensearch-runtime.js';

const fail = () => { throw Error('Private writer role apply failed.'); };
const role = 'station_search_transition';
const database = Object.freeze({ role, host: 'postgres', port: 5432, database: 'station',
  passwordFile: '/run/search-writer-role-apply/transition.password' });
const endpoint = 'https://opensearch:9200';
const identityDir = '/run/station-admin';
const scratch = '/tmp/.cache/search-writer-role-apply';
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** All thirteen command fields are captured synchronously before dependency I/O. */
export function parseWriterRoleConsumerArgs(raw) {
  try {
    const args = canonicalAttestorValue(raw, 4096).value;
    if (!Array.isArray(args) || args.length !== 13 ||
        args.some(value => typeof value !== 'string')) fail();
    const approval = parseWriterRoleApprovalArgs(args.slice(0, 9));
    const [invocationId, project, oid, systemIdentifier] = args.slice(9);
    if (!uuid(invocationId) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(project) ||
        !/^[1-9][0-9]{0,9}$/.test(oid) || Number(oid) > 4294967295 ||
        !/^[1-9][0-9]{0,19}$/.test(systemIdentifier) ||
        BigInt(systemIdentifier) > 18446744073709551615n) fail();
    const databaseOid = Number(oid);
    return Object.freeze({ approval, invocationId, project, databaseOid, systemIdentifier,
      databaseIdentity: Object.freeze({ sessionUser: role, currentUser: role,
        database: 'station', databaseOwner: 'station', databaseOid }) });
  } catch { fail(); }
}

/** Fixed private tmpfs scratch; only tests supply a different root and UID. */
export async function initializeWriterRoleScratch(root = scratch, uid = 1000, gid = 1000) {
  try {
    const parent = root.slice(0, root.lastIndexOf('/'));
    if (!root.startsWith('/tmp/.cache/') && !root.includes('/.cache/results/')) fail();
    await mkdir(parent, { mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    for (const name of [parent, root]) {
      const stat = await lstat(name);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
          stat.gid !== gid || (stat.mode & 0o777) !== 0o700 ||
          await realpath(name) !== name) fail();
    }
  } catch { fail(); }
}

const production = Object.freeze({
  openInput: () => openWriterRoleApplyInput(),
  readSnapshot: () => withSearchAdminDatabase(database,
    db => readSearchAdminRegistrySnapshot(db, role)),
  recheckSnapshot: snapshot => withSearchAdminDatabase(database,
    db => recheckSearchAdminRegistrySnapshot(db, snapshot, role)),
  cas: (kind, before, operation) => withSearchAdminDatabase(database,
    db => runWriterRoleCas(db, kind, before, operation)),
  readState: () => readBootstrapState('/run/station-state'),
  captureAdmin: () => captureCreateIntentAdminVolume(),
  observe: async () => {
    const observer = await openSearchAdminObserver({ endpoint, identityDir });
    try { return await observer.observe(); } finally { await observer.close(); }
  },
  openSender: contract => openSearchAdminWriterRoleSender({ endpoint, identityDir }, contract),
});

/** Injection is a local fixture seam; the executable passes no caller-selected adapters. */
export async function runFixedWriterRoleConsumer(context, adapters = production) {
  try {
    let input;
    const consumer = makeWriterRoleConsumer(context, {
      readInput: () => input.readInput(),
      recheckInput: () => input.recheck(),
      capturePriorPublic: files => input.capturePriorPublic(files),
      readSnapshot: adapters.readSnapshot, recheckSnapshot: adapters.recheckSnapshot,
      cas: adapters.cas, readState: adapters.readState,
      captureAdmin: adapters.captureAdmin, observe: adapters.observe,
      openSender: adapters.openSender });
    input = await adapters.openInput();
    const result = await consumer.run();
    if (result.status !== 'writer_role_attested' || result.ready !== false) fail();
    return result;
  } catch { fail(); }
}
