import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const run = (args, maxBuffer = 16_384) => execFileSync('docker', args,
  { encoding: 'utf8', timeout: 10_000, maxBuffer }).trim();
try {
  assert.equal(process.argv.length, 4);
  for (const [id, writable] of [[process.argv[2], false], [process.argv[3], true]]) {
    assert.match(id, /^[0-9a-f]{12,64}$/);
    const mounts = JSON.parse(run(['inspect', '--format', '{{json .Mounts}}', id], 32_768));
    const state = mounts.filter(row => row.Destination === '/run/station-state');
    const admin = mounts.filter(row => row.Destination === '/run/station-admin');
    assert.equal(state.length, 1); assert.equal(admin.length, 1);
    assert.equal(state[0].Type, 'volume'); assert.equal(state[0].RW, writable);
    assert.equal(admin[0].Type, 'volume'); assert.equal(admin[0].RW, false);
    const user = run(['inspect', '--format', '{{.Config.User}}', id]);
    assert.equal(user, '1000:1000');
  }
  process.stdout.write('PASS: actual bootstrap container mount boundaries.\n');
} catch {
  process.stderr.write('FAIL: actual bootstrap container mount boundaries.\n');
  process.exitCode = 1;
}
