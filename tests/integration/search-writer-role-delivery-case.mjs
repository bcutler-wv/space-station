import assert from 'node:assert/strict';
import { readFile, lstat, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { runWriterRoleApplyOwner } from '../../scripts/search-writer-role-apply-owner-core.mjs';
import { createWriterRoleApplyDockerAdapter } from '../../scripts/search-create-boundary-owner-docker.mjs';
import { deriveWriterRoleRequest } from '../../packages/search/dist/opensearch-writer-role-contract.js';
import { compareObservedSecurityCollections } from
  '../../packages/search/dist/opensearch-generation-policy.js';

const micro = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const modes = ['positive', 'prestart', 'lost-return', 'false-ack', 'held-timeout'];
const markerSet = new Set(['CAS_REQUEST_R1', 'CAS_ARM_R2', 'CAS_SEND_R3',
  'CAS_CONFIRM_R4', 'CAS_ATTEST_R5', 'DB_SENT_UNKNOWN_AT_PUT', 'PRODUCER_PUT',
  'CONNECTION_PUT', 'REAL_RESPONSE_RECEIVED', 'ORIGINAL_201_CREATED',
  'REAL_RESPONSE_HELD', 'REAL_RESPONSE_RELEASED', 'ORIGINAL_ABORT', 'REAL_RESPONSE_CLOSED',
  'ARM_TIMESTAMP_PINNED', 'ARM_TIMESTAMP_MATCHED', 'ARM_TIMESTAMP_AT_PUT']);
const originalSuccess = 'Private writer role apply completed; search remains disabled.\n';
const originalFailure = 'Private writer role apply owner failed.\n';
const same = (a, b) => assert.deepEqual(a, b);
const present = async file => lstat(file).then(() => true, error => {
  if (error?.code === 'ENOENT') return false;
  throw error;
});

/** One disposable project and exactly one role approval; no uncertain-state reset. */
export async function runWriterRoleDeliveryCase(ctx) {
  const { deliveryCase: mode, repository, project, uid, gid, candidate, baseline, securityPolicy,
    createBytes, oldBindingBytes, roleArgs, command, docker, registry, engine,
    state, adminFiles, hostResources, sources, pending, lock, ownerEnv, fixtureRoot, hash,
    setCheckpoint } = ctx;
  assert.ok(modes.includes(mode));
  let step = 'approval';
  const report = () => process.stderr.write(`Writer role delivery fixture case=${mode} step=${step}.\n`);
  setCheckpoint(`writer-delivery-${mode}`);
  try {
    const roleBytes = await readFile(pending);
    const roleStat = await lstat(pending);
    const oldCreateStat = await lstat(path.join(repository, '.cache/search-create-intent/pending.json'));
    const oldBindingStat = await lstat(path.join(repository, '.cache/search-create-apply/binding.json'));
    assert.equal(roleStat.mode & 0o777, 0o400);
    const intent = JSON.parse(roleBytes.toString('utf8'));
    const approvedSha = hash(roleBytes);
    const args = roleArgs(approvedSha);
    same(args, [approvedSha, String(intent.revision), intent.transitionToken,
      intent.sourceToken, intent.sourceIndex, intent.sourceUuid, intent.candidateToken,
      intent.candidateIndex, intent.candidateUuid]);
    assert.equal(intent.candidateIndex, candidate);
    assert.equal(intent.createApprovedSha256, hash(createBytes));
    assert.equal(intent.originalCreateBindingSha256, hash(oldBindingBytes));
    assert.equal(intent.revision, baseline.registry.control.revision);
    const originalRole = deriveWriterRoleRequest({ token: intent.candidateToken,
      index: intent.candidateIndex, profile: 'station-mail-v2', uuid: intent.candidateUuid,
      writerRole: intent.target });
    assert.equal(originalRole.bodySha256, intent.bodySha256);
    assert.equal(originalRole.dispatchBodyIdentity, intent.bodyIdentity);
    const original = { registry: baseline.registry, engine: baseline.engine,
      state: baseline.state, admin: baseline.admin, host: baseline.host,
      sources: baseline.sources };
    const infoScript = String.raw`import {Client} from '@opensearch-project/opensearch';
      import {readFile} from 'node:fs/promises';
      import {boundedSearchSdkEnvelope} from '/app/packages/search/dist/opensearch-runtime.js';
      const [ca,cert,key]=await Promise.all(['ca.pem','admin.pem','admin.key'].map(n=>
        readFile('/run/station-admin/'+n)));
      const client=new Client({node:'https://opensearch:9200',ssl:{ca,cert,key,rejectUnauthorized:true},
        maxRetries:0,requestTimeout:5000,sniffOnStart:false,sniffOnConnectionFault:false,
        sniffInterval:false});
      try{const result=await boundedSearchSdkEnvelope(o=>client.info({},o),32768,5000);
        const v=result.body?.version;
        if(v?.distribution!=='opensearch'||typeof v.number!=='string')throw Error('version');
        process.stdout.write(v.number);}finally{await client.close();}`;
    const engineVersion = (await docker(['run', '--rm', '--pull', 'never', '--network',
      `${project}_search_internal`, '--label', `station.create.gate=${project}`,
      '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000', '--mount',
      `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
      `${project}-search-writer-role-prepare`, 'node', '--input-type=module', '-e', infoScript],
    45_000)).trim();
    const versions = {
      docker: (await docker(['version', '--format', '{{.Server.Version}}'])).trim(),
      api: (await docker(['version', '--format', '{{.Server.APIVersion}}'])).trim(),
      compose: (await docker(['compose', 'version', '--short'])).trim(),
      opensearch: engineVersion,
    };
    assert.match(versions.docker, /^\d+\.\d+\.\d+$/);
    assert.match(versions.api, /^\d+\.\d+$/);
    assert.match(versions.compose, /^v?\d+\.\d+\.\d+$/);
    assert.equal(versions.opensearch, '3.9.0');
    const roleBinding = path.join(repository, '.cache/search-writer-role-apply/binding.json');
    assert.equal(await present(roleBinding), false);
    assert.equal(await present(lock), false);
    const created = [], starts = [], fences = [], createdStates = [], order = [];
    const applyLogReturns = [];
    const captureApplyLog = async id => {
      if (applyLogReturns.length) return;
      const raw = await command('docker', ['container', 'logs', id], ownerEnv);
      process.stderr.write(raw.stderr);
      applyLogReturns.push({ ...raw });
    };
    let prestartReached = false;
    let heldOriginal;
    const faultCommand = async (args, env, timeoutMs) => {
      const result = await command('docker', args, env, timeoutMs);
      if (args[0] === 'compose' && args.includes('create') && args.includes('--no-recreate'))
        { created.push(args.at(-1)); order.push(`create:${args.at(-1)}`); }
      if (args[0] === 'container' && args[1] === 'start') {
        starts.push(args[2]);
        const prior = createdStates.find(item => item.id === args[2]);
        assert.ok(prior);
        order.push(`start:${prior.service}`);
      }
      if (args[0] === 'container' && args[1] === 'logs') {
        const prior = createdStates.find(item => item.id === args.at(-1));
        if (prior?.service === 'search-writer-role-apply') {
          process.stderr.write(result.stderr);
          applyLogReturns.push({ ...result });
        }
      }
      if (args[0] === 'container' && args[1] === 'wait' &&
          mode !== 'prestart' && result.code === 0 && result.stdout !== '0\n') {
        const prior = createdStates.find(item => item.id === args.at(-1));
        if (prior?.service === 'search-writer-role-apply') await captureApplyLog(prior.id);
      }
      if (args[0] === 'container' && args[1] === 'inspect' && result.code === 0) {
        const item = JSON.parse(result.stdout)[0];
        const service = item?.Config?.Labels?.['com.docker.compose.service'];
        if (item?.State?.Status === 'created' &&
            ['search-writer-role-apply-transfer', 'search-writer-role-apply'].includes(service)) {
          const networkNames = Object.keys(item.NetworkSettings?.Networks ?? {}).sort();
          const networkShape = service === 'search-writer-role-apply-transfer' ?
            networkNames.length === 0 ? 'empty' : networkNames.join('|') === 'none' ? 'none' : 'invalid' :
            networkNames.join('|') === [`${project}_search_admin_db`,
              `${project}_search_internal`].sort().join('|') ? 'admin-internal' : 'invalid';
          assert.notEqual(networkShape, 'invalid');
          assert.equal(item.State.Running, false);
          assert.equal(item.State.StartedAt, '0001-01-01T00:00:00Z');
          assert.equal(item.State.FinishedAt, '0001-01-01T00:00:00Z');
          createdStates.push({ id: item.Id, service, networkShape });
          order.push(`inspect:${service}`);
        }
        if (item?.State?.Status === 'created' &&
            service === 'search-writer-role-apply' &&
            mode === 'prestart' && !prestartReached) {
          const held = path.join(fixtureRoot, 'role-pending-held');
          heldOriginal = held;
          await rename(pending, held);
          await writeFile(pending, roleBytes, { flag: 'wx', mode: 0o400 });
          assert.notEqual((await lstat(pending)).ino, roleStat.ino);
          prestartReached = true;
        }
        if (item?.State?.Status === 'exited' && item.State.ExitCode !== 0 &&
            service === 'search-writer-role-apply' && mode !== 'prestart')
          await captureApplyLog(item.Id);
      }
      return result;
    };
    let baseImage = null;
    if (mode !== 'positive' && mode !== 'prestart') {
      step = 'derived-image';
      const name = `${project}-search-writer-role-apply`;
      baseImage = JSON.parse(await docker(['image', 'inspect', name]))[0].Id;
      assert.match(baseImage, /^sha256:[0-9a-f]{64}$/);
      const baseTag = `${project}-writer-delivery-original`;
      await docker(['image', 'tag', baseImage, baseTag]);
      assert.equal(JSON.parse(await docker(['image', 'inspect', baseTag]))[0].Id, baseImage);
      await docker(['build', '--pull=false', '--network=none', '--build-arg', `BASE=${baseTag}`,
        '--build-arg', `MODE=${mode}`, '-f',
        'tests/integration/search-writer-role-delivery-fixture.Dockerfile', '-t', name, '.'], 120_000);
      const derived = JSON.parse(await docker(['image', 'inspect', name]))[0].Id;
      assert.match(derived, /^sha256:[0-9a-f]{64}$/);
      assert.notEqual(derived, baseImage);
    }
    step = 'owner';
    let outcome;
    if (mode === 'positive') {
      outcome = await command('node', ['scripts/search-writer-role-apply-owner.mjs', ...args],
        ownerEnv, 480_000);
      assert.equal(outcome.code, 0);
      assert.equal(outcome.signal, null);
      assert.equal(outcome.stderr, '');
      assert.equal(outcome.stdout, originalSuccess);
    } else {
      try {
        await runWriterRoleApplyOwner({ repository, uid, gid, args,
          adapterFactory: input => {
            const adapter = createWriterRoleApplyDockerAdapter(input, { command: faultCommand });
            return { ...adapter, runPhase: (phase, beforeStart) => adapter.runPhase(phase,
              async () => { await beforeStart(); fences.push(phase);
                order.push(`fence:search-writer-role-apply${phase === 'transfer' ? '-transfer' : ''}`); }) };
          } });
        outcome = { status: 'fulfilled' };
      } catch { outcome = { status: 'rejected' }; }
      assert.equal(outcome.status, 'rejected');
    }
    step = 'phase-evidence';
    assert.equal(created.length, mode === 'positive' ? 0 : mode === 'prestart' ? 2 : 2);
    assert.equal(starts.length, mode === 'positive' ? 0 : mode === 'prestart' ? 1 : 2);
    if (mode !== 'positive') {
      same(created, ['search-writer-role-apply-transfer', 'search-writer-role-apply']);
      same(createdStates.map(item => item.service), created);
      assert.ok(['empty', 'none'].includes(createdStates[0].networkShape));
      assert.equal(createdStates[1].networkShape, 'admin-internal');
      same(fences, mode === 'prestart' ? ['transfer'] : ['transfer', 'apply']);
      const transfer = 'search-writer-role-apply-transfer', apply = 'search-writer-role-apply';
      same(order, [`create:${transfer}`, `inspect:${transfer}`, `fence:${transfer}`, `start:${transfer}`,
        `create:${apply}`, `inspect:${apply}`,
        ...(mode === 'prestart' ? [] : [`fence:${apply}`, `start:${apply}`])]);
    }
    assert.equal(prestartReached, mode === 'prestart');
    const rows = await registry();
    const observed = await engine();
    same(await state(), original.state);
    same(await adminFiles(), original.admin);
    same(await hostResources(), original.host);
    const freshSources = await sources();
    assert.equal(freshSources.length, original.sources.length);
    for (let i = 0; i < freshSources.length; i++) same(freshSources[i], original.sources[i]);
    const expectedRevision = original.registry.control.revision +
      (mode === 'positive' ? 5 : mode === 'prestart' ? 0 : 3);
    assert.equal(rows.control.revision, expectedRevision);
    assert.equal(rows.control.stage, mode === 'positive' ? 'writer_role_attested' :
      mode === 'prestart' ? 'uuid_bound' : 'writer_role_requested');
    assert.equal(rows.control.publication_enabled, false);
    assert.equal(rows.control.serving_ready, false);
    const fixedControl = { ...rows.control };
    fixedControl.revision = original.registry.control.revision;
    fixedControl.stage = original.registry.control.stage;
    fixedControl.updated_at = original.registry.control.updated_at;
    same(fixedControl, original.registry.control);
    assert.match(rows.microseconds.control, micro);
    if (mode === 'prestart') same(rows.microseconds.control, original.registry.microseconds.control);
    same(rows.history, original.registry.history);
    same(rows.microseconds.history, original.registry.microseconds.history);
    same(rows.dispatch.slice(0, original.registry.dispatch.length), original.registry.dispatch);
    same(rows.microseconds.dispatch.slice(0, original.registry.microseconds.dispatch.length),
      original.registry.microseconds.dispatch);
    const roleRows = rows.dispatch.filter(row => row.operation === 'writer_role');
    assert.equal(roleRows.length, mode === 'prestart' ? 0 : 1);
    if (roleRows.length) {
      const row = roleRows[0];
      assert.equal(row.dispatch_id, intent.dispatchId);
      assert.equal(row.owner_id, intent.ownerId);
      assert.equal(row.target, intent.target);
      assert.equal(row.body_identity, intent.bodyIdentity);
      assert.equal(row.state, mode === 'positive' ? 'response_confirmed' : 'sent_unknown');
      const roleTime = rows.microseconds.dispatch.find(item => item[1] === 'writer_role')?.[2];
      assert.match(roleTime, micro);
    }
    same(observed.indexes, original.engine.indexes);
    same(observed.mappings, original.engine.mappings);
    if (mode === 'positive' || mode === 'lost-return' || mode === 'false-ack' || mode === 'held-timeout') {
      assert.deepEqual(Object.keys(observed.roles).sort(),
        [...Object.keys(original.engine.roles), intent.target].sort());
      const priorRoles = { ...observed.roles };
      delete priorRoles[intent.target];
      same(priorRoles, original.engine.roles);
      const postPolicy = { version: securityPolicy.version,
        roles: { ...securityPolicy.roles, [intent.target]: originalRole.body },
        mappings: securityPolicy.mappings };
      assert.equal(compareObservedSecurityCollections(postPolicy,
        observed.roles, observed.mappings), 'exact');
    } else same(observed.roles, original.engine.roles);
    const bindingBytes = await readFile(roleBinding);
    const binding = JSON.parse(bindingBytes.toString('utf8'));
    assert.equal(binding.approvedSha256, approvedSha);
    assert.equal(binding.dispatchId, intent.dispatchId);
    assert.equal(binding.ownerId, intent.ownerId);
    assert.equal(await present(lock), mode !== 'positive');
    for (const [index, service] of ['search-writer-role-apply-transfer',
      'search-writer-role-apply'].entries()) {
      const remaining = (await docker(['ps', '-a', '--no-trunc', '--filter',
        `label=com.docker.compose.project=${project}`, '--filter',
        `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}'])).trim();
      assert.equal(remaining, mode === 'positive' ? '' : createdStates[index].id);
    }
    const remainingVolumes = (await docker(['volume', 'ls', '--filter',
      `label=station.create.project=${project}`, '--format', '{{.Name}}'])).trim();
    if (mode === 'positive') assert.equal(remainingVolumes, '');
    else assert.match(remainingVolumes,
      new RegExp(`^${project}_search_writer_apply_[0-9a-f]{32}$`));
    if (mode !== 'positive') {
      step = 'consumer-markers';
      if (mode !== 'prestart') {
        assert.equal(applyLogReturns.length, 1);
        const raw = applyLogReturns[0];
        assert.equal(raw.code, 0);
        assert.equal(raw.stdout, '');
        await writeFile(path.join(fixtureRoot, `consumer-${mode}.log`), raw.stderr,
          { flag: 'wx', mode: 0o600 });
        const lines = raw.stderr.trimEnd().split('\n');
        const markers = lines.filter(line => line.startsWith('WRITER_DELIVERY_FIXTURE:'))
          .map(line => line.slice('WRITER_DELIVERY_FIXTURE:'.length));
        assert.equal(markers.some(name => !markerSet.has(name)), false);
        const expected = mode === 'held-timeout' ? ['CAS_REQUEST_R1', 'CAS_ARM_R2',
          'ARM_TIMESTAMP_PINNED', 'CAS_SEND_R3', 'ARM_TIMESTAMP_MATCHED',
          'DB_SENT_UNKNOWN_AT_PUT', 'ARM_TIMESTAMP_AT_PUT', 'PRODUCER_PUT', 'CONNECTION_PUT',
          'REAL_RESPONSE_HELD', 'ORIGINAL_ABORT', 'REAL_RESPONSE_CLOSED'] :
          ['CAS_REQUEST_R1', 'CAS_ARM_R2', 'ARM_TIMESTAMP_PINNED', 'CAS_SEND_R3',
            'ARM_TIMESTAMP_MATCHED', 'DB_SENT_UNKNOWN_AT_PUT', 'ARM_TIMESTAMP_AT_PUT',
            'PRODUCER_PUT', 'CONNECTION_PUT', 'REAL_RESPONSE_RECEIVED', 'ORIGINAL_201_CREATED'];
        same(markers, expected);
        same(lines.filter(line => !line.startsWith('WRITER_DELIVERY_FIXTURE:')),
          ['Private writer role apply failed.']);
      }
      if (heldOriginal) {
        await rm(pending);
        await rename(heldOriginal, pending);
        assert.equal((await lstat(pending)).ino, roleStat.ino);
      }
      step = 'replay';
      await rm(lock);
      const replay = await command('node', ['scripts/search-writer-role-apply-owner.mjs', ...args],
        ownerEnv, 30_000);
      assert.equal(replay.code, 1);
      assert.equal(replay.stdout, '');
      assert.equal(replay.stderr, originalFailure);
      same(await registry(), rows);
      same(await engine(), observed);
    }
    assert.deepEqual(await readFile(pending), roleBytes);
    const restoredRoleStat = await lstat(pending);
    assert.equal(restoredRoleStat.dev, roleStat.dev);
    assert.equal(restoredRoleStat.ino, roleStat.ino);
    assert.deepEqual(await readFile(path.join(repository, '.cache/search-create-intent/pending.json')),
      createBytes);
    assert.deepEqual(await readFile(path.join(repository, '.cache/search-create-apply/binding.json')),
      oldBindingBytes);
    for (const [file, originalStat] of [
      [path.join(repository, '.cache/search-create-intent/pending.json'), oldCreateStat],
      [path.join(repository, '.cache/search-create-apply/binding.json'), oldBindingStat]]) {
      const currentStat = await lstat(file);
      assert.equal(currentStat.dev, originalStat.dev);
      assert.equal(currentStat.ino, originalStat.ino);
      assert.equal(currentStat.mode, originalStat.mode);
    }
    process.stdout.write(`Writer role delivery summary case=${mode} pair=${uid === 1000 ? 'default' : 'runner'} ` +
      `revision=${mode === 'positive' ? 5 : mode === 'prestart' ? 0 : 3} ` +
      `create=${mode === 'positive' ? 'unobserved' : created.length} ` +
      `start=${mode === 'positive' ? 'unobserved' : starts.length} ` +
      `put=${mode === 'positive' ? 'inferred-one' :
        mode === 'prestart' ? 'zero' : 'one'} checked=true.\n`);
    process.stdout.write(`Writer role delivery versions docker=${versions.docker} ` +
      `api=${versions.api} compose=${versions.compose} opensearch=${versions.opensearch}.\n`);
    if (mode !== 'positive') process.stdout.write('Writer role delivery created-shape ' +
      `transfer=${createdStates[0].networkShape} apply=${createdStates[1].networkShape} ` +
      `fence=${fences.length}.\n`);
  } catch {
    report();
    throw Error('Writer role delivery fixture failed');
  }
}
