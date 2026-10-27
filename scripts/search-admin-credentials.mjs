#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { CredentialOperationError, operateSearchAdminCredentials } from './search-admin-credential-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '..');
const roles = { verifier: 'station_search_verifier', transition: 'station_search_transition' };
const failed = kind => { throw new CredentialOperationError(kind); };
const cleanEnvironment = () => {
  const result = { ...process.env };
  for (const key of Object.keys(result)) if (key.startsWith('PG') || key === 'COMPOSE_PROJECT_NAME') {
    if (key.startsWith('PG')) delete result[key];
  }
  return result;
};

async function command(binary, args, input = '', limitMs = 10_000) {
  const child = spawn(binary, args, { cwd: repository, env: cleanEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', overflow = false, settled = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
  const collect = (chunk, previous) => {
    if (previous.length + chunk.length > 8192) { overflow = true; child.kill('SIGKILL'); return previous; }
    return previous + chunk.toString('utf8');
  };
  child.stdout.on('data', chunk => { stdout = collect(chunk, stdout); });
  child.stderr.on('data', chunk => { stderr = collect(chunk, stderr); });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { settled = true; resolve({ code, signal }); });
  }).finally(() => clearTimeout(timer));
  if (overflow || !settled || exit.signal) failed('remote uncertain');
  return { ...exit, stdout, stderr };
}
const checked = async (binary, args, input, kind) => {
  const result = await command(binary, args, input);
  if (result.code !== 0) failed(kind);
  return result.stdout.trim();
};
const cleanPsql = ['env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp',
  'PGOPTIONS=-c statement_timeout=5s -c lock_timeout=750ms -c idle_in_transaction_session_timeout=5s',
  'psql'];
const ownerArgs = id => ['exec', '-i', id, ...cleanPsql, '-X', '-h', '/var/run/postgresql', '-U', 'station', '-d', 'station',
  '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t', '-f', '-'];
const psqlInput = async (id, sql, kind, mutation = false) => {
  const result = await command('docker', ownerArgs(id), sql);
  if (result.code !== 0) failed(mutation ? 'remote uncertain' : kind);
  return result.stdout.trim();
};
const quoteFixed = role => roles[role] ?? failed('role');

