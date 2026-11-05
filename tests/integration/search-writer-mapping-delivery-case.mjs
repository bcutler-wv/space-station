import assert from 'node:assert/strict';
import { readFile, lstat, readdir, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { runWriterMappingApplyOwner } from '../../scripts/search-writer-mapping-apply-owner-core.mjs';
import { createWriterMappingApplyDockerAdapter } from '../../scripts/search-create-boundary-owner-docker.mjs';
import { deriveWriterMappingRequest } from '../../packages/search/dist/opensearch-writer-role-contract.js';
import { compareObservedSecurityCollections } from
  '../../packages/search/dist/opensearch-generation-policy.js';
import { readWriterMappingPending } from '../../scripts/search-writer-role-pending.mjs';
import { writeWriterMappingBinding } from '../../scripts/search-writer-role-binding.mjs';
import { stageWriterMappingApplyPublic } from '../../scripts/search-writer-mapping-apply-public-stage.mjs';
import { captureCandidateWriterPublic } from '../../scripts/search-writer-mapping-public.mjs';
import { captureCreateIntentPublic } from '../../scripts/search-create-intent-public.mjs';
import { writerDeliveryTrace, writerDeliveryShape, writerDeliveryMethodTracker } from
  '../support/search-writer-mapping-delivery-diagnostic.mjs';
import { writerDeliveryCreateOutput } from
  '../support/search-writer-mapping-create-output-diagnostic.mjs';

const micro = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const modes = ['positive', 'prestart', 'lost-return', 'false-ack', 'held-timeout'];
const markerSet = new Set(['CAS_REQUEST_R1', 'CAS_ARM_R2', 'CAS_SEND_R3',
  'CAS_CONFIRM_R4', 'CAS_ATTEST_R5', 'DB_SENT_UNKNOWN_AT_PUT', 'PRODUCER_PUT',
  'CONNECTION_PUT', 'REAL_RESPONSE_RECEIVED', 'ORIGINAL_201_CREATED',
  'REAL_RESPONSE_HELD', 'REAL_RESPONSE_RELEASED', 'ORIGINAL_ABORT', 'REAL_RESPONSE_CLOSED',
  'ARM_TIMESTAMP_PINNED', 'ARM_TIMESTAMP_MATCHED', 'ARM_TIMESTAMP_AT_PUT']);
const originalSuccess = 'Private writer mapping apply completed; search remains disabled.\n';
const originalFailure = 'Private writer mapping apply owner failed.\n';
const same = (a, b) => assert.deepEqual(a, b);
const present = async file => lstat(file).then(() => true, error => {
  if (error?.code === 'ENOENT') return false;
  throw error;
});
const identityKeys = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink'];
const parentProof = async file => {
  const parent = path.dirname(file);
  return { parent, stat: await lstat(parent), names: (await readdir(parent)).sort() };
};
const recheckParent = async proof => {
  const now = await lstat(proof.parent);
  for (const key of identityKeys) assert.equal(now[key], proof.stat[key]);
  same((await readdir(proof.parent)).sort(), proof.names);
  const after = await lstat(proof.parent);
  for (const key of identityKeys) assert.equal(after[key], proof.stat[key]);
};

/** One disposable project and one verified mapping proposal; no uncertain-state reset. */
export async function runWriterMappingDeliveryCase(ctx) {
  const { deliveryCase: mode, repository, project, uid, gid, candidate, roleResult,
    mappingResult, command, docker, registry, engine, state, adminFiles,
    hostResources, sources, snapshot, databaseIdentity, ownerEnv, fixtureRoot,
    hash, setCheckpoint } = ctx;
  assert.ok(modes.includes(mode));
  let step = 'approval';
  const report = () => process.stderr.write(`Writer mapping delivery fixture case=${mode} step=${step}.\n`);
  setCheckpoint(`writer-mapping-delivery-${mode}`);
  try {
    const pending = path.join(repository, '.cache/search-writer-mapping-intent/pending.json');
    const lock = path.join(repository, '.cache/search-db/.job-operation.lock');
    const mappingBytes = await readFile(pending);
    const mappingStat = await lstat(pending);
    const mappingParent = await parentProof(pending);
    assert.equal(mappingStat.mode & 0o777, 0o400);
    same(mappingBytes, mappingResult.pendingBytes);
    const intent = JSON.parse(mappingBytes.toString('utf8'));
    same(intent, mappingResult.intent);
    const original = await snapshot();
    const originalDatabase = await databaseIdentity();
    assert.equal(original.registry.control.stage, 'writer_role_attested');
    assert.equal(original.registry.control.revision, intent.revision);
    assert.equal(original.registry.control.publication_enabled, false);
    assert.equal(original.registry.control.serving_ready, false);
    const originalCandidate = original.registry.history.find(row =>
      row.generation_token === mappingResult.intent.candidateToken);
    assert.ok(originalCandidate);
    assert.equal(originalCandidate.writer_cert_fingerprint, null);
    assert.equal(originalCandidate.query_cert_fingerprint, null);
    assert.equal(await present(lock), false);
    const oldFiles = ['.cache/search-create-intent/pending.json',
      '.cache/search-create-apply/binding.json',
      '.cache/search-writer-role-intent/pending.json',
      '.cache/search-writer-role-apply/binding.json'].map(name => path.join(repository, name));
    const oldBytes = await Promise.all(oldFiles.map(file => readFile(file)));
    const oldStats = await Promise.all(oldFiles.map(file => lstat(file)));
    const oldParents = await Promise.all(oldFiles.map(parentProof));
    for (let i = 0; i < oldFiles.length; i++) {
      same(oldBytes[i], mappingResult.originalFiles[i].bytes);
      assert.equal(oldStats[i].ino, mappingResult.originalFiles[i].stat.ino);
      assert.equal(oldStats[i].dev, mappingResult.originalFiles[i].stat.dev);
    }
    const request = deriveWriterMappingRequest({ token: intent.candidateToken,
      index: intent.candidateIndex, profile: 'station-mail-v2', uuid: intent.candidateUuid,
      writerRole: roleResult.intent.target,
      writerPrincipal: mappingResult.signer.writerPrincipal });
    assert.equal(intent.candidateIndex, candidate);
    for (const key of ['transitionToken', 'sourceToken', 'sourceIndex', 'sourceUuid',
      'candidateToken', 'candidateIndex', 'candidateUuid', 'databaseOid',
      'project', 'systemIdentifier']) assert.equal(intent[key], roleResult.intent[key]);
    assert.equal(intent.project, project);
    assert.equal(intent.databaseOid, originalDatabase.databaseOid);
    assert.equal(intent.systemIdentifier, originalDatabase.systemIdentifier);
    assert.equal(intent.boundControlUpdatedAt, original.registry.microseconds.control);
    same(intent.state, original.state);
    same(intent.priorPublicDigests, roleResult.intent.publicDigests);
    assert.equal(intent.candidatePublic.writerPrincipal, mappingResult.signer.writerPrincipal);
    assert.equal(intent.candidatePublic.writerFingerprint,
      mappingResult.signer.writerCertFingerprint);
    same(intent.candidatePublic.publicDigests, mappingResult.candidatePublicDigests);
    assert.equal(intent.candidatePublic.caSha256,
      intent.priorPublicDigests.find(row => row.path === 'ca.pem')?.sha256);
    assert.equal(intent.candidatePublic.writerSha256,
      mappingResult.candidatePublicDigests.find(row => row.path.endsWith('/writer.pem'))?.sha256);
    const publicEvidence = await captureCandidateWriterPublic({ repository, uid, gid,
      candidateToken: intent.candidateToken, signerResult: mappingResult.signer });
    same(publicEvidence.publicDigests, mappingResult.candidatePublicDigests);
    await publicEvidence.recheck();
    const priorPublic = await captureCreateIntentPublic({ repository, uid, gid,
      files: roleResult.intent.publicFiles,
      scratchRoot: path.join(repository, '.cache/search-create-intent') });
    same(priorPublic.publicDigests, intent.priorPublicDigests);
    await priorPublic.recheck();
    assert.equal(intent.target, request.target);
    assert.equal(Object.hasOwn(original.engine.mappings, request.target), false);
    assert.equal(intent.bodySha256, request.bodySha256);
    assert.equal(intent.bodyIdentity, request.dispatchBodyIdentity);
    assert.equal(intent.createApprovedSha256, hash(oldBytes[0]));
    assert.equal(intent.roleApprovedSha256, hash(oldBytes[2]));
    assert.equal(intent.originalCreateBindingSha256, hash(oldBytes[1]));
    assert.equal(intent.originalRoleBindingSha256, hash(oldBytes[3]));
    assert.equal(intent.createApprovedSha256, mappingResult.intent.createApprovedSha256);
    assert.equal(intent.roleApprovedSha256, roleResult.approvedSha256);
    assert.equal(hash(mappingBytes), mappingResult.approvedSha256);
    const approvedSha = mappingResult.approvedSha256;
    const args = [approvedSha, String(intent.revision), intent.transitionToken,
      intent.sourceToken, intent.sourceIndex, intent.sourceUuid, intent.candidateToken,
      intent.candidateIndex, intent.candidateUuid];
    assert.deepEqual(intent.originalIds, [JSON.parse(oldBytes[0]).dispatchId,
      JSON.parse(oldBytes[0]).ownerId, JSON.parse(oldBytes[1]).invocationId,
      JSON.parse(oldBytes[2]).dispatchId, JSON.parse(oldBytes[2]).ownerId,
      JSON.parse(oldBytes[3]).invocationId]);
    assert.equal(new Set([...intent.originalIds, intent.dispatchId, intent.ownerId]).size, 8);
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
      `${project}-search-writer-mapping-prepare`, 'node', '--input-type=module', '-e', infoScript],
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
    const mappingBinding = path.join(repository, '.cache/search-writer-mapping-apply/binding.json');
    assert.equal(await present(mappingBinding), false);
    assert.equal(await present(lock), false);
    const created = [], starts = [], fences = [], createdStates = [], order = [];
    const diagnostic = { method: 'none', phase: 'owner', command: 'none',
      outcome: 'none', last: 'none', create: 0, inspect: 0, fence: 0, start: 0 };
    const trackMethod = writerDeliveryMethodTracker(diagnostic);
    const increment = value => value === 'many' || value === 2 ? 'many' : value + 1;
    const shapes = [];
    const createOutputs = [], renderedNames = new Map();
    let createCaptureError = false;
    const category = args => {
      if (args[0] === 'compose') {
        if (args.includes('create') && args.includes('--no-recreate')) return 'compose-create';
        if (args.includes('config')) return 'compose-config';
        if (args.includes('ps')) return 'compose-ps';
      }
      if (args[0] === 'container') {
        const value = { inspect: 'container-inspect', start: 'container-start',
          wait: 'container-wait', logs: 'container-logs', rm: 'container-rm' }[args[1]];
        if (value) return value;
      }
      if (args[0] === 'volume') {
        const value = { inspect: 'volume-inspect', create: 'volume-create',
          rm: 'volume-rm' }[args[1]];
        if (value) return value;
      }
      return 'other';
    };
    const phaseMethod = name => async (...params) => trackMethod(name, () => ({
        'pending-read': readWriterMappingPending,
        'binding-write': writeWriterMappingBinding,
        'public-stage': stageWriterMappingApplyPublic,
      }[name])(...params));
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
      diagnostic.command = category(args);
      if (diagnostic.command === 'compose-create') diagnostic.create = increment(diagnostic.create);
      if (diagnostic.command === 'container-inspect' && created.length > createdStates.length)
        diagnostic.inspect = increment(diagnostic.inspect);
      if (diagnostic.command === 'container-start') diagnostic.start = increment(diagnostic.start);
      let result;
      try { result = await command('docker', args, env, timeoutMs); }
      catch (error) { diagnostic.outcome = 'threw'; throw error; }
      diagnostic.outcome = result.signal ? 'signaled' :
        result.code === 0 ? 'returned-zero' : 'returned-nonzero';
      if (diagnostic.command === 'compose-config' && result.code === 0) {
        try {
          const services = JSON.parse(result.stdout).services;
          for (const service of ['search-writer-mapping-apply-transfer',
            'search-writer-mapping-apply']) {
            const name = services?.[service]?.container_name;
            if (typeof name === 'string') renderedNames.set(service, name);
          }
        } catch { createCaptureError = true; }
      }
      if (diagnostic.command === 'compose-create') {
        const service = args.at(-1);
        try {
          createOutputs.push(writerDeliveryCreateOutput({ caseName: mode,
            phase: service === 'search-writer-mapping-apply-transfer' ? 'transfer' : 'apply',
            response: result, expectedName: renderedNames.get(service) ?? null }));
          if (!renderedNames.has(service)) createCaptureError = true;
        } catch { createCaptureError = true; }
      }
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
        if (prior?.service === 'search-writer-mapping-apply') {
          process.stderr.write(result.stderr);
          applyLogReturns.push({ ...result });
        }
      }
      if (args[0] === 'container' && args[1] === 'wait' &&
          mode !== 'prestart' && result.code === 0 && result.stdout !== '0\n') {
        const prior = createdStates.find(item => item.id === args.at(-1));
        if (prior?.service === 'search-writer-mapping-apply') await captureApplyLog(prior.id);
      }
      if (args[0] === 'container' && args[1] === 'inspect' && result.code === 0) {
        const item = JSON.parse(result.stdout)[0];
        const service = item?.Config?.Labels?.['com.docker.compose.service'];
        if (['search-writer-mapping-apply-transfer', 'search-writer-mapping-apply'].includes(service) &&
            created.length > createdStates.length) {
          const networkNames = Object.keys(item.NetworkSettings?.Networks ?? {}).sort();
          const networkShape = service === 'search-writer-mapping-apply-transfer' ?
            networkNames.length === 0 ? 'empty' : networkNames.join('|') === 'none' ? 'none' : 'invalid' :
            networkNames.join('|') === [`${project}_search_admin_db`,
              `${project}_search_internal`].sort().join('|') ? 'admin-internal' : 'invalid';
          const zeroTime = value => value === '0001-01-01T00:00:00Z' ? 'zero' :
            value === undefined ? 'missing' : typeof value === 'string' ? 'nonzero' : 'other';
          const operationalEmpty = item.State.Error === '' &&
            item.State.OOMKilled === false && item.State.Dead === false &&
            item.State.ExitCode === 0 && item.State.Paused === false &&
            item.State.Restarting === false;
          const endpointMap = item.NetworkSettings?.Networks;
          const networkFields = !endpointMap || typeof endpointMap !== 'object' ?
            'unknown' : Object.values(endpointMap).every(endpoint => endpoint &&
              typeof endpoint === 'object' && !endpoint.EndpointID &&
              !endpoint.Gateway && !endpoint.IPAddress && !endpoint.MacAddress &&
              !endpoint.IPPrefixLen && !endpoint.IPv6Gateway &&
              !endpoint.GlobalIPv6Address && !endpoint.GlobalIPv6PrefixLen &&
              !endpoint.Links?.length &&
              (!endpoint.IPAMConfig || Object.keys(endpoint.IPAMConfig).length === 0) &&
              !endpoint.DriverOpts && !endpoint.GwPriority && !endpoint.DNSNames?.length) ?
            'empty' : 'nonempty';
          shapes.push({ caseName: mode, phase: service === 'search-writer-mapping-apply-transfer' ?
            'transfer' : 'apply', state: item.State.Status === 'created' ? 'created' : 'other',
          running: String(item.State.Running) === 'true' ? 'true' :
            item.State.Running === false ? 'false' : 'other',
          started: zeroTime(item.State.StartedAt), finished: zeroTime(item.State.FinishedAt),
          network: ['empty', 'none', 'admin-internal'].includes(networkShape) ?
            networkShape : 'other', stateFields: operationalEmpty ? 'empty' : 'other',
          networkFields });
        }
        if (item?.State?.Status === 'created' &&
            ['search-writer-mapping-apply-transfer', 'search-writer-mapping-apply'].includes(service)) {
          const networkNames = Object.keys(item.NetworkSettings?.Networks ?? {}).sort();
          const networkShape = service === 'search-writer-mapping-apply-transfer' ?
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
            service === 'search-writer-mapping-apply' &&
            mode === 'prestart' && !prestartReached) {
          const held = path.join(fixtureRoot, 'mapping-pending-held');
          heldOriginal = held;
          await rename(pending, held);
          await writeFile(pending, mappingBytes, { flag: 'wx', mode: 0o400 });
          assert.notEqual((await lstat(pending)).ino, mappingStat.ino);
          prestartReached = true;
        }
        if (item?.State?.Status === 'exited' && item.State.ExitCode !== 0 &&
            service === 'search-writer-mapping-apply' && mode !== 'prestart')
          await captureApplyLog(item.Id);
      }
      return result;
    };
    let baseImage = null;
    if (mode !== 'positive' && mode !== 'prestart') {
      step = 'derived-image';
      const name = `${project}-search-writer-mapping-apply`;
      baseImage = JSON.parse(await docker(['image', 'inspect', name]))[0].Id;
      assert.match(baseImage, /^sha256:[0-9a-f]{64}$/);
      const baseTag = `${project}-mapping-delivery-original`;
      await docker(['image', 'tag', baseImage, baseTag]);
      assert.equal(JSON.parse(await docker(['image', 'inspect', baseTag]))[0].Id, baseImage);
      await docker(['build', '--pull=false', '--network=none', '--build-arg', `BASE=${baseTag}`,
        '--build-arg', `MODE=${mode}`, '-f',
        'tests/integration/search-writer-mapping-delivery-fixture.Dockerfile', '-t', name, '.'], 120_000);
      const derived = JSON.parse(await docker(['image', 'inspect', name]))[0].Id;
      assert.match(derived, /^sha256:[0-9a-f]{64}$/);
      assert.notEqual(derived, baseImage);
    }
    step = 'owner';
    let outcome;
    if (mode === 'positive') {
      outcome = await command('node', ['scripts/search-writer-mapping-apply-owner.mjs', ...args],
        ownerEnv, 480_000);
      assert.equal(outcome.code, 0);
      assert.equal(outcome.signal, null);
      assert.equal(outcome.stderr, '');
      assert.equal(outcome.stdout, originalSuccess);
    } else {
      try {
        await runWriterMappingApplyOwner({ repository, uid, gid, args,
          pendingReader: phaseMethod('pending-read'),
          bindingWriter: phaseMethod('binding-write'),
          publicStage: phaseMethod('public-stage'),
          adapterFactory: input => {
            diagnostic.method = 'adapter-factory';
            const adapter = createWriterMappingApplyDockerAdapter(input, { command: faultCommand });
            diagnostic.last = 'adapter-factory';
            const wrapped = {};
            for (const [key, label] of Object.entries({ verifyOwner: 'verify-owner',
              captureOwner: 'capture-owner', recheckOwner: 'recheck-owner',
              recheckInfrastructure: 'recheck-infrastructure', preflight: 'preflight',
              volumeAbsent: 'volume-absent', createVolume: 'create-volume',
              checkVolume: 'check-volume', containersAbsent: 'containers-absent',
              cleanupRemote: 'cleanup-remote',
              cleanupPrivate: 'cleanup-private' })) {
              wrapped[key] = (...params) => trackMethod(label, async () => {
                diagnostic.phase = label.startsWith('cleanup') ? 'cleanup' : diagnostic.phase;
                return adapter[key](...params);
              });
            }
            wrapped.runPhase = (phase, beforeStart) => trackMethod(
              phase === 'transfer' ? 'run-transfer' : 'run-apply', () => {
              diagnostic.phase = phase;
              return adapter.runPhase(phase, () => trackMethod(
                phase === 'transfer' ? 'fence-transfer' : 'fence-apply', async () => {
                await beforeStart();
                diagnostic.fence = increment(diagnostic.fence);
                fences.push(phase);
                order.push(`fence:search-writer-mapping-apply${phase === 'transfer' ? '-transfer' : ''}`);
              }));
            });
            return wrapped;
          } });
        outcome = { status: 'fulfilled' };
      } catch { outcome = { status: 'rejected' }; }
      process.stderr.write(`${writerDeliveryTrace({ caseName: mode, ...diagnostic })}\n`);
      for (const shape of shapes) process.stderr.write(`${writerDeliveryShape(shape)}\n`);
      if (outcome.status === 'rejected')
        for (const line of createOutputs) process.stderr.write(`${line}\n`);
      assert.equal(createCaptureError, false);
      assert.equal(outcome.status, 'rejected');
    }
    step = 'phase-counts';
    assert.equal(created.length, mode === 'positive' ? 0 : mode === 'prestart' ? 2 : 2);
    assert.equal(starts.length, mode === 'positive' ? 0 : mode === 'prestart' ? 1 : 2);
    if (mode !== 'positive') {
      same(created, ['search-writer-mapping-apply-transfer', 'search-writer-mapping-apply']);
      same(createdStates.map(item => item.service), created);
      assert.ok(['empty', 'none'].includes(createdStates[0].networkShape));
      assert.equal(createdStates[1].networkShape, 'admin-internal');
      same(fences, mode === 'prestart' ? ['transfer'] : ['transfer', 'apply']);
      const transfer = 'search-writer-mapping-apply-transfer', apply = 'search-writer-mapping-apply';
      same(order, [`create:${transfer}`, `inspect:${transfer}`, `fence:${transfer}`, `start:${transfer}`,
        `create:${apply}`, `inspect:${apply}`,
        ...(mode === 'prestart' ? [] : [`fence:${apply}`, `start:${apply}`])]);
    }
    assert.equal(prestartReached, mode === 'prestart');
    step = 'phase-registry';
    const rows = await registry();
    const observed = await engine();
    same(await databaseIdentity(), originalDatabase);
    step = 'phase-originals';
    same(await state(), original.state);
    same(await adminFiles(), original.admin);
    same(await hostResources(), original.host);
    same(await sources(), original.sources);
    await publicEvidence.recheck();
    await priorPublic.recheck();
    await recheckParent(mappingParent);
    for (const proof of oldParents) await recheckParent(proof);
    for (let i = 0; i < oldFiles.length; i++) {
      same(await readFile(oldFiles[i]), oldBytes[i]);
      const now = await lstat(oldFiles[i]);
      for (const key of ['dev', 'ino', 'uid', 'gid', 'mode'])
        assert.equal(now[key], oldStats[i][key]);
    }
    step = 'phase-registry';
    const expectedRevision = intent.revision +
      (mode === 'positive' ? 5 : mode === 'prestart' ? 0 : 3);
    assert.equal(rows.control.revision, expectedRevision);
    assert.equal(rows.control.stage, mode === 'positive' ? 'writer_attested' :
      mode === 'prestart' ? 'writer_role_attested' : 'writer_mapping_requested');
    assert.equal(rows.control.publication_enabled, false);
    assert.equal(rows.control.serving_ready, false);
    const oldControl = { ...rows.control, revision: original.registry.control.revision,
      stage: original.registry.control.stage,
      updated_at: original.registry.control.updated_at };
    same(oldControl, original.registry.control);
    assert.match(rows.microseconds.control, micro);
    if (mode === 'prestart') same(rows.microseconds.control, original.registry.microseconds.control);
    same(rows.history, original.registry.history);
    same(rows.microseconds.history, original.registry.microseconds.history);
    const mappingRow = row => row.operation === 'writer_mapping' &&
      row.generation_token === intent.candidateToken;
    const newRows = rows.dispatch.filter(mappingRow);
    assert.equal(newRows.length, mode === 'prestart' ? 0 : 1);
    same(rows.dispatch.filter(row => !mappingRow(row)), original.registry.dispatch);
    const mappingSidecar = row => row[0] === intent.candidateToken && row[1] === 'writer_mapping';
    const newTimes = rows.microseconds.dispatch.filter(mappingSidecar);
    assert.equal(newTimes.length, mode === 'prestart' ? 0 : 1);
    same(rows.microseconds.dispatch.filter(row => !mappingSidecar(row)),
      original.registry.microseconds.dispatch);
    if (newRows.length) {
      const row = newRows[0];
      assert.equal(row.dispatch_id, intent.dispatchId);
      assert.equal(row.owner_id, intent.ownerId);
      assert.equal(row.target, intent.target);
      assert.equal(row.body_identity, intent.bodyIdentity);
      assert.equal(row.state, mode === 'positive' ? 'response_confirmed' : 'sent_unknown');
      assert.match(newTimes[0][2], micro);
    }
    step = 'phase-engine';
    same(observed.indexes, original.engine.indexes);
    same(observed.roles, original.engine.roles);
    const reachedPut = ['positive', 'lost-return', 'false-ack', 'held-timeout'].includes(mode);
    if (reachedPut) {
      assert.deepEqual(Object.keys(observed.mappings).sort(),
        [...Object.keys(original.engine.mappings), intent.target].sort());
      const priorMappings = { ...observed.mappings };
      delete priorMappings[intent.target];
      same(priorMappings, original.engine.mappings);
      assert.equal(compareObservedSecurityCollections({ version: 'opensearch-3.9.0.0-station-v2',
        roles: original.engine.roles,
        mappings: { ...original.engine.mappings, [intent.target]: request.body } },
      observed.roles, observed.mappings), 'exact');
    } else same(observed.mappings, original.engine.mappings);
    step = 'phase-binding';
    const bindingBytes = await readFile(mappingBinding);
    const bindingStat = await lstat(mappingBinding);
    const bindingParent = await parentProof(mappingBinding);
    const binding = JSON.parse(bindingBytes.toString('utf8'));
    assert.deepEqual(Object.keys(binding).sort(),
      ['approvedSha256', 'dispatchId', 'invocationId', 'ownerId', 'version']);
    assert.equal(binding.version, 1);
    assert.match(binding.invocationId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(binding.approvedSha256, approvedSha);
    assert.equal(binding.dispatchId, intent.dispatchId);
    assert.equal(binding.ownerId, intent.ownerId);
    assert.equal(new Set([...intent.originalIds, intent.dispatchId, intent.ownerId,
      binding.invocationId]).size, 9);
    assert.equal(bindingStat.mode & 0o777, 0o400);
    assert.equal(await present(lock), mode !== 'positive');
    step = 'phase-resources';
    for (const [index, service] of ['search-writer-mapping-apply-transfer',
      'search-writer-mapping-apply'].entries()) {
      const remaining = (await docker(['ps', '-a', '--no-trunc', '--filter',
        `label=com.docker.compose.project=${project}`, '--filter',
        `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}'])).trim();
      assert.equal(remaining, mode === 'positive' ? '' : createdStates[index].id);
    }
    const remainingVolumes = (await docker(['volume', 'ls', '--filter',
      `label=station.create.project=${project}`, '--format', '{{.Name}}'])).trim();
    if (mode === 'positive') assert.equal(remainingVolumes, '');
    else assert.match(remainingVolumes,
      new RegExp(`^${project}_search_writer_mapping_apply_[0-9a-f]{32}$`));
    if (mode !== 'positive') {
      step = 'consumer-markers';
      if (mode !== 'prestart') {
        assert.equal(applyLogReturns.length, 1);
        const raw = applyLogReturns[0];
        assert.equal(raw.code, 0);
        assert.equal(raw.stdout, '');
        await writeFile(path.join(fixtureRoot, `mapping-consumer-${mode}.log`), raw.stderr,
          { flag: 'wx', mode: 0o600 });
        const lines = raw.stderr.trimEnd().split('\n');
        const markers = lines.filter(line => line.startsWith('WRITER_MAPPING_DELIVERY_FIXTURE:'))
          .map(line => line.slice('WRITER_MAPPING_DELIVERY_FIXTURE:'.length));
        assert.equal(markers.some(name => !markerSet.has(name)), false);
        const expected = mode === 'held-timeout' ? ['CAS_REQUEST_R1', 'CAS_ARM_R2',
          'ARM_TIMESTAMP_PINNED', 'CAS_SEND_R3', 'ARM_TIMESTAMP_MATCHED',
          'DB_SENT_UNKNOWN_AT_PUT', 'ARM_TIMESTAMP_AT_PUT', 'PRODUCER_PUT', 'CONNECTION_PUT',
          'REAL_RESPONSE_HELD', 'ORIGINAL_ABORT', 'REAL_RESPONSE_CLOSED'] :
          ['CAS_REQUEST_R1', 'CAS_ARM_R2', 'ARM_TIMESTAMP_PINNED', 'CAS_SEND_R3',
            'ARM_TIMESTAMP_MATCHED', 'DB_SENT_UNKNOWN_AT_PUT', 'ARM_TIMESTAMP_AT_PUT',
            'PRODUCER_PUT', 'CONNECTION_PUT', 'REAL_RESPONSE_RECEIVED', 'ORIGINAL_201_CREATED'];
        same(markers, expected);
        same(lines.filter(line => !line.startsWith('WRITER_MAPPING_DELIVERY_FIXTURE:')),
          ['Private writer mapping apply failed.']);
      }
      if (heldOriginal) {
        await rm(pending);
        await rename(heldOriginal, pending);
        assert.equal((await lstat(pending)).ino, mappingStat.ino);
      }
      step = 'replay';
      await rm(lock);
      const replay = await command('node', ['scripts/search-writer-mapping-apply-owner.mjs', ...args],
        ownerEnv, 30_000);
      assert.equal(replay.code, 1);
      assert.equal(replay.stdout, '');
      assert.equal(replay.stderr, originalFailure);
      same(await registry(), rows);
      same(await engine(), observed);
    }
    same(await readFile(pending), mappingBytes);
    const restoredStat = await lstat(pending);
    for (const key of ['dev', 'ino', 'uid', 'gid', 'mode'])
      assert.equal(restoredStat[key], mappingStat[key]);
    await recheckParent(mappingParent);
    same(await readFile(mappingBinding), bindingBytes);
    const currentBinding = await lstat(mappingBinding);
    for (const key of identityKeys) assert.equal(currentBinding[key], bindingStat[key]);
    await recheckParent(bindingParent);
    for (let i = 0; i < oldFiles.length; i++) {
      same(await readFile(oldFiles[i]), oldBytes[i]);
      const now = await lstat(oldFiles[i]);
      for (const key of ['dev', 'ino', 'uid', 'gid', 'mode'])
        assert.equal(now[key], oldStats[i][key]);
      await recheckParent(oldParents[i]);
    }
    await publicEvidence.recheck();
    await priorPublic.recheck();
    process.stdout.write(`Writer mapping delivery summary case=${mode} pair=${uid === 1000 ? 'default' : 'runner'} ` +
      `revision=${mode === 'positive' ? 5 : mode === 'prestart' ? 0 : 3} ` +
      `create=${mode === 'positive' ? 'unobserved' : created.length} ` +
      `start=${mode === 'positive' ? 'unobserved' : starts.length} ` +
      `put=${mode === 'positive' ? 'inferred-one' : mode === 'prestart' ? 'zero' : 'one'} checked=true.\n`);
    process.stdout.write(`Writer mapping delivery versions docker=${versions.docker} ` +
      `api=${versions.api} compose=${versions.compose} opensearch=${versions.opensearch} ` +
      `security=${mappingResult.securityVersion} sdk=3.9.0.\n`);
    if (mode !== 'positive') process.stdout.write('Writer mapping delivery created-shape ' +
      `transfer=${createdStates[0].networkShape} apply=${createdStates[1].networkShape} ` +
      `fence=${fences.length}.\n`);
  } catch {
    report();
    throw Error('Writer mapping delivery fixture failed');
  }
}
