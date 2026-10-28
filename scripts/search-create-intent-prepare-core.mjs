import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { makeCreateIntentProjection } from './search-create-intent-pure.mjs';

const fail = () => { throw new Error('Private create intent preparation failed.'); };

/** One fixed read-only projection; the caller cannot select a body or expected state. */
export async function runCreateIntentPrepare(deps) {
  try {
    const invocation = await deps.readInvocation();
    if (invocation?.version !== 1 || invocation.owner !== 'station') fail();
    const state = await deps.readState();
    const snapshot = await deps.readSnapshot();
    if (snapshot?.identity?.databaseOid !== Number(invocation.databaseOid)) fail();
    const observed = await deps.observe();
    const projection = makeCreateIntentProjection(snapshot, observed, state);
    const admin = await deps.captureAdminPublic();
    const adminPublic = admin?.public;
    if (!adminPublic || !/^[0-9a-f]{64}$/.test(adminPublic.caSha256) ||
        !/^[0-9a-f]{64}$/.test(adminPublic.adminSha256) ||
        Object.keys(adminPublic).sort().join('|') !== 'adminSha256|caSha256') fail();
    if (!(await deps.recheck(snapshot))) fail();
    const nextState = await deps.readState();
    const nextInvocation = await deps.readInvocation();
    const nextObserved = await deps.observe();
    if (!(await deps.recheck(snapshot))) fail();
    if (!(await admin.recheck())) fail();
    const finalState = await deps.readState();
    const finalInvocation = await deps.readInvocation();
    if (!canonicalAttestorValue(state).bytes.equals(canonicalAttestorValue(nextState).bytes) ||
        !canonicalAttestorValue(state).bytes.equals(canonicalAttestorValue(finalState).bytes) ||
        !canonicalAttestorValue(invocation).bytes.equals(canonicalAttestorValue(nextInvocation).bytes) ||
        !canonicalAttestorValue(invocation).bytes.equals(canonicalAttestorValue(finalInvocation).bytes) ||
        !canonicalAttestorValue(observed, 2 * 1024 * 1024).bytes.equals(
          canonicalAttestorValue(nextObserved, 2 * 1024 * 1024).bytes) ||
        !canonicalAttestorValue(projection).bytes.equals(
          canonicalAttestorValue(makeCreateIntentProjection(snapshot, nextObserved, nextState)).bytes)) fail();
    const bytes = canonicalAttestorValue({ projection, adminPublic }, 256 * 1024).bytes;
    return `${bytes.toString('utf8')}\n`;
  } catch { fail(); }
}
