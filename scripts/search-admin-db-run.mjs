#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = Object.freeze({ verifier: 'search-db-verifier', transition: 'search-db-transition' });
const metadataFile = path.join(repository, '.cache/search-db/initial-v1/operation.json');
const fail = () => { throw new Error('preflight'); };

async function bounded(binary, args, timeout = 15_000, maxBytes = 256 * 1024) {
  const child = spawn(binary, args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', overflow = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const collect = (chunk, old) => {
    if (Buffer.byteLength(old) + chunk.length > maxBytes) { overflow = true; child.kill('SIGKILL'); return old; }
    return old + chunk.toString('utf8');
  };
  child.stdout.on('data', chunk => { stdout = collect(chunk, stdout); });
  child.stderr.on('data', chunk => { stderr = collect(chunk, stderr); });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  if (overflow || exit.signal || exit.code !== 0) fail();
  return stdout;
}

async function metadata(uid, gid) {
  let file;
  try {
    file = await open(metadataFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 ||
        stat.size < 2 || stat.size > 4096) fail();
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) fail();
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (value.uid !== uid || value.gid !== gid || value.mode !== 'initial-create' ||
        value.service !== 'postgres') fail();
    return value;
  } catch { fail(); }
  finally { await file?.close().catch(() => {}); }
}

async function source(role, uid) {
  const filename = path.join(repository, `.cache/search-db/initial-v1/${role}.password`);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid ||
      ![0o400, 0o600].includes(stat.mode & 0o777) || stat.size !== 43 ||
      await realpath(filename) !== filename) fail();
  return filename;
}

export function verifyJobConfig(config, uid, gid, sources) {
  if (!config || typeof config !== 'object' || !config.services ||
      Object.keys(config.services).sort().join('|') !== 'search-db-transition|search-db-verifier') fail();
  for (const [role, serviceName] of Object.entries(names)) {
    const service = config.services[serviceName];
    const mounts = service?.volumes;
    if (service.user !== `${uid}:${gid}` || service.read_only !== true ||
        JSON.stringify(service.profiles) !== JSON.stringify(['search-admin-db']) ||
        service.privileged === true || service.entrypoint || service.cap_add ||
        service.network_mode || service.depends_on ||
        service.env_file || service.environment || service.secrets || service.configs ||
        service.ports || service.expose || service.devices || service.group_add ||
        JSON.stringify(service.command) !== JSON.stringify(['node', 'scripts/search-admin-db-inspector.mjs', role]) ||
        Object.keys(service.networks ?? {}).join('|') !== 'search_admin_db' ||
        !Array.isArray(mounts) || mounts.length !== 1 ||
        mounts[0].type !== 'bind' || mounts[0].source !== sources[role] ||
        mounts[0].target !== '/run/search-db/password' || mounts[0].read_only !== true ||
        mounts[0].bind?.create_host_path === true ||
        !Array.isArray(service.cap_drop) || service.cap_drop.join('|') !== 'ALL' ||
        !service.security_opt?.includes('no-new-privileges:true') ||
        service.restart !== 'no' || service.pids_limit !== 64 ||
        service.mem_limit !== '268435456' || service.cpus !== 0.5) fail();
  }
  if (Object.keys(config.networks ?? {}).join('|') !== 'search_admin_db' ||
      config.networks.search_admin_db?.internal !== true ||
      config.networks.search_admin_db?.external === true ||
      config.networks.search_admin_db?.name !== `${config.name}_search_admin_db`) fail();
}

async function main() {
  const [role] = process.argv.slice(2);
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (process.argv.length !== 3 || !Object.hasOwn(names, role) || !Number.isSafeInteger(uid) ||
      !Number.isSafeInteger(gid) || uid < 1 || gid < 1) fail();
  const bundle = await metadata(uid, gid);
  const sources = { verifier: await source('verifier', uid), transition: await source('transition', uid) };
  await bounded('node', ['scripts/search-admin-credentials.mjs', 'verify', '--uid', `${uid}`, '--gid', `${gid}`], 30_000, 8192);
  const serialized = await bounded('docker', ['compose', '--profile', 'search-admin-db', 'config', '--format', 'json',
    'search-db-verifier', 'search-db-transition']);
  const config = JSON.parse(serialized);
  verifyJobConfig(config, uid, gid, sources);
  if (config.name !== bundle.project) fail();
  if (await source(role, uid) !== sources[role]) fail();
  await bounded('docker', ['compose', '--profile', 'search-admin-db', 'run', '--rm', '-T', '--no-deps', names[role]],
    45_000, 8192);
  process.stdout.write(`Search DB ${role} inspector completed.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Search DB inspector preflight or execution failed; inspect private installation state.\n');
    process.exitCode = 1;
  });
}
