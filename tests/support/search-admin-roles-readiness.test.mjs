import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

const expected = 'PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=3 PGOPTIONS="-c statement_timeout=3000" exec psql -X -w -h 127.0.0.1 -p 5432 -U station -d station -v ON_ERROR_STOP=1 -Atqc "SELECT 1"';
const script = String.raw`set -euo pipefail
docker() {
  [[ $# == 5 && $1 == exec && $2 == station-search-admin-pg16 && $3 == sh &&
     $4 == -c && $5 == "$EXPECTED_READY_SCRIPT" ]] || exit 9
  printf 'probe\n' >> "$EVENT_FILE"
  local count
  count=$(wc -l < "$EVENT_FILE")
  case "$SCENARIO" in
    socket-only) return 1 ;;
    absent-db) if (( count < 4 )); then return 2; fi ;;
    wrong-output) if (( count == 1 )); then printf '0\n'; return 0; fi ;;
    *) return 9 ;;
  esac
  printf '1\n'
}
sleep() { [[ $1 == 1 ]] || exit 9; printf 'sleep\n' >> "$SLEEP_FILE"; }
source tests/support/search-admin-roles-readiness.sh
search_admin_roles_wait_ready station-search-admin-pg16
printf 'migration\n' >> "$MIGRATION_FILE"`;

test('final TCP SELECT gates migration; socket-only and missing DB do not pass', async t => {
  await mkdir('.cache/results', { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), '.cache/results/admin-role-ready-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [scenario, status, attempts, sleeps, migrated] of [
    ['socket-only', 1, 30, 29, false],
    ['absent-db', 0, 4, 3, true],
    ['wrong-output', 0, 2, 1, true],
  ]) {
    const suffix = String(scenario);
    const files = { EVENT_FILE: path.join(root, `${suffix}-events`),
      SLEEP_FILE: path.join(root, `${suffix}-sleeps`),
      MIGRATION_FILE: path.join(root, `${suffix}-migration`) };
    const result = spawnSync('bash', ['-c', script], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
      env: { ...process.env, ...files, SCENARIO: scenario,
        EXPECTED_READY_SCRIPT: expected },
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal((await readFile(files.EVENT_FILE, 'utf8')).trim().split('\n').length, attempts);
    const observedSleeps = await readFile(files.SLEEP_FILE, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    assert.equal(observedSleeps.trim() ? observedSleeps.trim().split('\n').length : 0, sleeps);
    const marker = await readFile(files.MIGRATION_FILE, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return '';
      throw error;
    });
    assert.equal(marker, migrated ? 'migration\n' : '');
    assert.equal(result.stderr, migrated ? '' : 'Disposable PG16 did not become ready.\n');
  }
});
