/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { verifyWriterMappingApplyServiceConfig, fixedWriterMappingApplyCommand,
  verifyWriterMappingApplyMergedConfig, verifyWriterMappingApplyEffectiveContainer } from
  '../../scripts/search-writer-mapping-apply-service-config.mjs';

const fail = () => { throw Error('Fixed writer mapping apply render failed.'); };
try {
  if (process.argv.length !== 5 || !['base', 'merged'].includes(process.argv[2]) ||
      !['1000', '1001'].includes(process.argv[3])) fail();
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length; if (size > 256 * 1024) fail(); chunks.push(chunk);
  }
  const config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const repository = path.resolve(process.argv[4]), project = 'mapping_apply_fixture';
  const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const suffix = invocationId.replaceAll('-', '');
  const transferName = `station_mapping_apply_transfer_${suffix}`;
  const applyName = `station_mapping_apply_${suffix}`;
  const approvedFields = ['a'.repeat(64), '7', '22222222-2222-4222-8222-222222222222',
    'legacy-v1', 'station-mail-v1', 'legacy_uuid',
    '11111111-1111-4111-8111-111111111111',
    'station-mail-v2-g11111111111141118111111111111111', 'created_uuid',
    invocationId, project, '16384', '123'];
  const expected = { repository, project, invocationId,
    publicRoot: path.join(repository, '.cache/search-writer-mapping-apply-public', invocationId),
    volumeName: `${project}_search_writer_mapping_apply_${suffix}` };
  const transfer = 'search-writer-mapping-apply-transfer';
  const consumer = 'search-writer-mapping-apply';
  if (process.argv[2] === 'base') {
    assert.equal(verifyWriterMappingApplyServiceConfig(config, expected), true);
    assert.deepEqual(config.services[consumer].command,
      ['node', 'scripts/search-writer-mapping-consumer.mjs']);
    for (const mutate of [
      value => { value.services.extra = {}; },
      value => { value.services[transfer].volumes[0].source = '/tmp/foreign'; },
      value => { value.services[transfer].volumes.push({ type: 'bind',
        source: '/tmp/key', target: '/run/key', read_only: true }); },
      value => { value.services[transfer].network_mode = 'bridge'; },
      value => { value.services[transfer].cap_add.push('SYS_ADMIN'); },
      value => { value.services[consumer].command.push('unapproved'); },
      value => { value.services[consumer].volumes[0].read_only = false; },
      value => { value.services[consumer].networks.default = null; },
      value => { value.services[consumer].environment = { NODE_OPTIONS: '--require=x' }; },
      value => { value.volumes.search_writer_mapping_apply_input.name = 'foreign'; },
    ]) {
      const changed = structuredClone(config); mutate(changed);
      assert.throws(() => verifyWriterMappingApplyServiceConfig(changed, expected));
    }
  } else {
    const merged = { ...expected, transferName, applyName, approvedFields,
      databaseOid: 16384, systemIdentifier: '123' };
    assert.equal(verifyWriterMappingApplyMergedConfig(config, merged), true);
    assert.deepEqual(config.services[consumer].command,
      fixedWriterMappingApplyCommand(approvedFields));
    for (const mutate of [
      value => { value.services[transfer].container_name = 'foreign'; },
      value => { value.services[consumer].command[2] = 'b'.repeat(64); },
      value => { value.services[consumer].command.push('extra'); },
      value => { value.services[consumer].volumes[2].read_only = false; },
    ]) {
      const changed = structuredClone(config); mutate(changed);
      assert.throws(() => verifyWriterMappingApplyMergedConfig(changed, merged));
    }
    for (const key of ['project', 'invocationId', 'databaseOid', 'systemIdentifier']) {
      const wrong = { ...merged, [key]: key === 'databaseOid' ? 1 : 'foreign' };
      assert.throws(() => verifyWriterMappingApplyMergedConfig(config, wrong));
    }
    const foreignNames = structuredClone(config);
    foreignNames.services[transfer].container_name = 'foreign_transfer';
    foreignNames.services[consumer].container_name = 'foreign_apply';
    assert.throws(() => verifyWriterMappingApplyMergedConfig(foreignNames,
      { ...merged, transferName: 'foreign_transfer', applyName: 'foreign_apply' }));
    const networkIds = ['3'.repeat(64), '4'.repeat(64)];
    const base = { ...config, services: { ...config.services,
      [transfer]: { ...config.services[transfer],
        command: ['node', 'scripts/search-writer-mapping-apply-transfer.mjs'] },
      [consumer]: { ...config.services[consumer],
        command: ['node', 'scripts/search-writer-mapping-consumer.mjs'] } } };
    delete base.services[transfer].container_name;
    delete base.services[consumer].container_name;
    for (const name of [transfer, consumer]) {
      const service = config.services[name], transferPhase = name === transfer;
      const env = ['NODE_VERSION=22.23.2'], entrypoint = ['docker-entrypoint.sh'];
      const image = `sha256:${'1'.repeat(64)}`;
      const item = { Id: 'a'.repeat(64), Image: image,
        Name: `/${transferPhase ? transferName : applyName}`,
        Config: { User: service.user, Cmd: service.command, Entrypoint: entrypoint,
          Env: env, Labels: { 'com.docker.compose.project': project,
            'com.docker.compose.service': name } },
        HostConfig: { Privileged: false, ReadonlyRootfs: true,
          CapDrop: ['ALL'], CapAdd: transferPhase ? ['CAP_CHOWN', 'CAP_DAC_OVERRIDE'] : [],
          PidsLimit: service.pids_limit, Memory: Number(service.mem_limit),
          NanoCpus: service.cpus * 1e9, RestartPolicy: { Name: 'no' },
          SecurityOpt: ['no-new-privileges:true'], Devices: [], GroupAdd: [],
          PidMode: '', IpcMode: 'private', PortBindings: {},
          Tmpfs: { '/tmp': service.tmpfs[0].slice('/tmp:'.length) },
          NetworkMode: transferPhase ? 'none' : `${project}_search_admin_db`,
          Mounts: service.volumes.map(value => ({ Type: value.type,
            Source: value.type === 'bind' ? value.source : config.volumes[value.source].name,
            Target: value.target, ReadOnly: !!value.read_only,
            ...(value.type === 'bind' ? { BindOptions: { CreateMountpoint: false } } :
              { VolumeOptions: { NoCopy: true } }) })) },
        NetworkSettings: { Ports: {}, Networks: transferPhase ?
          { none: { NetworkID: '5'.repeat(64) } } :
          { search_admin_db: { NetworkID: networkIds[0] },
            search_internal: { NetworkID: networkIds[1] } } },
        Mounts: service.volumes.map(value => ({ Type: value.type,
          Destination: value.target,
          Source: value.type === 'bind' ? value.source : config.volumes[value.source].name,
          Name: value.type === 'volume' ? config.volumes[value.source].name : undefined,
          RW: !value.read_only })) };
      const authority = { service: name, id: item.Id, image, env, entrypoint,
        ...expected, networkIds, noneNetworkId: '5'.repeat(64), approvedFields,
        databaseOid: 16384, systemIdentifier: '123' };
      assert.equal(verifyWriterMappingApplyEffectiveContainer(item, authority), true);
      const changed = structuredClone(item);
      changed.Config.Cmd = ['node', 'scripts/search-writer-mapping-consumer.mjs'];
      assert.throws(() => verifyWriterMappingApplyEffectiveContainer(changed, authority));
      const foreign = structuredClone(item);
      foreign.Name = '/foreign';
      assert.throws(() => verifyWriterMappingApplyEffectiveContainer(foreign, authority));
      if (transferPhase) {
        const other = structuredClone(item); other.HostConfig.NetworkMode = 'bridge';
        assert.throws(() => verifyWriterMappingApplyEffectiveContainer(other, authority));
      } else {
        const other = structuredClone(item); other.NetworkSettings.Networks.default = {};
        assert.throws(() => verifyWriterMappingApplyEffectiveContainer(other, authority));
      }
    }
  }
  process.stdout.write(`Fixed writer mapping apply ${process.argv[2]} ${process.argv[3]} passed.\n`);
} catch {
  process.stderr.write('Fixed writer mapping apply render failed.\n');
  process.exitCode = 1;
}
