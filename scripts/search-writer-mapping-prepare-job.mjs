import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fixedDir } from './search-writer-role-prepare-input.mjs';
import { runWriterMappingPrepare } from './search-writer-mapping-prepare-core.mjs';

const fail = () => { throw Error('Private writer mapping preparation failed.'); };

/** Fixed read-only job wiring; overrides exist only for local disposable fixtures. */
export async function runFixedWriterMappingPrepareJob(deps, fixture = undefined) {
  try {
    const uid = fixture?.uid ?? 1000, gid = fixture?.gid ?? 1000;
    const root = fixture?.root ?? '/run/search-writer-mapping-prepare';
    const scratchParent = fixture?.scratchParent ?? '/tmp/.cache';
    const scratch = fixture?.scratch ?? '/tmp/.cache/search-writer-mapping-prepare';
    if (fixture !== undefined &&
        (process.env.STATION_WRITER_MAPPING_PREPARE_FIXTURE !== '1' ||
          Object.keys(fixture).sort().join('|') !==
            'gid|root|scratch|scratchParent|uid' ||
          uid !== process.getuid?.() || gid !== process.getgid?.() ||
          ![root, scratchParent, scratch].every(name =>
            typeof name === 'string' && path.isAbsolute(name) &&
            path.resolve(name) === name &&
            name.startsWith(`${path.resolve('.cache/results')}${path.sep}`)) ||
          path.dirname(scratch) !== scratchParent)) fail();
    if (process.argv.length !== 2 || process.getuid?.() !== uid ||
        process.getgid?.() !== gid) fail();
    if (!deps || Object.keys(deps).sort().join('|') !==
        'captureAdminPublic|observe|openInput|readSnapshot|readState|recheckSnapshot|runCore' ||
        Object.values(deps).some(value => typeof value !== 'function')) fail();
    await mkdir(scratchParent, { mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });
    const parentStat = await fixedDir(scratchParent, uid, gid);
    const scratchStat = await fixedDir(scratch, uid, gid);
    const input = await deps.openInput(root, scratch,
      fixture && { uid, gid });
    if (!input || Object.keys(input).sort().join('|') !==
        'expected|inputBytes|readInputBytes|recheckInput') fail();
    await fixedDir(scratchParent, uid, gid, parentStat);
    await fixedDir(scratch, uid, gid, scratchStat);
    const output = await deps.runCore(input.inputBytes, input.expected, {
      readInputBytes: input.readInputBytes,
      recheckInput: input.recheckInput,
      readState: deps.readState,
      readSnapshot: deps.readSnapshot,
      recheckSnapshot: deps.recheckSnapshot,
      observe: deps.observe,
      captureAdminPublic: deps.captureAdminPublic });
    if (!(await input.recheckInput())) fail();
    await fixedDir(scratchParent, uid, gid, parentStat);
    await fixedDir(scratch, uid, gid, scratchStat);
    return output;
  } catch { fail(); }
}

export const fixedWriterMappingPrepareCore = runWriterMappingPrepare;

export async function readFixedWriterMappingObservation(openObserver) {
  const observer = await openObserver();
  try { return await observer.observe(); } finally { await observer.close(); }
}
