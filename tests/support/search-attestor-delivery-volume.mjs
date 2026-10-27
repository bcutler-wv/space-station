import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { validateOfflineAttestorManifest } from '../../scripts/search-attestor-pure.mjs';

const root = '/run/search-attestor';
const invocation = await readFile(path.join(root, 'invocation'), 'utf8');
assert.match(invocation, /^[0-9a-f-]{36}\n$/);
const manifest = validateOfflineAttestorManifest(invocation.trim(),
  JSON.parse(await readFile(path.join(root, 'manifest/manifest.json'), 'utf8')));
const files = ['password', 'invocation', 'manifest/manifest.json',
  ...manifest.publicFiles.map(item => `public/${item.path}`)].sort();
const directories = new Set(['', 'manifest', 'public']);
for (const file of files) {
  let current = path.dirname(file);
  while (current !== '.') { directories.add(current); current = path.dirname(current); }
}
const observed = [];
for (const relative of [...directories].sort()) {
  const directory = path.join(root, relative);
  const stat = await lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(stat.uid, 1000);
  assert.equal(stat.gid, 1000);
  assert.equal(stat.mode & 0o777, 0o700);
  for (const name of await readdir(directory)) {
    const child = path.join(relative, name);
    if (!directories.has(child)) observed.push(child);
  }
}
assert.deepEqual(observed.sort(), files);
for (const relative of files) {
  const filename = path.join(root, relative);
  const stat = await lstat(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  assert.equal(stat.uid, 1000);
  assert.equal(stat.gid, 1000);
  assert.equal(stat.mode & 0o777, relative === 'manifest/manifest.json' ? 0o600 : 0o400);
  assert.ok(stat.size > 0 && stat.size <= 256 * 1024);
}
assert.equal((await readFile(path.join(root, 'password'))).length, 43);
process.stdout.write('Fixed transferred inventory is readable by UID 1000.\n');
