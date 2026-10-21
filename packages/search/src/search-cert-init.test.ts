import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, test } from 'vitest';

const script = resolve('scripts/init-search-security.mjs');
async function isolated() {
  const root = await mkdtemp('.cache/results/search-cert-test-');
  const run = () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const first = run();
  expect(first.status).toBe(0);
  const directory = join(root, '.cache/search-security');
  return { directory, run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('private search identities remain create-only and unchanged on repeat', async () => {
  const fixture = await isolated();
  try {
    const original = await readFile(join(fixture.directory, 'admin.key'));
    expect(fixture.run().status).toBe(0);
    expect(await readFile(join(fixture.directory, 'admin.key'))).toEqual(original);
  } finally { await fixture.cleanup(); }
}, 30_000);

test('swapped privileged certificate and mismatched key fail closed', async () => {
  const fixture = await isolated();
  try {
    const originalQuery = await readFile(join(fixture.directory, 'query.pem'));
    await writeFile(join(fixture.directory, 'query.pem'), await readFile(join(fixture.directory, 'admin.pem')));
    expect(fixture.run().status).not.toBe(0);
    await writeFile(join(fixture.directory, 'query.pem'), originalQuery);
    await writeFile(join(fixture.directory, 'query.key'), await readFile(join(fixture.directory, 'admin.key')));
    expect(fixture.run().status).not.toBe(0);
  } finally { await fixture.cleanup(); }
}, 30_000);

test('partial private search identity directory fails closed', async () => {
  const fixture = await isolated();
  try {
    await rm(join(fixture.directory, 'indexer.key'));
    expect(fixture.run().status).not.toBe(0);
  } finally { await fixture.cleanup(); }
}, 30_000);
