import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureCreatePrivateMarkers,
  scanCreatePrivateLog } from './search-create-private-log-scan.mjs';

const script = fileURLToPath(import.meta.url);
const keyScanner = path.resolve(path.dirname(script), '../../scripts/check-search-logs.mjs');
const idPattern = /^[0-9a-f]{64}$/;
const proofScript = 'tests/integration/opensearch-writer-mapping-api-proof.mjs';
const namePrefix = 'station-mapping-api-proof-';
const compose = project => ['compose', '-p', project,
  '--profile', 'search', '--profile', 'fixture'];
const fail = () => { throw Error('Pinned writer mapping host proof failed.'); };

function realCommand(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8',
    timeout: args[0] === 'wait' ? 240_000 : 30_000,
    maxBuffer: 65_536, env: process.env });
  return { code: result.status, stdout: result.stdout ?? '',
    stderr: result.stderr ?? '', failed: Boolean(result.error || result.signal) };
}
function result(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).sort().join('|') !== 'code|failed|stderr|stdout') fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.values(fields).some(item => !item.enumerable ||
      !Object.hasOwn(item, 'value'))) fail();
  const { code, stdout, stderr, failed } = value;
  if (typeof failed !== 'boolean' ||
      !((Number.isInteger(code) && code >= 0 && code <= 255) ||
        (code === null && failed)) ||
      typeof stdout !== 'string' || typeof stderr !== 'string' ||
      Buffer.byteLength(stdout) > 65_536 ||
      Buffer.byteLength(stderr) > 65_536) fail();
  return { code, stdout, stderr, failed };
}
function required(value) {
  if (value.failed || value.code !== 0) fail();
  return value.stdout;
}
function finiteProof(stdout) {
  if (Buffer.byteLength(stdout) > 4096 || !stdout.endsWith('\n')) fail();
  const lines = stdout.trimEnd().split('\n');
  const expected = [
    /^Writer mapping API shape phase=first http=201 schema=status-message keys=2 status=CREATED message=quoted-target-created bytes=[1-9][0-9]* producer=1 connection=1$/,
    /^Writer mapping API shape phase=replacement http=200 schema=status-message keys=2 status=OK message=quoted-target-updated bytes=[1-9][0-9]* producer=1 connection=1$/,
    /^Writer mapping API shape phase=ambiguous-first http=201 schema=status-message keys=2 status=CREATED message=quoted-target-created bytes=[1-9][0-9]* producer=1 connection=1$/,
    /^Writer mapping API shape phase=ambiguous original-return-lost observed-mapping=true producer=1 connection=1$/,
    /^Writer mapping API versions opensearch=3\.9\.0 sdk=3\.9\.0$/,
    /^Writer mapping API plugin security=3\.9\.0\.0 nodes=1$/,
    /^Pinned writer mapping API proof passed\.$/,
  ];
  if (lines.length !== expected.length ||
      lines.some((line, index) => !expected[index].test(line))) fail();
  return lines.join('\n');
}
function finiteFailureProof(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4096) fail();
  const safe = [];
  const shape = /^Writer mapping API shape phase=(?:first|replacement|ambiguous-first) http=(?:200|201|other) schema=(?:status-message|status-only|other|malformed|accessor) keys=(?:0|1|2|3|many|na) status=(?:CREATED|OK|UPDATED|other) message=(?:quoted-target-created|quoted-target-updated|none|other) bytes=[1-9][0-9]{0,4} producer=1 connection=1$/;
  const ambiguous = /^Writer mapping API shape phase=ambiguous original-return-lost observed-mapping=true producer=1 connection=1$/;
  const checkpoint = /^Pinned writer mapping API proof failed at (?:setup|baseline|candidate-create|role-create|mapping-first|mapping-replacement|mapping-ambiguous|cleanup|close)\.$/;
  for (const line of stdout.split('\n')) {
    if (shape.test(line) || ambiguous.test(line) || checkpoint.test(line)) safe.push(line);
  }
  return safe.length <= 8 ? safe.join('\n') : '';
}
function versionLine(engine, composeVersion, uid) {
  const docker = /^(\d+\.\d+\.\d+) (\d+\.\d+)\n$/.exec(engine);
  const composed = /^(v?\d+\.\d+\.\d+)\n$/.exec(composeVersion);
  if (!docker || !composed || !Number.isInteger(uid) || uid < 1000 || uid > 65534)
    fail();
  return `Writer mapping API host docker=${docker[1]} api=${docker[2]} ` +
    `compose=${composed[1]} uid=${uid}`;
}

