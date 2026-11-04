import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

const docker = String.raw`#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'compose ps')
    if [[ $3 == -a ]]; then exit 0; fi
    printf 'fixture-pg\n'; exit 0 ;;
  'compose up')
    if [[ $3 == -d && $4 == --force-recreate ]]; then
      printf 'recreated\n' > "$FAKE_PHASE"
    else printf 'initial\n' > "$FAKE_PHASE"; fi
    printf 'up\n' >> "$FAKE_EVENTS"; exit 0 ;;
  'compose down') printf 'down\n' >> "$FAKE_EVENTS"; exit 0 ;;
  'volume inspect'|'network inspect') exit 1 ;;
esac
if [[ $1 == exec ]]; then
  phase=$(cat "$FAKE_PHASE")
  if [[ $3 == sh && $4 == -c ]]; then
    [[ $5 == *'psql -X -w -h 127.0.0.1 -p 5432 -U station -d station'* &&
       $5 == *'SELECT 1'* ]] || exit 93
    printf 'ready:%s\n' "$phase" >> "$FAKE_EVENTS"
    if [[ $FAKE_SCENARIO == initial-fail ||
          $FAKE_SCENARIO == recreate-fail && $phase == recreated ]]; then exit 1; fi
    printf '1\n'; exit 0
  fi
  if [[ $2 == -i || $3 == psql ]]; then
    printf 'sql:%s\n' "$phase" >> "$FAKE_EVENTS"
    if [[ $* == *REVOKE* ]]; then touch "$FAKE_REVOKED"; fi
    if [[ $* == *GRANT* ]]; then rm -f "$FAKE_REVOKED"; fi
    if [[ $* == *has_table_privilege* ]]; then printf 'f\n'; fi
    exit 0
  fi
fi
exit 94`;
const node = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf 'node:%s\n' "$2" >> "$FAKE_EVENTS"
case "$2" in
  create)
    if [[ $FAKE_SCENARIO == create-fail ]]; then
      printf '%s\n' "$POSTGRES_PASSWORD"
      exit 9
    fi
    mkdir -p .cache/search-db/initial-v1
    printf 'private-verifier\n' > .cache/search-db/initial-v1/verifier.password
    printf 'private-transition\n' > .cache/search-db/initial-v1/transition.password ;;
  verify) if [[ -e $FAKE_REVOKED ]]; then exit 1; fi ;;
  abort-pending-create) exit 1 ;;
esac`;

test('credential gate reaches both authenticated final-TCP readiness checks and keeps finite failures',
  async t => {
    await mkdir('.cache/results', { recursive: true });
    const root = await mkdtemp(path.join(process.cwd(), '.cache/results/admin-credential-ready-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'tests/support'), { recursive: true });
    await mkdir(path.join(root, 'packages/db/drizzle'), { recursive: true });
    await mkdir(path.join(root, '.cache/results'), { recursive: true });
    await mkdir(path.join(root, 'bin'), { recursive: true });
    await copyFile('scripts/search-admin-credentials-gate.sh',
      path.join(root, 'scripts/search-admin-credentials-gate.sh'));
    await copyFile('tests/support/search-admin-roles-readiness.sh',
      path.join(root, 'tests/support/search-admin-roles-readiness.sh'));
    await writeFile(path.join(root, 'packages/db/drizzle/0001.sql'), 'SELECT 1;\n');
    for (const [name, body] of [['docker', docker], ['node', node],
      ['sleep', '#!/usr/bin/env bash\nexit 0\n']]) {
      const file = path.join(root, 'bin', name);
      await writeFile(file, body);
      await chmod(file, 0o755);
    }
    for (const [scenario, status, stage] of [
      ['happy', 0, null], ['initial-fail', 1, 'initial-readiness'],
      ['recreate-fail', 1, 'recreate-readiness'], ['create-fail', 9, 'create'],
    ]) {
      const events = path.join(root, `${scenario}.events`);
      const result = spawnSync('bash', ['scripts/search-admin-credentials-gate.sh'], {
        cwd: root, encoding: 'utf8', timeout: 8000,
        env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
          POSTGRES_PASSWORD: 'secret-sentinel-do-not-forward',
          FAKE_SCENARIO: scenario, FAKE_EVENTS: events,
          FAKE_PHASE: path.join(root, `${scenario}.phase`),
          FAKE_REVOKED: path.join(root, `${scenario}.revoked`) },
      });
      assert.equal(result.status, status, result.stderr);
      const lines = (await readFile(events, 'utf8')).trim().split('\n');
      assert.equal(lines.includes('ready:initial'), true);
      assert.equal(lines.includes('down'), true);
      assert.equal(result.stdout.includes('secret-sentinel'), false);
      assert.equal(result.stderr.includes('secret-sentinel'), false);
      if (stage) {
        assert.match(result.stderr,
          new RegExp(`Disposable credential fixture failed stage=${stage} exit=${status}\\n$`));
        assert.equal(result.stdout, '');
      } else {
        assert.equal(lines.includes('ready:recreated'), true);
        assert.equal(result.stderr, '');
        assert.match(result.stdout, /^PASS: disposable PG16 /);
      }
      if (scenario === 'initial-fail') assert.equal(lines.some(x => x.startsWith('sql:')), false);
      if (scenario === 'recreate-fail') assert.equal(lines.includes('ready:recreated'), true);
    }
  });
