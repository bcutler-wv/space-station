import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { lstat, open, readdir } from 'node:fs/promises';
import { assessCreateIndexEvidence } from './search-attestor-pure.mjs';
import { parseCreateBoundaryInvocation } from './search-create-boundary-invocation.mjs';

const fail = () => { throw new Error('Private create boundary evidence failed.'); };

/** The copied marker binds this fixed read-only job to one owned invocation. */
export async function readCreateBoundaryInvocation(root) {
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 1000 || stat.gid !== 1000 ||
        (stat.mode & 0o777) !== 0o700 ||
        (await readdir(root)).sort().join('|') !== 'invocation|transition.password') fail();
    const file = `${root}/invocation`;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.uid !== 1000 || before.gid !== 1000 ||
          (before.mode & 0o777) !== 0o400 || before.size < 90 || before.size > 256) fail();
      const bytes = Buffer.alloc(257);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const marker = parseCreateBoundaryInvocation(bytes.subarray(0, bytesRead));
      const after = await handle.stat(), named = await lstat(file);
      if (bytesRead !== before.size ||
          before.dev !== after.dev || before.ino !== after.ino ||
          after.dev !== named.dev || after.ino !== named.ino ||
          after.size !== named.size || after.mode !== named.mode) fail();
      return marker;
    } finally { await handle.close(); }
  } catch { fail(); }
}

/** Private dependency seam; production supplies only fixed readers and paths. */
export async function runReadOnlyCreateBoundary(deps) {
  try {
    const invocation = await deps.readInvocation();
    if (!invocation || invocation.version !== 1) fail();
    const state = await deps.readState();
    if (state?.kind !== 'complete' || state.phase !== 'ready' ||
        typeof state.indexUuid !== 'string') fail();
    const snapshot = await deps.readSnapshot();
    const c = snapshot?.control;
    if (c?.stage !== 'disabled_intent' || c.publicationEnabled !== false ||
        c.servingReady !== false || !Array.isArray(snapshot.history)) fail();
    const source = snapshot.history.find(row => row.generationToken === c.sourceGenerationToken);
    const candidate = snapshot.history.find(row => row.generationToken === c.generationToken);
    const legacy = snapshot.history.find(row => row.generationToken === 'legacy-v1');
    if (!source || !candidate || !legacy || legacy.indexUuid !== state.indexUuid ||
        snapshot.identity?.database !== 'station' ||
        snapshot.identity?.databaseOid !== Number(invocation.databaseOid) ||
        snapshot.identity?.databaseOwner !== invocation.owner ||
        typeof c.transitionToken !== 'string') fail();
    const expectation = { phase: 'precreate', revision: c.revision, stage: 'disabled_intent',
      transitionToken: c.transitionToken, sourceToken: source.generationToken,
      sourceIndex: source.physicalIndex, candidateToken: candidate.generationToken,
      candidateIndex: candidate.physicalIndex, dispatchId: null, ownerId: null, createdUuid: null };
    const observed = await deps.observe();
    if ((deps.assess ?? assessCreateIndexEvidence)(snapshot, observed, expectation).status !== 'create-evidence') fail();
    if (!(await deps.recheck(snapshot)) ||
        JSON.stringify(await deps.readState()) !== JSON.stringify(state) ||
        JSON.stringify(await deps.readInvocation()) !== JSON.stringify(invocation)) fail();
    return { status: 'precreate-observed', ready: false };
  } catch { fail(); }
}
