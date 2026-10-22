import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';

const mode = process.argv[2];
if (!['retained', 'introduce'].includes(mode) || process.argv.length !== 3) process.exit(1);
let body = '';
for await (const chunk of process.stdin) {
  body += chunk.toString('utf8');
  if (Buffer.byteLength(body) > 2_000_000) process.exit(1);
}
try {
  const model = JSON.parse(body);
  const services = model.services;
  assert.ok(services && typeof services === 'object');
  const retained = services['search-profile-bootstrap'];
  const security = services['search-security-bootstrap'];
  assert.ok(retained && security);
  const mount = (service, target) => {
    const found = service.volumes?.filter(row => row.target === target);
    assert.equal(found?.length, 1);
    return found[0];
  };
  const retainedState = mount(retained, '/run/station-state');
  assert.equal(retainedState.type, 'volume');
  assert.equal(retainedState.source, 'search_security_state');
  assert.equal(retainedState.read_only, true);
  assert.equal(mount(security, '/run/station-state').read_only === true, false);
  if (mode === 'retained') assert.equal(services['search-profile-introduce'], undefined);
  else {
    const introduce = services['search-profile-introduce'];
    assert.ok(introduce);
    assert.deepEqual(introduce.command, ['node', 'packages/search/dist/opensearch-introduce.js']);
    const destinations = introduce.volumes.map(row => row.target).sort();
    assert.deepEqual(destinations, ['/run/station-admin', '/run/station-state']);
    assert.equal(mount(introduce, '/run/station-admin').read_only, true);
    const writable = mount(introduce, '/run/station-state');
    assert.equal(writable.type, 'volume');
    assert.equal(writable.source, 'search_security_state');
    assert.equal(writable.read_only === true, false);
  }
  process.stdout.write(`PASS: search ${mode} Compose state mount selection.\n`);
} catch {
  process.stderr.write(`FAIL: search ${mode} Compose state mount selection.\n`);
  process.exitCode = 1;
}
