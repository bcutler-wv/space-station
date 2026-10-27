import assert from 'node:assert/strict';
import net from 'node:net';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

const profile = process.argv[2];
assert.ok(['admin', 'internal', 'none', 'default', 'combined'].includes(profile));
const targets = process.argv.slice(3);
assert.equal(targets.length, 4);
assert.ok(targets.every(value => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)));
async function reachable(host, port) {
  return await new Promise(resolve => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2_000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}
async function expectReachability(host, port, expected) {
  for (let attempt = 0; attempt < (expected ? 6 : 1); attempt++) {
    if (await reachable(host, port) === expected) return;
    if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail(`Unexpected network reachability for ${host}:${port}`);
}
const expected = {
  default: [true, false, false, true],
  admin: [false, true, false, false],
  internal: [false, false, true, false],
  none: [false, false, false, false],
  combined: [false, true, true, false],
}[profile];
for (let index = 0; index < targets.length; index++)
  await expectReachability(targets[index], [5432, 5432, 9200, 9199][index], expected[index]);
process.stdout.write(`Network isolation probe passed for ${profile}.\n`);
