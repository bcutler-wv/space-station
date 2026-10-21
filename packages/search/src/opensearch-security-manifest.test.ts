import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';

const source = resolve('ops/opensearch/security');
const temporaryParent = resolve('.cache/results');
mkdirSync(temporaryParent, { recursive: true });
const temporary = mkdtempSync(join(temporaryParent, 'search-manifest-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
const check = (directory: string) => spawnSync('bash', [join(source, 'check-manifest.sh'), directory],
  { encoding: 'utf8', timeout: 2_000 });
const copy = (name: string) => {
  const destination = join(temporary, name);
  cpSync(source, destination, { recursive: true });
  return destination;
};

test('the pinned complete security manifest passes before upload', () => {
  expect(check(source).status).toBe(0);
});

test('every mandatory SecurityAdmin file is required before upload', () => {
  const names = ['config', 'roles', 'roles_mapping', 'internal_users', 'action_groups', 'tenants', 'nodes_dn'];
  for (const name of names) {
    const directory = copy(`missing-${name}`);
    rmSync(join(directory, `${name}.yml`));
    expect(check(directory).status).toBe(1);
  }
});

test('optional audit and allowlist policies cannot silently join the fixed manifest', () => {
  for (const name of ['audit', 'allowlist']) {
    const directory = copy(`extra-${name}`);
    writeFileSync(join(directory, `${name}.yml`), '_meta:\n  type: audit\n');
    expect(check(directory).status).toBe(1);
  }
});
