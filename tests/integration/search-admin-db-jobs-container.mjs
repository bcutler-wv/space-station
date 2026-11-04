import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import path from 'node:path';
import process from 'node:process';
import { dbJobDiagnostic } from '../support/search-admin-db-diagnostic.mjs';

let checkpointRole = 'setup', checkpointStep = 'input';
const checkpoint = (role, step) => { dbJobDiagnostic(role, step); checkpointRole = role; checkpointStep = step; };
const project = process.env.COMPOSE_PROJECT_NAME;
const uid = process.getuid?.(), gid = process.getgid?.();
const run = (args, good = true) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 128 * 1024 });
  if (result.error || result.signal || (good && result.status !== 0)) throw new Error('Docker fixture command');
  return result;
};
const inspect = id => JSON.parse(run(['inspect', id]).stdout)[0];
const network = id => JSON.parse(run(['network', 'inspect', id]).stdout)[0];
const ipFor = (container, name) => {
  const matching = Object.values(container.NetworkSettings.Networks).filter(item => {
    const data = network(item.NetworkID);
    return data.Id === item.NetworkID && data.Labels?.['com.docker.compose.project'] === project &&
      data.Labels?.['com.docker.compose.network'] === name && data.Internal === (name === 'search_admin_db');
  });
  assert.equal(matching.length, 1);
  return matching[0].IPAddress;
};
let targetId, outerId, heldId;
let failure = null;
try {
  assert.match(project ?? '', /^stationdbjobs[0-9a-f]{14}$/);
  assert.ok(uid > 0 && gid > 0);
  checkpoint('setup', 'postgres-resolve');
  const postgresId = run(['compose', 'ps', '-q', 'postgres']).stdout.trim();
  checkpoint('setup', 'postgres-inspect');
  const postgres = inspect(postgresId);
  checkpoint('setup', 'postgres-network-count');
  assert.equal(Object.keys(postgres.NetworkSettings.Networks).length, 2);
  checkpoint('setup', 'postgres-networks');
  ipFor(postgres, 'default'); ipFor(postgres, 'search_admin_db');
  checkpoint('setup', 'default-launch');
  const target = run(['run', '--rm', '-d', '--name', `${project}-target`, '--network', `${project}_default`,
    '--entrypoint', 'node', 'node:22.23.2-bookworm-slim', '-e',
    'require("net").createServer(s=>s.end("ok")).listen(4567,"0.0.0.0");setTimeout(()=>process.exit(0),360000)']);
  targetId = target.stdout.trim();
  assert.match(targetId, /^[0-9a-f]{12,64}$/);
  checkpoint('setup', 'default-inspect');
  const targetIp = Object.values(inspect(targetId).NetworkSettings.Networks)[0].IPAddress;
  checkpoint('setup', 'outer-launch');
  const outer = run(['run', '--rm', '-d', '--name', `${project}-outer-target`, '--network', 'bridge',
    '--entrypoint', 'node', 'node:22.23.2-bookworm-slim', '-e',
    'require("net").createServer(s=>s.end("ok")).listen(4567,"0.0.0.0");setTimeout(()=>process.exit(0),360000)']);
  outerId = outer.stdout.trim();
  assert.match(outerId, /^[0-9a-f]{12,64}$/);
  checkpoint('setup', 'outer-inspect');
  const outerIp = Object.values(inspect(outerId).NetworkSettings.Networks)[0].IPAddress;
  const connect = 'const s=require("net").connect(4567,process.argv[1]);' +
    's.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(7));' +
    'setTimeout(()=>process.exit(7),2500)';
  let positive = false;
  checkpoint('setup', 'default-positive');
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = run(['run', '--rm', '--network', `${project}_default`, '--entrypoint', 'node',
      'node:22.23.2-bookworm-slim', '-e', connect, targetIp], false);
    if (result.status === 0) { positive = true; break; }
  }
  assert.equal(positive, true, 'controlled default-network target was reachable');
  positive = false;
  checkpoint('setup', 'outer-positive');
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = run(['run', '--rm', '--network', 'bridge', '--entrypoint', 'node',
      'node:22.23.2-bookworm-slim', '-e', connect, outerIp], false);
    if (result.status === 0) { positive = true; break; }
  }
  assert.equal(positive, true, 'controlled outer-network target was reachable');
  for (const role of ['verifier', 'transition']) {
    const service = `search-db-${role}`;
    checkpoint(role, 'hold-launch');
    const launched = run(['compose', '--profile', 'search-admin-db', 'run', '-d', '--no-deps',
      '--name', `${project}-${role}-hold`, '--entrypoint', 'node', service,
      '-e', 'setTimeout(()=>process.exit(0),360000)']);
    heldId = launched.stdout.trim();
    assert.match(heldId, /^[0-9a-f]{12,64}$/);
    checkpoint(role, 'inspect-user-resources');
    const data = inspect(heldId);
    assert.equal(data.Config.User, `${uid}:${gid}`);
    assert.equal(data.HostConfig.ReadonlyRootfs, true);
    assert.ok(data.HostConfig.CapDrop?.includes('ALL'));
    assert.ok(data.HostConfig.SecurityOpt?.includes('no-new-privileges:true'));
    assert.equal(data.HostConfig.PidsLimit, 64);
    assert.equal(data.HostConfig.Memory, 268435456);
    assert.equal(data.HostConfig.NanoCpus, 500000000);
    assert.equal(data.HostConfig.RestartPolicy.Name, 'no');
    checkpoint(role, 'admin-network');
    assert.equal(Object.keys(data.NetworkSettings.Networks).length, 1);
    ipFor(data, 'search_admin_db');
    assert.equal(Object.keys(data.HostConfig.PortBindings ?? {}).length, 0);
    checkpoint(role, 'password-mount');
    assert.equal(data.Mounts.length, 1);
    const mount = data.Mounts[0];
    assert.equal(mount.Type, 'bind');
    assert.equal(mount.Source, path.join(process.cwd(), `.cache/search-db/initial-v1/${role}.password`));
    assert.equal(mount.Destination, '/run/search-db/password');
    assert.equal(mount.RW, false);
    checkpoint(role, 'environment');
    assert.equal(data.Config.Env.map(entry => entry.split('=')[0]).sort().join('|'),
      'NODE_VERSION|PATH|YARN_VERSION');
    checkpoint(role, 'uid');
    assert.equal(run(['exec', heldId, 'id', '-u']).stdout.trim(), `${uid}`);
    checkpoint(role, 'gid');
    assert.equal(run(['exec', heldId, 'id', '-g']).stdout.trim(), `${gid}`);
    checkpoint(role, 'default-denial');
    assert.equal(run(['exec', heldId, 'node', '-e', connect, targetIp], false).status, 7,
      'admin-only job reached default-only target');
    checkpoint(role, 'outer-denial');
    assert.equal(run(['exec', heldId, 'node', '-e', connect, outerIp], false).status, 7,
      'admin-only job reached external bridge target');
    checkpoint(role, 'hold-removal');
    run(['rm', '-f', heldId]); heldId = undefined;
  }
  checkpoint('final', 'default-positive');
  assert.equal(run(['run', '--rm', '--network', `${project}_default`, '--entrypoint', 'node',
    'node:22.23.2-bookworm-slim', '-e', connect, targetIp]).status, 0);
  checkpoint('final', 'outer-positive');
  assert.equal(run(['run', '--rm', '--network', 'bridge', '--entrypoint', 'node',
    'node:22.23.2-bookworm-slim', '-e', connect, outerIp]).status, 0);
  console.log('PASS: exact DB-job user, mount, resources and admin-only network; controlled default target denied.');
} catch {
  failure = [checkpointRole, checkpointStep];
} finally {
  try {
    if (heldId) { checkpoint('final', 'held-cleanup'); run(['rm', '-f', heldId], false); }
    if (targetId) { checkpoint('final', 'default-cleanup'); run(['rm', '-f', targetId], false); }
    if (outerId) { checkpoint('final', 'outer-cleanup'); run(['rm', '-f', outerId], false); }
  } catch { failure = [checkpointRole, checkpointStep]; }
  if (failure) {
    console.error(dbJobDiagnostic(...failure));
    process.exitCode = 1;
  }
}
