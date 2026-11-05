import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { runWriterMappingPrepareOwner } from
  '../../scripts/search-writer-mapping-prepare-owner-core.mjs';
import { createWriterMappingPrepareDockerAdapter } from
  '../../scripts/search-create-boundary-owner-docker.mjs';
import { captureCandidateWriterPublic } from '../../scripts/search-writer-mapping-public.mjs';
import { canonicalAttestorValue } from '../../scripts/search-attestor-pure.mjs';
import { validateWriterRoleCopiedEvidence } from
  '../../scripts/search-writer-role-apply-evidence.mjs';
import { deriveWriterMappingRequest } from
  '../../packages/search/dist/opensearch-writer-role-contract.js';
import { inspectWriterRolePostgres } from '../support/search-writer-role-postgres-probe.mjs';
import { mappingPrepareCommandKind, mappingPrepareMethodTracker, mappingPrepareTrace } from
  '../support/search-writer-mapping-prepare-diagnostic.mjs';

const originalSuccess = /^Private writer mapping proposal prepared: ([0-9a-f]{64})\n$/;
const originalFailure = 'Private writer mapping preparation owner failed.\n';
const id = /^[0-9a-f]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const present = async file => lstat(file).then(() => true, error => {
  if (error?.code === 'ENOENT') return false;
  throw error;
});
const same = (a, b) => assert.deepEqual(a, b);

