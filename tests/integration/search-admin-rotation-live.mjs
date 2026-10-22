#!/usr/bin/env node
// Disposable Ubuntu fixture only: wrap the real owner adapter and inject a
// lost response AFTER one confirmed mutation. No production fault flag exists.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { CredentialOperationError, operateSearchAdminCredentials } from '../../scripts/search-admin-credential-core.mjs';
import { createSearchAdminDockerAdapter } from '../../scripts/search-admin-credentials.mjs';

const [mode, role, operationId, countsFile, referenceFile] = process.argv.slice(2);
const modes = ['rotate-with-sessions', 'rotate-observe', 'rotate-stage', 'rotate-after-publication',
  'rotate-after-password', 'finish-after-password', 'finish-observe', 'probe-other'];
const uid = process.getuid?.(), gid = process.getgid?.();
const repository = process.cwd();
const root = path.join(repository, '.cache/search-db');
const roleName = selected => `station_search_${selected}`;
if (process.argv.length !== 7 || !modes.includes(mode) || !['verifier', 'transition'].includes(role) ||
    !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1 || gid < 1 ||
    !path.isAbsolute(countsFile ?? '') ||
    !countsFile.startsWith(path.join(repository, '.cache/results/search-admin-rotation.')) ||
    (['finish-after-password', 'finish-observe'].includes(mode) &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId ?? '')) ||
    (!['finish-after-password', 'finish-observe'].includes(mode) && operationId !== '-') ||
    (mode === 'probe-other' && (!path.isAbsolute(referenceFile ?? '') ||
      !referenceFile.startsWith(path.join(repository, '.cache/results/search-admin-rotation.')))) ||
    (mode !== 'probe-other' && referenceFile !== '-')) {
  process.stderr.write('Rotation fixture usage failed.\n');
  process.exit(1);
}

async function bounded(binary, args, input = '', limitMs = 7_000) {
  const child = spawn(binary, args, { cwd: repository, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', overflow = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
  for (const [stream, assign] of [[child.stdout, x => { stdout = x; }], [child.stderr, x => { stderr = x; }]]) {
    let value = '';
    stream.on('data', chunk => {
      value += chunk.toString('utf8');
      if (value.length > 4096) { overflow = true; child.kill('SIGKILL'); }
      assign(value);
    });
  }
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  if (overflow || exit.signal || exit.code !== 0) throw new Error('fixture command');
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function authenticationIp(id, project) {
  const network = await bounded('docker', ['network', 'inspect', '--format', '{{.Id}}', `${project}_search_admin_db`]);
  if (!/^[0-9a-f]{64}$/.test(network.stdout)) throw new Error('fixture network');
  const endpoint = await bounded('docker', ['inspect', '--format',
    '{{range .NetworkSettings.Networks}}{{println .NetworkID "|" .IPAddress}}{{end}}', id]);
  const row = endpoint.stdout.split('\n').find(line => line.startsWith(`${network.stdout} | `));
  const ip = row?.slice(`${network.stdout} | `.length);
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip ?? '') || ip.split('.').some(x => Number(x) > 255))
    throw new Error('fixture endpoint');
  return ip;
}

async function activeSession(id, roleToHold) {
  const sql = `SELECT count(*)::text FROM pg_stat_activity WHERE usename='${roleName(roleToHold)}'
    AND state='active' AND query LIKE '%pg_sleep%';`;
  const result = await bounded('docker', ['exec', '-i', id, 'psql', '-X', '-h', '/var/run/postgresql',
    '-U', 'station', '-d', 'station', '-A', '-t', '-c', sql]);
  return Number(result.stdout) > 0;
}

function heldSession(id, ip, selected, password) {
  const child = spawn('docker', ['exec', '-i', id, 'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp',
    'psql', '-X', '-h', ip, '-p', '5432', '-U', roleName(selected), '-d', 'station',
    '-W', '-A', '-t', '-c', "SELECT pg_sleep(30); SELECT 'still';"],
  { cwd: repository, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); if (stdout.length > 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); if (stderr.length > 1024) child.kill('SIGKILL'); });
  child.stdin.on('error', () => {});
  child.stdin.end(`${password}\n`);
  const timer = setTimeout(() => child.kill('SIGKILL'), 42_000);
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  }).finally(() => clearTimeout(timer));
  // The process can fail while the other held session is being established.
  completion.catch(() => {});
  return { child, completion };
}