export async function createSearchAdminDockerAdapter(uid, gid) {
  const ids = (await checked('docker', ['compose', 'ps', '-q', 'postgres'], '', 'compose service'))
    .split('\n').filter(Boolean);
  if (ids.length !== 1 || !/^[0-9a-f]{12,64}$/.test(ids[0])) failed('compose service');
  const id = ids[0];
  const details = await checked('docker', ['inspect', '--format',
    '{{.State.Running}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}', id], '', 'container identity');
  const [running, project, service] = details.split('|');
  if (running !== 'true' || service !== 'postgres' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(project ?? ''))
    failed('container identity');
  const networkTuples = async () => {
    const lines = await checked('docker', ['inspect', '--format',
      '{{range .NetworkSettings.Networks}}{{println .NetworkID "|" .IPAddress}}{{end}}', id], '', 'authentication endpoint');
    const pairs = lines.split('\n').filter(Boolean).map(line => line.split(' | '));
    if (pairs.length !== 2 || pairs.some(([networkId, address], index) =>
      !/^[0-9a-f]{64}$/.test(networkId ?? '') ||
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address ?? '') ||
      address.split('.').some(x => Number(x) > 255) || address.startsWith('127.') || address === '0.0.0.0' ||
      pairs.findIndex(x => x[0] === networkId || x[1] === address) !== index)) failed('authentication endpoint');
    return pairs;
  };
  const pairs = await networkTuples();
  const networkNames = new Map();
  for (const [networkId] of pairs) {
    const line = await checked('docker', ['network', 'inspect', '--format',
      '{{.Id}}|{{.Internal}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.network"}}', networkId], '', 'authentication endpoint');
    const [observedId, internal, networkProject, networkName] = line.split('|');
    if (observedId !== networkId || networkProject !== project ||
        !['default', 'search_admin_db'].includes(networkName) ||
        (networkName === 'search_admin_db' && internal !== 'true') ||
        (networkName === 'default' && internal !== 'false') || networkNames.has(networkName))
      failed('authentication endpoint');
    networkNames.set(networkName, networkId);
  }
  if (networkNames.size !== 2) failed('authentication endpoint');
  const adminId = networkNames.get('search_admin_db');
  const ip = pairs.find(([networkId]) => networkId === adminId)[1];
  const unchangedEndpoint = async () => {
    const current = await networkTuples();
    if (current.length !== pairs.length || current.some(([networkId, address]) =>
      !pairs.some(([originalId, originalAddress]) => originalId === networkId && originalAddress === address)))
      failed('authentication endpoint');
  };
  const identitySql = `SELECT (pg_control_system()).system_identifier::text || '|' || d.oid::text || '|' || r.rolname
    FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database();`;
  const identityLine = await psqlInput(id, identitySql, 'database identity');
  const [systemIdentifier, databaseOid, owner] = identityLine.split('|');
  if (!/^[0-9]{1,20}$/.test(systemIdentifier ?? '') || !/^[0-9]{1,10}$/.test(databaseOid ?? '') || owner !== 'station')
    failed('database identity');
  if (await psqlInput(id, 'SHOW port;', 'database port') !== '5432') failed('database port');
  const installation = { project, service, database: 'station', databaseOid, systemIdentifier,
    owner, uid, gid };

  const targetContainersAbsent = async role => {
    const serviceName = { verifier: 'search-db-verifier', transition: 'search-db-transition' }[role];
    if (!serviceName) failed('role');
    const listed = await checked('docker', ['ps', '-a', '--no-trunc', '--filter',
      `label=com.docker.compose.project=${project}`, '--filter',
      `label=com.docker.compose.service=${serviceName}`, '--format', '{{.ID}}'], '', 'target containers');
    if (listed && (listed.split('\n').length > 64 || listed.split('\n').some(x => !/^[0-9a-f]{64}$/.test(x))))
      failed('target containers');
    return listed === '';
  };
  const assertRetiredContainer = async previousId => {
    if (!/^[0-9a-f]{12,64}$/.test(previousId) || previousId === id) failed('remote quiescence');
    // A successful complete enumeration is required. Inspect/daemon errors do
    // not turn into absence, and a stopped container remains in this list.
    const listed = await checked('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}'], '', 'remote quiescence');
    const ids = listed ? listed.split('\n') : [];
    if (ids.length > 256 || ids.some(x => !/^[0-9a-f]{64}$/.test(x)) ||
        ids.some(x => x === previousId || x.startsWith(previousId))) failed('remote quiescence');
    await unchangedEndpoint();
  };

  const hba = async () => {
    const rows = await psqlInput(id, `SELECT type || '|' || array_to_string(database, ',') || '|' ||
      array_to_string(user_name, ',') || '|' || coalesce(address, '') || '|' ||
      coalesce(netmask, '') || '|' || auth_method || '|' ||
      (error IS NOT NULL)::text FROM pg_hba_file_rules ORDER BY line_number;`, 'authentication rules');
    const lines = rows.split('\n').filter(Boolean).map(x => x.split('|'));
    if (lines.length < 1 || lines.length > 32 || lines.some(x => x.length !== 7 || x[6] !== 'false'))
      failed('authentication rules');
    let found = false;
    for (const [type, database, user, address, netmask, method] of lines) {
      if (!type.startsWith('host')) continue;
      if ((address === '127.0.0.1' && netmask === '255.255.255.255') ||
          (address === '::1' && netmask === 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')) continue;
      if (type !== 'host' || database !== 'all' || user !== 'all' || address !== 'all' || netmask !== '' ||
          method !== 'scram-sha-256') failed('authentication rules');
      found = true;
      break;
    }
    if (!found) failed('authentication rules');
    const encryption = await psqlInput(id, 'SHOW password_encryption;', 'password encryption');
    if (encryption !== 'scram-sha-256') failed('password encryption');
  };
  const audit = async () => {
    const body = await readFile(path.join(repository, 'ops/postgres/search-admin-roles-audit.sql'), 'utf8');
    await psqlInput(id, `BEGIN READ ONLY; SET LOCAL station.search_admin_rotation_target='none';
      SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='750ms';\n${body}\nCOMMIT;`, 'role audit');
  };
  const auditRecovery = async role => {
    const body = await readFile(path.join(repository, 'ops/postgres/search-admin-roles-audit.sql'), 'utf8');
    const name = quoteFixed(role);
    await psqlInput(id, `BEGIN READ ONLY; SET LOCAL station.search_admin_rotation_target='${name}';
      SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='750ms';\n${body}\nCOMMIT;`, 'rotation audit');
  };
  const applyPolicy = async () => {
    const apply = await readFile(path.join(repository, 'ops/postgres/search-admin-roles-apply.sql'), 'utf8');
    const auditBody = await readFile(path.join(repository, 'ops/postgres/search-admin-roles-audit.sql'), 'utf8');
    await psqlInput(id, `BEGIN; SET LOCAL station.search_admin_rotation_target='none';
      SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='750ms';\n${apply}\n${auditBody}\nCOMMIT;`, 'role policy', true);
  };
  const setPassword = async (role, password) => {
    const name = quoteFixed(role);
    const result = await command('docker', ['exec', '-i', id, ...cleanPsql, '-X', '-h', '/var/run/postgresql', '-U', 'station', '-d', 'station',
      '-v', 'ON_ERROR_STOP=1', '-c', `\\password ${name}`], `${password}\n${password}\n`);
    if (result.code !== 0) failed('remote uncertain');
    if (result.stdout.includes(password) || result.stderr.includes(password)) failed('password installation');
  };
  const setLogin = async (role, enabled) => {
    const name = quoteFixed(role);
    await psqlInput(id, `ALTER ROLE ${name} ${enabled ? 'LOGIN' : 'NOLOGIN'};`, 'role login', true);
  };
  const terminateTargetSessions = async role => {
    const name = quoteFixed(role);
    const results = await psqlInput(id, `SELECT pg_terminate_backend(pid, 3000) FROM pg_stat_activity
      WHERE usename='${name}' AND pid<>pg_backend_pid();`, 'target shutdown', true);
    if (results && results.split('\n').some(x => x !== 't')) failed('remote uncertain');
    const remaining = await psqlInput(id,
      `SELECT count(*)::text FROM pg_stat_activity WHERE usename='${name}';`, 'target sessions');
    if (remaining !== '0') failed('target sessions');
  };
  const targetSessionsZero = async role => {
    const name = quoteFixed(role);
    return await psqlInput(id, `SELECT count(*)::text FROM pg_stat_activity WHERE usename='${name}';`,
      'target sessions') === '0';
  };
  const roleEvidence = async role => {
    const name = quoteFixed(role);
    const row = await psqlInput(id, `SELECT rolcanlogin::text || '|' || coalesce(rolpassword, '')
      FROM pg_authid WHERE rolname='${name}';`, 'role evidence');
    const [login, verifier] = row.split('|');
    if (!['true', 'false'].includes(login) || !/^SCRAM-SHA-256\$[!-~]{1,512}$/.test(verifier ?? '') ||
        row.split('|').length !== 2) failed('role evidence');
    return { login: login === 'true', verifier };
  };
  const authAttempt = async (role, password) => { await unchangedEndpoint(); return command('docker', ['exec', '-i', id, ...cleanPsql,
    '-X', '-h', ip, '-p', '5432', '-U', quoteFixed(role), '-d', 'station', '-W', '-A', '-t',
    '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT session_user || \'|\' || current_user;'], `${password}\n`); };
  const authenticate = async (role, password) => {
    await hba();
    const accepted = await authAttempt(role, password);
    const name = quoteFixed(role);
    if (accepted.code !== 0 || accepted.stdout.trim() !== `${name}|${name}`) failed('credential authentication');
    const wrong = password[0] === 'A' ? `B${password.slice(1)}` : `A${password.slice(1)}`;
    const rejected = await authAttempt(role, wrong);
    if (rejected.code !== 2 || rejected.stdout.trim() || !/password authentication failed/.test(rejected.stderr))
      failed('wrong password proof');
  };
  const authenticateRejected = async (role, password) => {
    await hba();
    const rejected = await authAttempt(role, password);
    if (rejected.code !== 2 || rejected.stdout.trim() || !/password authentication failed/.test(rejected.stderr))
      failed('old password denial');
  };
  const preflightCreate = async () => {
    const rows = await psqlInput(id, `SELECT rolname || '|' || rolcanlogin::text || '|' ||
      (rolpassword IS NOT NULL)::text FROM pg_authid WHERE rolname IN
      ('station_search_verifier','station_search_transition') ORDER BY rolname;`, 'role preflight');
    if (rows && rows.split('\n').some(x => !/^station_search_(verifier|transition)\|false\|false$/.test(x)))
      failed('existing role state');
  };
  const disableRoles = async () => {
    let uncertain = false;
    let remoteUncertain = false;
    for (const name of Object.values(roles)) {
      try {
        const stopped = await psqlInput(id, `DO $stop$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${name}') THEN
        EXECUTE 'ALTER ROLE ${name} NOLOGIN'; END IF; END $stop$;
        SELECT pg_terminate_backend(pid, 3000) FROM pg_stat_activity
          WHERE usename='${name}' AND pid<>pg_backend_pid();`, 'role shutdown', true);
        if (stopped.split('\n').includes('f')) uncertain = true;
      } catch (error) {
        uncertain = true;
        if (error instanceof CredentialOperationError && error.kind === 'remote uncertain') remoteUncertain = true;
      }
    }
    if (remoteUncertain) failed('remote uncertain');
    if (uncertain) failed('shutdown uncertain');
  };
  const disableAndClearRoles = async () => {
    await disableRoles();
    for (const name of Object.values(roles)) await psqlInput(id,
      `DO $clear$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${name}') THEN
        EXECUTE 'ALTER ROLE ${name} PASSWORD NULL'; END IF; END $clear$;`, 'role credential clearing', true);
  };
  return { identity: async () => installation, containerId: async () => id,
    adminNetwork: async () => { await unchangedEndpoint(); return { id: adminId, ip }; },
    attestAuthentication: hba,
    targetContainersAbsent, assertRetiredContainer, terminateTargetSessions, targetSessionsZero, roleEvidence,
    audit, auditRecovery, applyPolicy, setPassword, setLogin, authenticate, authenticateRejected,
    preflightCreate, disableRoles, disableAndClearRoles };
}

async function main() {
  const args = process.argv.slice(2);
  const action = args.shift();
  let role, operationId;
  if (['rotate', 'finish-pending-rotation', 'abort-pending-rotation'].includes(action)) {
    role = args.shift();
    if (!Object.hasOwn(roles, role ?? '')) failed('usage');
    if (action !== 'rotate') {
      operationId = args.shift();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId ?? ''))
        failed('usage');
    }
  }
  const [uidFlag, uidRaw, gidFlag, gidRaw] = args;
  if (uidFlag !== '--uid' || gidFlag !== '--gid' || !/^[0-9]+$/.test(uidRaw ?? '') ||
      !/^[0-9]+$/.test(gidRaw ?? '') || args.length !== 4) failed('usage');
  const uid = Number(uidRaw), gid = Number(gidRaw);
  const result = await operateSearchAdminCredentials({ action, role, operationId, uid, gid,
    root: path.join(repository, '.cache/search-db'),
    adapterFactory: () => createSearchAdminDockerAdapter(uid, gid) });
  process.stdout.write(`Search admin credential ${result.state}; operation ${result.operationId}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const kind = error instanceof CredentialOperationError ? error.kind : 'operation failed';
    process.stderr.write(`Search admin credential ${kind}; inspect private pending state and database roles.\n`);
    process.exitCode = 1;
  });
}