/** One fresh disposable mapping proposal; no reset of a consumed approval. */
export async function runWriterMappingPrepareDeliveryCase(ctx) {
  const { mode, repository, project, uid, gid, candidate, createBytes,
    createApprovedSha256, roleResult, command, docker, sql, registry,
    snapshot, databaseIdentity,
    ownerEnv, fixtureRoot, sameSources, setCheckpoint } = ctx;
  assert.ok(['positive', 'measured'].includes(mode));
  assert.ok(ctx.handoff === undefined || ctx.handoff === true && mode === 'positive');
  let step = 'baseline';
  const checkpoint = name => { step = name; setCheckpoint(`mapping-${mode}-${name}`); };
  const oldFiles = ['.cache/search-create-intent/pending.json',
    '.cache/search-create-apply/binding.json',
    '.cache/search-writer-role-intent/pending.json',
    '.cache/search-writer-role-apply/binding.json'].map(name => path.join(repository, name));
  const pending = path.join(repository, '.cache/search-writer-mapping-intent/pending.json');
  const lock = path.join(repository, '.cache/search-db/.job-operation.lock');
  const services = ['search-writer-mapping-prepare-transfer',
    'search-writer-mapping-prepare'];
  const namePrefix = 'station_mapping_prepare_';
  let measuredFailureTrace = null;
  try {
    checkpoint('baseline');
    assert.equal(sha(roleResult.pendingBytes), roleResult.approvedSha256);
    assert.equal(sha(createBytes), createApprovedSha256);
    const originalFiles = await Promise.all(oldFiles.map(async file => ({
      bytes: await readFile(file), stat: await lstat(file) })));
    const old = validateWriterRoleCopiedEvidence({
      createIntent: originalFiles[0].bytes, createBinding: originalFiles[1].bytes,
      intent: originalFiles[2].bytes, binding: originalFiles[3].bytes }, project);
    same(originalFiles[0].bytes, createBytes);
    same(originalFiles[2].bytes, roleResult.pendingBytes);
    same(old.intent, roleResult.intent);
    assert.equal(sha(originalFiles[0].bytes), createApprovedSha256);
    assert.equal(old.approvedSha256, roleResult.approvedSha256);
    const originalDatabase = await databaseIdentity();
    const original = await snapshot();
    assert.equal(original.registry.control.stage, 'writer_role_attested');
    assert.equal(original.registry.control.revision, roleResult.intent.revision + 5);
    assert.equal(original.registry.control.publication_enabled, false);
    assert.equal(original.registry.control.serving_ready, false);
    const candidateRow = original.registry.history.find(row =>
      row.generation_token === roleResult.intent.candidateToken);
    assert.ok(candidateRow);
    assert.equal(candidateRow.index_uuid, roleResult.intent.candidateUuid);
    assert.equal(candidateRow.writer_cert_fingerprint, null);
    assert.equal(candidateRow.query_cert_fingerprint, null);
    assert.equal(original.engine.indexes[candidate]?.settings?.index?.uuid,
      roleResult.intent.candidateUuid);
    assert.equal(original.registry.dispatch.filter(row =>
      row.operation === 'writer_role' && row.state === 'response_confirmed').length, 1);
    assert.equal(await present(lock), false);
    assert.equal(await present(pending), false);
    const sdkVersion = JSON.parse(await readFile(path.join(repository,
      'node_modules/@opensearch-project/opensearch/package.json'), 'utf8')).version;
    assert.equal(sdkVersion, '3.9.0');
    const securityScript = String.raw`import {Client} from '@opensearch-project/opensearch';
      import {readFile} from 'node:fs/promises';
      import {boundedSearchSdkRequest} from '/app/packages/search/dist/opensearch-runtime.js';
      const [ca,cert,key]=await Promise.all(['ca.pem','admin.pem','admin.key'].map(n=>
        readFile('/run/station-admin/'+n)));
      const client=new Client({node:'https://opensearch:9200',ssl:{ca,cert,key,rejectUnauthorized:true},
        maxRetries:0,requestTimeout:5000,sniffOnStart:false,sniffOnConnectionFault:false,
        sniffInterval:false});
      try{const v=await boundedSearchSdkRequest(o=>client.transport.request({method:'GET',
        path:'/_nodes/plugins?filter_path=_nodes.total,_nodes.successful,_nodes.failed,nodes.*.plugins.name,nodes.*.plugins.version'},o),32768,5000);
        if(v?._nodes?.total!==1||v._nodes.successful!==1||v._nodes.failed!==0||
          Object.keys(v.nodes??{}).length!==1)throw Error('plugin');
        const p=Object.values(v.nodes)[0].plugins?.filter(x=>x.name==='opensearch-security');
        if(p?.length!==1||p[0].version!=='3.9.0.0')throw Error('plugin');
        process.stdout.write(p[0].version);}finally{await client.close();}`;
    const securityVersion = (await docker(['run', '--rm', '--pull', 'never',
      '--network', `${project}_search_internal`, '--label', `station.create.gate=${project}`,
      '--read-only', '--cap-drop', 'ALL', '--user', '1000:1000', '--mount',
      `type=volume,source=${project}_search_admin_certs,target=/run/station-admin,readonly`,
      `${project}-search-writer-role-prepare`, 'node', '--input-type=module', '-e',
      securityScript], 45_000)).trim();
    assert.equal(securityVersion, '3.9.0.0');

    checkpoint('signer');
    const signerRun = await command('node',
      ['scripts/init-search-generation-identity.mjs', roleResult.intent.candidateToken],
      ownerEnv, 90_000);
    assert.equal(signerRun.code, 0); assert.equal(signerRun.signal, null);
    assert.equal(signerRun.stderr, '');
    assert.ok(signerRun.stdout.endsWith('\n'));
    const signer = JSON.parse(signerRun.stdout.slice(0, -1));
    assert.deepEqual(Object.keys(signer).sort(), ['generationToken',
      'queryCertFingerprint', 'queryPrincipal', 'writerCertFingerprint',
      'writerPrincipal']);
    const scratch = path.join(repository, '.cache/search-writer-mapping-public');
    await mkdir(scratch, { mode: 0o700 });
    assert.deepEqual(await readdir(scratch), []);
    const publicEvidence = await captureCandidateWriterPublic({ repository, uid, gid,
      candidateToken: roleResult.intent.candidateToken, signerResult: signer });
    await publicEvidence.recheck();
    assert.equal(publicEvidence.publicDigests[0].sha256,
      roleResult.intent.publicDigests.find(row => row.path === 'ca.pem')?.sha256);
    const args = [createApprovedSha256, roleResult.approvedSha256,
      signer.generationToken, signer.writerPrincipal, signer.queryPrincipal,
      signer.writerCertFingerprint, signer.queryCertFingerprint];
    const verifyOriginals = async () => {
      same(await databaseIdentity(), originalDatabase);
      const current = await snapshot();
      same(current.registry, original.registry);
      same(current.engine, original.engine);
      same(current.state, original.state);
      same(current.admin, original.admin);
      same(current.host, original.host);
      sameSources(current.sources, original.sources);
      await publicEvidence.recheck();
      for (let i = 0; i < oldFiles.length; i++) {
        same(await readFile(oldFiles[i]), originalFiles[i].bytes);
        const stat = await lstat(oldFiles[i]);
        for (const key of ['dev', 'ino', 'mode', 'uid', 'gid'])
          assert.equal(stat[key], originalFiles[i].stat[key]);
      }
    };
    const absence = async () => {
      for (const service of services) {
        const refs = (await docker(['ps', '-a', '--no-trunc', '--filter',
          `label=com.docker.compose.project=${project}`, '--filter',
          `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}'])).trim();
        assert.equal(refs, '');
      }
      const names = (await docker(['ps', '-a', '--no-trunc', '--filter',
        `label=com.docker.compose.project=${project}`, '--filter',
        `name=^/${namePrefix}(transfer|read)_[0-9a-f]{32}$`,
        '--format', '{{.ID}}'])).trim();
      assert.equal(names, '');
      const volumes = (await docker(['volume', 'ls', '--filter',
        `label=station.create.project=${project}`, '--format', '{{.Name}}'])).trim();
      assert.equal(volumes, '');
      for (const root of ['search-writer-mapping-invocations',
        'search-writer-mapping-prepare-public']) {
        const name = path.join(repository, '.cache', root);
        if (await present(name)) same(await readdir(name), []);
      }
      same(await readdir(scratch), []);
    };

    checkpoint('owner');
    const observed = { create: [], inspect: [], fence: [], start: [],
      methods: [], ids: new Map(), rawLogs: [], order: [], shapes: [] };
    const diagnostic = { method: 'owner', phase: 'owner', command: 'none',
      outcome: 'none', last: 'none' };
    const trackMethod = mappingPrepareMethodTracker(diagnostic);
    const captureTrace = () => {
      const finite = count => count <= 2 ? count : 'many';
      if (measuredFailureTrace) return;
      try {
        measuredFailureTrace = mappingPrepareTrace({ ...diagnostic,
          create: finite(observed.create.length), inspect: finite(observed.inspect.length),
          fence: finite(observed.fence.length), start: finite(observed.start.length) });
      } catch {
        measuredFailureTrace = mappingPrepareTrace({ method: 'owner', phase: 'owner',
          command: 'other', outcome: 'threw', last: 'none', create: 'many',
          inspect: 'many', fence: 'many', start: 'many' });
      }
    };
    const track = async (name, phase, action) => {
      diagnostic.phase = phase;
      try { return await trackMethod(name, action); }
      catch (error) { captureTrace(); throw error; }
    };
    let originalImage = null, derivedImage = null, roleSetting = false, baseTagged = false;
    let originalRoleConfig = null;
    let measuredRun;
    let result;
    try {
      if (mode === 'measured') {
        checkpoint('readonly');
        const postgresId = (await docker(['compose', 'ps', '-q', 'postgres'])).trim();
        assert.match(postgresId, id);
        const pg = await inspectWriterRolePostgres(docker, postgresId, project);
        const password = (await readFile(path.join(repository,
          '.cache/search-db/initial-v1/transition.password'), 'utf8')).trim();
        const transition = async query => command('docker', ['exec', '-e',
          `PGPASSWORD=${password}`, postgresId, 'psql', '-X', '-h', pg.adminIp,
          '-U', 'station_search_transition', '-d', 'station', '-v', 'ON_ERROR_STOP=1',
          '-Atqc', query], ownerEnv, 30_000);
        originalRoleConfig = await sql(`SELECT coalesce(rolconfig::text,'')
          FROM pg_roles WHERE rolname='station_search_transition'`);
        assert.ok(originalRoleConfig.length <= 4096);
        assert.doesNotMatch(originalRoleConfig, /(?:^|[,{}])default_transaction_read_only=/);
        roleSetting = true;
        await sql('ALTER ROLE station_search_transition SET default_transaction_read_only=on');
        const setting = await sql(`SELECT coalesce(array_to_string(rolconfig,','),'')
          FROM pg_roles WHERE rolname='station_search_transition'`);
        assert.match(setting, /default_transaction_read_only=on/);
        const read = await transition(`SELECT current_user,
          current_setting('default_transaction_read_only')`);
        assert.equal(read.code, 0);
        assert.equal(read.stdout.trim(), 'station_search_transition|on');
        const denied = await transition(`UPDATE search_generation_control
          SET revision=revision WHERE singleton=1`);
        assert.notEqual(denied.code, 0);
        assert.match(denied.stderr, /cannot execute UPDATE in a read-only transaction/);
        same(await registry(), original.registry);

        checkpoint('image');
        const imageName = `${project}-search-writer-mapping-prepare`;
        originalImage = JSON.parse(await docker(['image', 'inspect', imageName]))[0].Id;
        assert.match(originalImage, /^sha256:[0-9a-f]{64}$/);
        const tag = `${project}-mapping-prepare-original`;
        await docker(['image', 'tag', originalImage, tag]);
        baseTagged = true;
        assert.equal(JSON.parse(await docker(['image', 'inspect', tag]))[0].Id,
          originalImage);
        await docker(['build', '--pull=false', '--network=none', '--build-arg',
          `BASE=${tag}`, '-f',
          'tests/integration/search-writer-mapping-prepare-fixture.Dockerfile',
          '-t', imageName, '.'], 120_000);
        derivedImage = JSON.parse(await docker(['image', 'inspect', imageName]))[0].Id;
        assert.match(derivedImage, /^sha256:[0-9a-f]{64}$/);
        assert.notEqual(derivedImage, originalImage);
        const captureFailedReadLog = async containerId => {
          if (observed.rawLogs.length) return;
          const raw = await command('docker', ['container', 'logs', containerId],
            ownerEnv, 10_000);
          process.stderr.write(raw.stderr);
          observed.rawLogs.push(raw.stderr);
          await writeFile(path.join(fixtureRoot, 'writer-mapping-read-raw.log'),
            raw.stderr, { flag: 'wx', mode: 0o600 });
          assert.equal(raw.code, 0); assert.equal(raw.signal, null);
        };
        const commandProbe = async (argv, env, timeout) => {
          diagnostic.command = mappingPrepareCommandKind(argv);
          let response;
          try { response = await command('docker', argv, env, timeout); }
          catch (error) { diagnostic.outcome = 'threw'; throw error; }
          diagnostic.outcome = response.signal ? 'signaled' :
            response.code === 0 ? 'returned-zero' : 'returned-nonzero';
          if (argv[0] === 'compose' && argv.includes('create'))
            { observed.create.push(argv.at(-1)); observed.order.push(`create:${argv.at(-1)}`); }
          if (argv[0] === 'container' && argv[1] === 'inspect' &&
              response.code === 0) {
            const item = JSON.parse(response.stdout)[0];
            const service = item?.Config?.Labels?.['com.docker.compose.service'];
            if (service === services[1] && item.State?.Status === 'exited' &&
                item.State?.ExitCode !== 0) await captureFailedReadLog(item.Id);
            if (services.includes(service) && item.State?.Status === 'created') {
              assert.match(item.Id, id);
              observed.ids.set(service, item.Id);
              observed.inspect.push(service);
              observed.order.push(`inspect:${service}`);
              const attached = Object.keys(item.NetworkSettings?.Networks ?? {}).sort();
              const shape = service === services[0] ?
                attached.length === 0 ? 'empty' :
                  attached.join('|') === 'none' ? 'none' : 'other' :
                attached.join('|') === [`${project}_search_admin_db`,
                  `${project}_search_internal`].sort().join('|') ? 'admin-internal' : 'other';
              observed.shapes.push(shape);
            }
          }
          if (argv[0] === 'container' && argv[1] === 'start') {
            observed.start.push(argv[2]);
            const service = [...observed.ids].find(([, captured]) => captured === argv[2])?.[0];
            assert.ok(service);
            observed.order.push(`start:${service}`);
          }
          if (argv[0] === 'container' && argv[1] === 'wait' &&
              observed.ids.get(services[1]) === argv[2] &&
              (response.code !== 0 || response.stdout !== '0\n'))
            await captureFailedReadLog(argv[2]);
          if (argv[0] === 'container' && argv[1] === 'logs' &&
              observed.ids.get(services[1]) === argv[2]) {
            observed.rawLogs.push(response.stderr);
            process.stderr.write(response.stderr);
            await writeFile(path.join(fixtureRoot, 'writer-mapping-read-raw.log'),
              response.stderr, { flag: 'wx', mode: 0o600 });
            const lines = response.stderr.split('\n').filter(Boolean);
            for (const line of lines) {
              assert.match(line, /^WRITER_MAPPING_PREPARE_FIXTURE:(LOADED|GET|HEAD|OTHER)$/);
              observed.methods.push(line.slice('WRITER_MAPPING_PREPARE_FIXTURE:'.length));
            }
            return { ...response, stderr: '' };
          }
          return response;
        };
        measuredRun = () => runWriterMappingPrepareOwner({ repository, uid, gid, args,
          adapterFactory: input => {
            const adapter = createWriterMappingPrepareDockerAdapter(input, {
              command: commandProbe });
            const wrapped = { ...adapter };
            for (const [method, label, phase] of [
              ['verifyOwner', 'verify-owner', 'owner'],
              ['captureOwner', 'capture-owner', 'owner'],
              ['preflight', 'preflight', 'owner'],
              ['createVolume', 'create-volume', 'owner'],
              ['recheckOwner', 'recheck-owner', null],
              ['recheckInfrastructure', 'recheck-infrastructure', null],
              ['checkVolume', 'check-volume', null],
              ['cleanupRemote', 'cleanup-remote', 'cleanup'],
              ['volumeAbsent', 'volume-absent', null]]) {
              if (typeof adapter[method] === 'function')
                wrapped[method] = (...values) => track(label, phase ?? diagnostic.phase,
                  () => adapter[method](...values));
            }
            wrapped.runPhase = (phase, beforeStart) => track(
              phase === 'transfer' ? 'run-transfer' : 'run-prepare', phase,
              () => adapter.runPhase(phase, () => track(
                phase === 'transfer' ? 'fence-transfer' : 'fence-prepare', phase,
                async () => {
                  await beforeStart(); observed.fence.push(phase);
                  observed.order.push(`fence:${services[phase === 'transfer' ? 0 : 1]}`);
                })));
            return wrapped;
          } });
        checkpoint('owner');
        result = await measuredRun();
        assert.equal(result.state, 'prepared');
      } else {
        const reply = await command('node',
          ['scripts/search-writer-mapping-prepare-owner.mjs', ...args],
          ownerEnv, 510_000);
        assert.equal(reply.code, 0); assert.equal(reply.signal, null);
        assert.equal(reply.stderr, '');
        const match = originalSuccess.exec(reply.stdout);
        assert.ok(match);
        result = { state: 'prepared', sha256: match[1] };
      }
    } finally {
      try {
        if (roleSetting) {
          await sql('ALTER ROLE station_search_transition RESET default_transaction_read_only');
          const restored = await sql(`SELECT coalesce(array_to_string(rolconfig,','),'')
            FROM pg_roles WHERE rolname='station_search_transition'`);
          assert.doesNotMatch(restored, /default_transaction_read_only=on/);
          const exactRestored = await sql(`SELECT coalesce(rolconfig::text,'')
            FROM pg_roles WHERE rolname='station_search_transition'`);
          assert.equal(exactRestored, originalRoleConfig);
        }
      } finally {
        if (baseTagged) {
          const imageName = `${project}-search-writer-mapping-prepare`;
          await docker(['image', 'tag', `${project}-mapping-prepare-original`, imageName]);
          assert.equal(JSON.parse(await docker(['image', 'inspect', imageName]))[0].Id,
            originalImage);
        }
      }
    }
    checkpoint('pending');
    assert.equal(result.state, 'prepared');
    const pendingBytes = await readFile(pending), pendingStat = await lstat(pending);
    assert.equal(pendingStat.mode & 0o777, 0o400);
    assert.equal(sha(pendingBytes), result.sha256);
    const intent = JSON.parse(pendingBytes.toString('utf8'));
    same(canonicalAttestorValue(intent, 256 * 1024).bytes, pendingBytes);
    const request = deriveWriterMappingRequest({ token: old.intent.candidateToken,
      index: old.intent.candidateIndex, profile: 'station-mail-v2',
      uuid: old.intent.candidateUuid, writerRole: old.intent.target,
      writerPrincipal: signer.writerPrincipal });
    for (const key of ['transitionToken', 'sourceToken', 'sourceIndex',
      'sourceUuid', 'candidateToken', 'candidateIndex', 'candidateUuid',
      'databaseOid', 'project', 'systemIdentifier'])
      assert.equal(intent[key], old.intent[key]);
    assert.equal(intent.revision, old.intent.revision + 5);
    assert.equal(intent.target, request.target);
    assert.equal(intent.bodySha256, request.bodySha256);
    assert.equal(intent.bodyIdentity, request.dispatchBodyIdentity);
    assert.equal(intent.originalCreateBindingSha256, sha(originalFiles[1].bytes));
    assert.equal(intent.originalRoleBindingSha256, sha(originalFiles[3].bytes));
    same(intent.originalIds, [old.create.dispatchId, old.create.ownerId,
      old.createBinding.invocationId, old.intent.dispatchId, old.intent.ownerId,
      old.binding.invocationId]);
    same(intent.priorPublicDigests, old.intent.publicDigests);
    assert.equal(intent.candidatePublic.caSha256,
      old.intent.publicDigests.find(row => row.path === 'ca.pem')?.sha256);
    same(intent.candidatePublic.publicDigests, publicEvidence.publicDigests);
    assert.equal(intent.candidatePublic.writerSha256,
      publicEvidence.publicDigests[1].sha256);
    assert.equal(intent.createApprovedSha256, createApprovedSha256);
    assert.equal(intent.roleApprovedSha256, roleResult.approvedSha256);
    assert.equal(intent.candidateToken, roleResult.intent.candidateToken);
    assert.equal(intent.candidateUuid, roleResult.intent.candidateUuid);
    assert.equal(intent.project, project);
    assert.equal(intent.candidatePublic.writerPrincipal, signer.writerPrincipal);
    assert.equal(intent.candidatePublic.writerFingerprint,
      signer.writerCertFingerprint);
    assert.equal(await present(lock), false);
    await verifyOriginals(); await absence();
    if (mode === 'measured') {
      checkpoint('measure');
      same(observed.create, services);
      same(observed.inspect, services);
      assert.equal(observed.fence.length, 2);
      same(observed.fence, ['transfer', 'prepare']);
      same(observed.start, services.map(service => observed.ids.get(service)));
      assert.equal(new Set(observed.start).size, 2);
      assert.equal(observed.rawLogs.length, 1);
      same(observed.order, services.flatMap(service => [
        `create:${service}`, `inspect:${service}`,
        `fence:${service}`, `start:${service}`]));
      assert.ok(['empty', 'none'].includes(observed.shapes[0]));
      assert.equal(observed.shapes[1], 'admin-internal');
      assert.equal(observed.methods[0], 'LOADED');
      assert.ok(observed.methods.filter(method => method === 'GET').length > 0);
      assert.equal(observed.methods.includes('OTHER'), false);
      assert.ok(observed.methods.every(method => ['LOADED', 'GET', 'HEAD'].includes(method)));
      assert.ok(derivedImage);
    }
    if (ctx.handoff === true) {
      checkpoint('handoff');
      await verifyOriginals(); await absence();
      assert.equal(await present(lock), false);
      return Object.freeze({ pendingBytes: Buffer.from(pendingBytes),
        approvedSha256: result.sha256, intent: globalThis.structuredClone(intent),
        originalFiles: originalFiles.map(item => Object.freeze({
          bytes: Buffer.from(item.bytes), stat: item.stat })),
        candidatePublicDigests: globalThis.structuredClone(publicEvidence.publicDigests),
        signer: globalThis.structuredClone(signer), securityVersion });
    }
    checkpoint('replay');
    const replayBefore = mode === 'measured' ? {
      create: observed.create.length, inspect: observed.inspect.length,
      start: observed.start.length, methods: observed.methods.length } : null;
    if (mode === 'measured') await assert.rejects(measuredRun(),
      /Private writer mapping preparation owner failed/);
    else {
      const replay = await command('node',
        ['scripts/search-writer-mapping-prepare-owner.mjs', ...args],
        ownerEnv, 30_000);
      assert.equal(replay.code, 1); assert.equal(replay.stdout, '');
      assert.equal(replay.stderr, originalFailure);
    }
    same(await readFile(pending), pendingBytes);
    const afterStat = await lstat(pending);
    assert.equal(afterStat.dev, pendingStat.dev);
    assert.equal(afterStat.ino, pendingStat.ino);
    assert.equal(afterStat.mode, pendingStat.mode);
    await verifyOriginals(); await absence();
    if (mode === 'measured') same({ create: observed.create.length,
      inspect: observed.inspect.length, start: observed.start.length,
      methods: observed.methods.length }, replayBefore);
    const retained = (await readFile(lock, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line));
    assert.equal(retained.length, 2);
    assert.equal(retained[0].state, 'preflight');
    assert.equal(retained[1].role, 'writer-mapping-prepare');
    assert.equal(retained[1].phase, 'preflight');
    assert.equal(retained[1].state, 'failed');
    assert.equal(retained.some(row => ['transfer', 'prepare', 'pending'].includes(row.phase)),
      false);
    const counts = mode === 'measured' ?
      `create=${observed.create.length} inspect=${observed.inspect.length} ` +
      `fence=${observed.fence.length} start=${observed.start.length} ` +
      `get=${observed.methods.filter(method => method === 'GET').length} ` +
      `head=${observed.methods.filter(method => method === 'HEAD').length} other=0 ` +
      `transfer=${observed.shapes[0]} read=${observed.shapes[1]}` :
      'create=na inspect=na fence=na start=na get=na head=na other=na transfer=na read=na';
    process.stdout.write(`Writer mapping preparation summary case=${mode} ` +
      `pair=${uid === 1000 ? 'default' : 'runner'} pending=exact replay=denied ` +
      `phase=${mode === 'positive' ? 'inferred' : 'measured'} ${counts} ` +
      `docker=${roleResult.versions.docker} api=${roleResult.versions.api} ` +
      `compose=${roleResult.versions.compose} opensearch=${roleResult.versions.opensearch} ` +
      `security=${securityVersion} sdk=${sdkVersion} checked=true.\n`);
  } catch {
    if (measuredFailureTrace) process.stderr.write(`${measuredFailureTrace}\n`);
    process.stderr.write(`Writer mapping preparation fixture case=${mode} step=${step}.\n`);
    throw Error('Writer mapping preparation fixture failed');
  }
}
