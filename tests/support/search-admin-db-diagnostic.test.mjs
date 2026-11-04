import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { dbJobDiagnostic, parseDbJobDiagnostic } from './search-admin-db-diagnostic.mjs';

test('closed checkpoint vocabulary and exact single-line parser', () => {
  const pairs = {
    setup: ['input', 'postgres-resolve', 'postgres-inspect', 'postgres-network-count', 'postgres-networks',
      'default-launch', 'default-inspect', 'outer-launch', 'outer-inspect', 'default-positive', 'outer-positive'],
    verifier: ['hold-launch', 'inspect-user-resources', 'admin-network', 'password-mount', 'environment',
      'uid', 'gid', 'default-denial', 'outer-denial', 'hold-removal'],
    transition: ['hold-launch', 'inspect-user-resources', 'admin-network', 'password-mount', 'environment',
      'uid', 'gid', 'default-denial', 'outer-denial', 'hold-removal'],
    final: ['default-positive', 'outer-positive', 'held-cleanup', 'default-cleanup', 'outer-cleanup'],
  };
  for (const [role, steps] of Object.entries(pairs)) {
    for (const step of steps) {
      const line = dbJobDiagnostic(role, step);
      assert.equal(parseDbJobDiagnostic(`unrelated private output\n${line}\n`), line);
    }
  }
  for (const [role, step] of [['unknown', 'input'], ['setup', 'uid'], ['verifier', 'input'],
    ['setup\nsecret', 'input'], ['setup', 'input\x1b']]) assert.throws(() => dbJobDiagnostic(role, step));
  const valid = dbJobDiagnostic('verifier', 'password-mount');
  for (const hostile of [
    `${valid}\n${valid}`, `${valid}\n${dbJobDiagnostic('transition', 'uid')}`,
    `${valid}\nDB job boundary failure role=setup step=input /secret.`,
    `${valid}\r`, `${valid}\x1b`, `DB job boundary failure role=setup step=input /tmp/key.`,
    `DB job boundary failure role=setup step=127.0.0.1.`,
    `DB job boundary failure role=setup step=input token=private.`, 'x'.repeat(256 * 1024 + 1) + valid,
  ]) assert.equal(parseDbJobDiagnostic(hostile), null);
});

test('real forwarding shell preserves failure and emits only allowlisted line', () => {
  const dir = mkdtempSync(path.join(process.cwd(), '.cache/results/admin-db-diagnostic-'));
  try {
    const file = path.join(dir, 'private.log');
    const retained = path.join(dir, 'retained.log');
    const line = dbJobDiagnostic('transition', 'default-denial');
    const secret = 'private-credential-sentinel-DO-NOT-FORWARD';
    writeFileSync(file, `${secret}\n${line}\n${secret}\n`);
    const run = () => spawnSync('bash', ['scripts/search-admin-db-diagnostic-forward.sh', file, retained, '7'], {
      encoding: 'utf8', timeout: 5000,
    });
    let result = run();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 7);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${line}\n`);
    assert.equal(readFileSync(retained, 'utf8'), `${secret}\n${line}\n${secret}\n`);
    writeFileSync(file, `${secret}\nDB job boundary failure role=setup step=input extra=${secret}.\n`);
    result = run();
    assert.equal(result.status, 7);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    writeFileSync(file, `${secret}\n${line}\n${line}\n`);
    result = run();
    assert.equal(result.status, 7);
    assert.equal(result.stderr, '');
    writeFileSync(file, 'x'.repeat(256 * 1024 + 1));
    result = run();
    assert.equal(result.status, 7);
    assert.equal(result.stderr, '');
    const retainedBeforeMissing = readFileSync(retained, 'utf8');
    rmSync(file);
    result = run();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 7);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(readFileSync(retained, 'utf8'), retainedBeforeMissing);
    assert.equal(execFileSync('bash', ['-n', 'scripts/search-admin-db-jobs-gate.sh']).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fixture input denial emits only the finite setup checkpoint before Docker I/O', () => {
  const result = spawnSync(process.execPath, ['tests/integration/search-admin-db-jobs-container.mjs'], {
    encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${dbJobDiagnostic('setup', 'input')}\n`);
});