/** Unwired, fixed host sequence. The injected command is for local lifecycle tests. */
export async function runWriterMappingApiHost({ root = process.cwd(),
  command = realCommand, nonce = randomBytes(6).toString('hex'),
  uid = process.getuid?.() } = {}) {
  if (typeof root !== 'string' || path.resolve(root) !== root ||
      !/^[0-9a-f]{12}$/.test(nonce) || typeof command !== 'function') fail();
  if (process.env.COMPOSE_PROJECT_NAME || process.env.COMPOSE_FILE ||
      process.env.COMPOSE_PROFILES) fail();
  const project = path.basename(root).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(project)) fail();
  const name = `${namePrefix}${nonce}`;
  const logName = path.join(root, '.cache/results/writer-mapping-api-private.log');
  await mkdir(path.dirname(logName), { recursive: true });
  const log = await open(logName, 'wx', 0o600);
  let phase = 'markers', owned = null, proof = null, host = null;
  let cleanupVerified = false;
  let failure = false, scanFailed = false, scanKind = 'private';
  const append = async value => {
    const stat = await log.stat();
    if (stat.size + Buffer.byteLength(value) > 65_536) fail();
    await log.writeFile(value);
    await log.sync();
  };
  const call = async (program, args) => {
    const response = result(await command(program, args, root));
    await append(response.stdout);
    await append(response.stderr);
    return response;
  };
  let markers;
  try {
    markers = await captureCreatePrivateMarkers(root);
    phase = 'versions';
    const engine = required(await call('docker',
      ['version', '--format', '{{.Server.Version}} {{.Server.APIVersion}}']));
    const composeVersion = required(await call('docker', ['compose', 'version', '--short']));
    host = versionLine(engine, composeVersion, uid);
    phase = 'absence';
    const absent = await call('docker', ['container', 'inspect', '--format', '{{.Id}}', name]);
    if (absent.failed || absent.code !== 1 || absent.stdout !== '') fail();
    phase = 'run';
    const started = await call('docker', [...compose(project), 'run', '-d', '--no-deps',
      '--name', name, 'search-profile-drift', 'node', proofScript]);
    const id = required(started).trim();
    if (!idPattern.test(id) || started.stdout !== `${id}\n`) fail();
    phase = 'ownership';
    const inspection = required(await call('docker', ['inspect', '--format',
      '{{json .Id}} {{json .Name}} {{json .Config.Labels}}', id]));
    const match = /^("[0-9a-f]{64}") ("[^"\n]+") (\{[^\n]+\})\n$/.exec(inspection);
    if (!match) fail();
    const labels = JSON.parse(match[3]);
    if (JSON.parse(match[1]) !== id || JSON.parse(match[2]) !== `/${name}` ||
        labels['com.docker.compose.service'] !== 'search-profile-drift' ||
        labels['com.docker.compose.project'] !== project) fail();
    owned = id;
    phase = 'wait';
    const waited = await call('docker', ['wait', id]);
    phase = 'logs';
    const actual = await call('docker', ['logs', id]);
    proof = actual.stdout + actual.stderr;
    required(actual);
    if (actual.stderr !== '') fail();
    if (waited.failed || waited.code !== 0 || waited.stdout !== '0\n') {
      phase = 'wait'; fail();
    }
  } catch { failure = true; }
  const priorPhase = phase;
  if (owned) {
    try {
      if (!failure) phase = 'cleanup';
      const removed = required(await call('docker', ['rm', owned]));
      if (removed.trim() !== owned) fail();
      const absent = await call('docker', ['container', 'inspect', '--format', '{{.Id}}', owned]);
      if (absent.failed || absent.code !== 1 || absent.stdout !== '') fail();
      cleanupVerified = true;
    } catch {
      if (!failure) phase = 'cleanup';
      else phase = priorPhase;
      failure = true;
    }
  }
  try { await log.sync(); } catch { failure = true; phase = 'scan'; }
  try { await log.close(); } catch { failure = true; phase = 'scan'; }
  try {
    await scanCreatePrivateLog(root, logName, markers);
    scanKind = 'keys';
    const relative = path.relative(root, logName);
    const checked = realCommand(process.execPath, [keyScanner, relative], root);
    if (checked.failed || checked.code !== 0) fail();
  } catch {
    if (!failure) phase = 'scan';
    scanFailed = true; failure = true;
  }
  let safe = null;
  if (!failure && !scanFailed) {
    try { safe = `${finiteProof(proof)}\n${host}\n`; }
    catch { failure = true; phase = 'proof-output'; }
  }
  if (failure) {
    let finite = '';
    if (cleanupVerified && !scanFailed && proof !== null) {
      try { finite = finiteFailureProof(proof); } catch { finite = ''; }
    }
    return { code: 1, output: `${finite ? `${finite}\n` : ''}` +
      `Pinned writer mapping host proof failed at ${phase}; ` +
      `scan=${scanFailed ? `${scanKind}-failed` : 'complete'}.\n` };
  }
  return { code: 0, output: safe };
}

if (process.argv[1] === script) {
  try {
    const result = await runWriterMappingApiHost();
    (result.code === 0 ? process.stdout : process.stderr).write(result.output);
    process.exitCode = result.code;
  } catch {
    process.stderr.write('Pinned writer mapping host proof failed at setup.\n');
    process.exitCode = 1;
  }
}
