import { afterEach, expect, test } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { SearchEngineError } from './opensearch-runtime.js';
import { introduceProfile, verifyRetainedProfile, type ProfileAccess } from './opensearch-bootstrap-flow.js';
import { claimBootstrapIntroduction, completeBootstrapIntroduction, installBootstrapState,
  installBootstrapWithIdentities, readBootstrapState, type BootstrapOwners, type IdentityPaths } from './opensearch-bootstrap-state.js';

const owned: string[] = [];
const owners: BootstrapOwners = { installer: process.getuid!(), service: process.getuid!(), group: process.getgid!() };
async function fixture() {
  const root = await mkdtemp(path.join(process.cwd(), '.cache/results/bootstrap-state-'));
  owned.push(root);
  const state = path.join(root, 'state'), data = path.join(root, 'data');
  await mkdir(state, { mode: 0o700 }); await mkdir(data, { mode: 0o700 });
  return { root, state, data };
}
async function identityFixture() {
  const { root, state, data } = await fixture();
  const source = path.join(root, 'source');
  await mkdir(source);
  const targets = {} as IdentityPaths['targets'];
  for (const role of ['node', 'admin', 'query', 'indexer', 'outsider'] as const) {
    targets[role] = path.join(root, role);
    await mkdir(targets[role]);
    await writeFile(path.join(source, `${role}.pem`), `certificate:${role}`);
    await writeFile(path.join(source, `${role}.key`), `private-key:${role}`);
  }
  await writeFile(path.join(source, 'ca.pem'), 'ca-certificate');
  return { root, state, data, paths: { source, targets } satisfies IdentityPaths };
}
async function ready(state: string) {
  await writeFile(path.join(state, 'phase'), 'ready\n');
  await chmod(path.join(state, 'phase'), 0o660);
}
function access(options: { profile?: () => Promise<string>; create?: () => Promise<string> } = {}) {
  let sends = 0, checks = 0;
  const value: ProfileAccess = { verifySecurity: async () => { checks++; },
    profile: options.profile ?? (async () => { throw new SearchEngineError('status', 404); }),
    createProfileStrict: async () => { sends++; return options.create ? options.create() : 'uuid_1'; } };
  return { value, counts: () => ({ sends, checks }) };
}
afterEach(async () => { await Promise.all(owned.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('installer identity preflight leaves empty state untouched on missing source or retained mismatch', async () => {
  const missing = await identityFixture();
  await rm(path.join(missing.paths.source, 'outsider.key'));
  await expect(installBootstrapWithIdentities(missing.state, missing.data, missing.paths, owners)).rejects.toThrow();
  expect(await readdir(missing.state)).toEqual([]);
  expect(await readdir(missing.data)).toEqual([]);

  const mismatch = await identityFixture();
  for (const name of ['ca.pem', 'admin.pem', 'admin.key']) {
    await writeFile(path.join(mismatch.paths.targets.admin, name),
      name === 'admin.key' ? 'different-key' : await readFile(path.join(mismatch.paths.source, name)));
  }
  await expect(installBootstrapWithIdentities(mismatch.state, mismatch.data, mismatch.paths, owners)).rejects.toThrow();
  expect(await readdir(mismatch.state)).toEqual([]);
  expect(await readdir(mismatch.data)).toEqual([]);

  const valid = await identityFixture();
  expect(await installBootstrapWithIdentities(valid.state, valid.data, valid.paths, owners))
    .toEqual({ phase: 'fresh', kind: 'unintroduced' });
  expect(await readdir(valid.state)).toEqual(expect.arrayContaining(['phase', 'v1-first-init', 'v1-profile-grant']));
});

test('fresh grant is exclusive and incomplete predecessors never become fresh again', async () => {
  const { state, data } = await fixture();
  const results = await Promise.allSettled([installBootstrapState(state, data, owners),
    installBootstrapState(state, data, owners)]);
  expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  expect(await readBootstrapState(state, owners)).toEqual({ phase: 'fresh', kind: 'unintroduced' });
  expect(await readdir(state)).toEqual(expect.arrayContaining(['phase', 'v1-first-init', 'v1-profile-grant']));
  await rm(path.join(state, 'phase'));
  await expect(installBootstrapState(state, data, owners)).rejects.toThrow();
});

test('legacy fresh and ready are preserved without grant; malformed inventory and modes fail closed', async () => {
  const { state, data } = await fixture();
  await chmod(state, 0o770);
  await writeFile(path.join(state, 'phase'), 'fresh\n', { mode: 0o660 });
  await chmod(path.join(state, 'phase'), 0o660);
  expect(await installBootstrapState(state, data, owners)).toEqual({ phase: 'fresh', kind: 'legacy' });
  await ready(state);
  expect(await installBootstrapState(state, data, owners)).toEqual({ phase: 'ready', kind: 'legacy' });
  const legacy = access({ profile: async () => 'existing_uuid' });
  await verifyRetainedProfile(state, legacy.value, owners);
  expect(legacy.counts()).toEqual({ sends: 0, checks: 1 });
  await expect(introduceProfile(state, legacy.value, owners)).rejects.toThrow();
  await expect(verifyRetainedProfile(state, access().value, owners)).rejects.toThrow();
  await writeFile(path.join(data, 'retained'), 'x');
  expect(await installBootstrapState(state, data, owners)).toEqual({ phase: 'ready', kind: 'legacy' });
  await writeFile(path.join(state, 'extra'), 'x');
  await expect(readBootstrapState(state, owners)).rejects.toThrow();
  await rm(path.join(state, 'extra'));
  await symlink(path.join(state, 'phase'), path.join(state, 'v1-profile-claim'));
  await expect(readBootstrapState(state, owners)).rejects.toThrow();
  await rm(path.join(state, 'v1-profile-claim'));
  await chmod(path.join(state, 'phase'), 0o600);
  await expect(readBootstrapState(state, owners)).rejects.toThrow();
});

test('each partial installer predecessor and unintroduced data are rejected without repair', async () => {
  for (const partial of ['data', 'reservation', 'grant', 'partial-phase', 'missing-grant']) {
    const { state, data } = await fixture();
    if (partial === 'data') await writeFile(path.join(data, 'retained'), 'x');
    else {
      await chmod(state, 0o770);
      await writeFile(path.join(state, 'v1-first-init'), 'v1\n');
      await chmod(path.join(state, 'v1-first-init'), 0o440);
      if (partial === 'grant' || partial === 'partial-phase') {
        await writeFile(path.join(state, 'v1-profile-grant'), 'v1\n');
        await chmod(path.join(state, 'v1-profile-grant'), 0o440);
      }
      if (partial === 'partial-phase' || partial === 'missing-grant') {
        await writeFile(path.join(state, 'phase'), partial === 'partial-phase' ? 'fre' : 'fresh\n');
        await chmod(path.join(state, 'phase'), 0o660);
      }
    }
    const before = await readdir(state);
    await expect(installBootstrapState(state, data, owners)).rejects.toThrow();
    expect(await readdir(state)).toEqual(before);
  }
});

test('retained verification never creates and a claimed matching index remains incomplete', async () => {
  const { state, data } = await fixture();
  await installBootstrapState(state, data, owners); await ready(state);
  const existing = access({ profile: async () => 'uuid_1' });
  await expect(verifyRetainedProfile(state, existing.value, owners)).rejects.toThrow();
  expect(existing.counts()).toEqual({ sends: 0, checks: 0 });
  await claimBootstrapIntroduction(state, owners);
  await expect(verifyRetainedProfile(state, existing.value, owners)).rejects.toThrow();
  await expect(introduceProfile(state, existing.value, owners)).rejects.toThrow();
  expect(existing.counts()).toEqual({ sends: 0, checks: 0 });
  await completeBootstrapIntroduction(state, 'uuid_1', owners);
  await verifyRetainedProfile(state, existing.value, owners);
  await expect(verifyRetainedProfile(state, access({ profile: async () => 'uuid_2' }).value, owners)).rejects.toThrow();
  await expect(completeBootstrapIntroduction(state, 'uuid_2', owners)).rejects.toThrow();
});

test('only one introducer sends; a lost result, 409 and external create race retain the claim', async () => {
  const { state, data } = await fixture();
  await installBootstrapState(state, data, owners); await ready(state);
  let sends = 0;
  const candidate = access({ create: async () => { sends++; throw new SearchEngineError('timeout'); } });
  const results = await Promise.allSettled([introduceProfile(state, candidate.value, owners),
    introduceProfile(state, candidate.value, owners)]);
  expect(results.every(row => row.status === 'rejected')).toBe(true);
  expect(sends).toBe(1);
  expect(await readBootstrapState(state, owners)).toEqual({ phase: 'ready', kind: 'incomplete' });
  await expect(introduceProfile(state, access({ profile: async () => 'uuid_1' }).value, owners)).rejects.toThrow();
  expect(await readFile(path.join(state, 'v1-profile-claim'), 'utf8')).toBe('v1\n');

  const second = await fixture();
  await installBootstrapState(second.state, second.data, owners); await ready(second.state);
  const collision = access({ create: async () => { throw new SearchEngineError('status', 409); } });
  await expect(introduceProfile(second.state, collision.value, owners)).rejects.toThrow();
  expect(collision.counts().sends).toBe(1);
  expect((await readBootstrapState(second.state, owners)).kind).toBe('incomplete');

  const third = await fixture();
  await installBootstrapState(third.state, third.data, owners); await ready(third.state);
  const negative = access({ create: async () => { throw new SearchEngineError('partial'); } });
  await expect(introduceProfile(third.state, negative.value, owners)).rejects.toThrow();
  expect(negative.counts().sends).toBe(1);
  expect((await readBootstrapState(third.state, owners)).kind).toBe('incomplete');

  const fourth = await fixture();
  await installBootstrapState(fourth.state, fourth.data, owners); await ready(fourth.state);
  const failedReadback = access({ create: async () => { throw new SearchEngineError('profile'); } });
  await expect(introduceProfile(fourth.state, failedReadback.value, owners)).rejects.toThrow();
  expect(failedReadback.counts().sends).toBe(1);
  expect((await readBootstrapState(fourth.state, owners)).kind).toBe('incomplete');
});

test('preexisting index forbids a claim; acknowledged creation records its UUID once', async () => {
  const first = await fixture();
  await installBootstrapState(first.state, first.data, owners); await ready(first.state);
  const existing = access({ profile: async () => 'external' });
  await expect(introduceProfile(first.state, existing.value, owners)).rejects.toThrow();
  expect(existing.counts().sends).toBe(0);
  expect((await readBootstrapState(first.state, owners)).kind).toBe('unintroduced');

  const second = await fixture();
  await installBootstrapState(second.state, second.data, owners); await ready(second.state);
  const created = access();
  await introduceProfile(second.state, created.value, owners);
  expect(created.counts().sends).toBe(1);
  expect(await readBootstrapState(second.state, owners)).toEqual({ phase: 'ready', kind: 'complete', indexUuid: 'uuid_1' });
  const completion = await lstat(path.join(second.state, 'v1-profile-complete'));
  expect(completion.mode & 0o777).toBe(0o600);
  expect(completion.nlink).toBe(1);
  expect(await readFile(path.join(second.state, 'v1-profile-complete'), 'utf8')).toBe('v1\nuuid_1\n');
  await expect(introduceProfile(second.state, created.value, owners)).rejects.toThrow();
  await expect(verifyRetainedProfile(second.state, access().value, owners)).rejects.toThrow();
});
