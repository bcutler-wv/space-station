/* global structuredClone */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import { verifyWriterRoleApplyServiceConfig, fixedWriterRoleApplyCommand,
  verifyWriterRoleApplyEffectiveContainer } from
  '../../scripts/search-writer-role-apply-service-config.mjs';

try {
  assert.equal(process.argv.length, 3);
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length; assert.ok(size <= 256 * 1024); chunks.push(chunk);
  }
  const config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const repository = path.resolve(process.argv[2]);
  const project = 'writer_apply_fixture';
  const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const expected = { repository, project, invocationId,
    publicRoot: path.join(repository, '.cache/search-create-apply-public', invocationId),
    volumeName: `${project}_search_writer_apply_${invocationId.replaceAll('-', '')}` };
  assert.equal(verifyWriterRoleApplyServiceConfig(config, expected), true);
  const transfer = 'search-writer-role-apply-transfer', consumer = 'search-writer-role-apply';
  for (const mutate of [
    value => { value.services.extra = {}; },
    value => { value.networks.search_admin_db.ipam = { config: [{ subnet: '0.0.0.0/0' }] }; },
    value => { value.services[consumer].networks.default = null; },
    value => { value.services[consumer].command.push('unapproved'); },
    value => { value.services[consumer].command[1] = 'scripts/other.mjs'; },
    value => { value.services[consumer].environment = { NODE_OPTIONS: '--require=x' }; },
    value => { value.services[consumer].volumes[1].read_only = false; },
    value => { value.services[consumer].volumes[0].read_only = false; },
    value => { value.services[consumer].volumes[2].volume.nocopy = false; },
    value => { value.services[consumer].user = '1001:1001'; },
    value => { value.services[consumer].ports = ['9200:9200']; },
    value => { value.services[consumer].devices = ['/dev/null']; },
    value => { value.services[consumer].group_add = ['0']; },
    value => { value.services[consumer].cap_add = ['DAC_OVERRIDE']; },
    value => { value.services[consumer].entrypoint = ['/bin/sh']; },
    value => { value.services[transfer].cap_add.push('SYS_ADMIN'); },
    value => { value.services[transfer].network_mode = 'bridge'; },
    value => { value.services[transfer].volumes[5].source = '/tmp/other'; },
    value => { value.services[transfer].volumes.push({ type: 'bind',
      source: '/tmp/ca.key', target: '/run/ca.key', read_only: true }); },
    value => { value.services[transfer].volumes.push({ type: 'bind',
      source: '/var/run/docker.sock', target: '/var/run/docker.sock', read_only: true }); },
    value => { value.volumes.search_writer_role_apply_input.name = 'foreign'; },
  ]) {
    const changed = structuredClone(config); mutate(changed);
    assert.throws(() => verifyWriterRoleApplyServiceConfig(changed, expected));
  }
  const approvedFields = ['a'.repeat(64), '7', '22222222-2222-4222-8222-222222222222',
    'legacy-v1', 'station-mail-v1', 'legacy_uuid',
    '11111111-1111-4111-8111-111111111111',
    'station-mail-v2-g11111111111141118111111111111111', 'created_uuid',
    invocationId, project, '16384', '123'];
  const command = fixedWriterRoleApplyCommand(approvedFields);
  assert.equal(command.length, 15);
  assert.deepEqual(config.services[consumer].command,
    ['node', 'scripts/search-writer-role-consumer.mjs']);
  const networkIds = ['3'.repeat(64), '4'.repeat(64)];
  const image = `sha256:${'1'.repeat(64)}`;
  const env = ['NODE_VERSION=22.23.2'];
  const entrypoint = ['docker-entrypoint.sh'];
  function effective(name) {
    const transferPhase = name === transfer;
    const service = config.services[name];
    const item = { Id: 'a'.repeat(64), Image: image,
      Config: { User: service.user, Cmd: transferPhase ? service.command : command,
        Entrypoint: entrypoint, Env: env,
        Labels: { 'com.docker.compose.project': project,
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
      ...expected, networkIds, noneNetworkId: '5'.repeat(64), approvedFields };
    assert.equal(verifyWriterRoleApplyEffectiveContainer(item, authority), true);
    return { item, authority };
  }
  const first = effective(transfer);
  const second = effective(consumer);
  for (const mutate of [
    item => { item.Config.Cmd = ['node', 'scripts/search-writer-role-consumer.mjs']; },
    item => { item.Config.Cmd[2] = 'b'.repeat(64); },
    item => { [item.Config.Cmd[2], item.Config.Cmd[3]] =
      [item.Config.Cmd[3], item.Config.Cmd[2]]; },
    item => { item.Config.Cmd[11] = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; },
    item => { item.Config.Cmd.push('extra'); },
    item => { item.Config.Env.push('NODE_OPTIONS=--require=x'); },
    item => { item.Config.Entrypoint = ['/bin/sh']; },
    item => { item.HostConfig.Mounts[1].ReadOnly = false; },
    item => { item.HostConfig.Mounts[2].VolumeOptions.NoCopy = false; },
    item => { item.HostConfig.Devices.push({ PathOnHost: '/dev/null' }); },
    item => { item.HostConfig.GroupAdd.push('0'); },
    item => { item.HostConfig.PortBindings['9200/tcp'] = []; },
    item => { item.NetworkSettings.Networks.default = { NetworkID: '9'.repeat(64) }; },
  ]) {
    const changed = structuredClone(second.item); mutate(changed);
    assert.throws(() => verifyWriterRoleApplyEffectiveContainer(changed, second.authority));
  }
  for (const mutate of [
    item => { item.HostConfig.NetworkMode = 'bridge'; },
    item => { item.HostConfig.CapAdd.push('CAP_SYS_ADMIN'); },
    item => { item.Mounts.push({ Type: 'bind', Destination: '/run/ca.key', RW: false }); },
  ]) {
    const changed = structuredClone(first.item); mutate(changed);
    assert.throws(() => verifyWriterRoleApplyEffectiveContainer(changed, first.authority));
  }
  for (const index of [0, 9, 10]) {
    const wrong = structuredClone(second.authority);
    wrong.approvedFields[index] = index === 0 ? 'b'.repeat(64) :
      index === 9 ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'other_project';
    const changed = structuredClone(second.item);
    if (index === 9 || index === 10)
      changed.Config.Cmd = fixedWriterRoleApplyCommand(wrong.approvedFields);
    assert.throws(() => verifyWriterRoleApplyEffectiveContainer(changed, wrong));
  }
  const repeatedNetwork = structuredClone(second.authority);
  repeatedNetwork.networkIds[1] = repeatedNetwork.networkIds[0];
  assert.throws(() => verifyWriterRoleApplyEffectiveContainer(second.item, repeatedNetwork));
  process.stdout.write('Fixed writer role apply policy fault matrix passed.\n');
} catch {
  process.stderr.write('Fixed writer role apply policy fault matrix failed.\n');
  process.exitCode = 1;
}