async function waitActive(id, selected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await activeSession(id, selected)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('fixture session');
}

const counts = { nologin: 0, terminate: 0, password: 0, login: 0 };
let capturedId = '', failure = false, heldTarget, heldOther;
try {
  const adapter = await createSearchAdminDockerAdapter(uid, gid);
  capturedId = await adapter.containerId();
  const installation = await adapter.identity();
  const originalSetLogin = adapter.setLogin;
  adapter.setLogin = async (selected, enabled) => {
    assert.equal(selected, role);
    counts[enabled ? 'login' : 'nologin'] += 1;
    await originalSetLogin(selected, enabled);
  };
  const originalTerminate = adapter.terminateTargetSessions;
  adapter.terminateTargetSessions = async selected => {
    assert.equal(selected, role);
    counts.terminate += 1;
    await originalTerminate(selected);
  };
  const originalPassword = adapter.setPassword;
  adapter.setPassword = async (selected, value) => {
    assert.equal(selected, role);
    counts.password += 1;
    await originalPassword(selected, value);
    if (mode === 'rotate-after-password' || mode === 'finish-after-password')
      throw new CredentialOperationError('remote uncertain');
  };
  if (mode === 'rotate-stage') adapter.afterRotationStaged = async () => { throw new Error('fixture staged'); };
  if (mode === 'rotate-after-publication')
    adapter.afterRotationPublication = async () => { throw new Error('fixture published'); };

  if (mode === 'probe-other') {
    const current = await readFile(path.join(root, `initial-v1/${role}.password`));
    const reference = await readFile(referenceFile);
    if (current.length !== reference.length || !timingSafeEqual(current, reference))
      throw new Error('fixture other credential');
    await adapter.auditRecovery(role === 'transition' ? 'verifier' : 'transition');
    await adapter.authenticate(role, current.toString('utf8'));
  } else {
    if (mode === 'rotate-with-sessions') {
      const other = role === 'verifier' ? 'transition' : 'verifier';
      const ip = await authenticationIp(capturedId, installation.project);
      const targetPassword = await readFile(path.join(root, `initial-v1/${role}.password`), 'utf8');
      const otherPassword = await readFile(path.join(root, `initial-v1/${other}.password`), 'utf8');
      heldOther = heldSession(capturedId, ip, other, otherPassword);
      heldTarget = heldSession(capturedId, ip, role, targetPassword);
      await waitActive(capturedId, other);
      await waitActive(capturedId, role);
    }
    await operateSearchAdminCredentials({ action: mode.startsWith('finish-') ? 'finish-pending-rotation' : 'rotate',
      role, operationId: operationId === '-' ? undefined : operationId, root, uid, gid, adapter });
    if (heldTarget) {
      const ended = await heldTarget.completion;
      if (ended.code === 0) throw new Error('fixture target session survived');
    }
    if (heldOther) {
      if (heldOther.child.exitCode !== null) throw new Error('fixture other session ended early');
      const survived = await heldOther.completion;
      if (survived.code !== 0 || !survived.stdout.includes('still')) throw new Error('fixture other session');
    }
  }
} catch { failure = true; }
finally {
  heldTarget?.child.kill('SIGKILL');
  heldOther?.child.kill('SIGKILL');
  await writeFile(countsFile, JSON.stringify({ version: 1, mode, role, containerId: capturedId,
    counts, failed: failure }), { mode: 0o600, flag: 'wx' });
}
if (failure) {
  process.stderr.write(`Rotation live fixture ${mode} failed.\n`);
  process.exitCode = 1;
} else process.stdout.write(`Rotation live fixture ${mode} passed.\n`);
