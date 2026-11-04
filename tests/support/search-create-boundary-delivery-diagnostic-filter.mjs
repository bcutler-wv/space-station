import { Buffer } from 'node:buffer';
import { lstat, open, readFile, stat } from 'node:fs/promises';
import process from 'node:process';
import { isCreateBoundaryDiagnosticLine } from '../../scripts/search-create-boundary-owner-diagnostic.mjs';

const checkpoints = new Set(['setup', 'network-proof', 'role-proof', 'complete-cli',
  'record-io-fault', 'lost-volume-create-response', 'lost-transfer-response', 'lost-inspect-response',
  'replaced-credential', 'replaced-volume', 'replaced-postgres', 'replaced-network',
  'verifier-substitution',
  'extra-reference', 'extra-service-reference', 'cleanup-refusal', 'fresh-rejection',
  'unintroduced-rejection', 'incomplete-rejection', 'wrong-uuid-rejection', 'engine-drift',
  'host-identity-rejection', 'source-loss', 'mapping-drift']);
const intentCheckpoints = new Set(['intent-setup', 'intent-cli', 'intent-public-identity',
  'intent-fixture-scratch',
  'intent-preexisting', 'intent-malformed-pending', 'intent-fresh-projection',
  'intent-fresh-owner', 'intent-fresh-transfer', 'intent-fresh-prepare',
  'intent-fresh-captured', 'intent-fresh-lock', 'intent-fresh-references',
  'intent-fresh-transfer-policy', 'intent-fresh-prepare-policy',
  'intent-fresh-transfer-inspect', 'intent-fresh-transfer-identity',
  'intent-fresh-transfer-host-policy', 'intent-fresh-transfer-mount-targets',
  'intent-fresh-transfer-network', 'intent-fresh-transfer-mount-options',
  'intent-fresh-transfer-effective-mounts',
  'intent-fresh-prepare-inspect', 'intent-fresh-prepare-identity',
  'intent-fresh-prepare-host-policy', 'intent-fresh-prepare-mount-targets',
  'intent-fresh-prepare-network', 'intent-fresh-prepare-effective-mounts',
  'intent-fresh-public', 'intent-fresh-seal', 'intent-fresh-identity',
  'intent-fresh-unchanged', 'intent-fresh-cleanup',
  'intent-lost-volume-response',
  'intent-lost-transfer-response', 'intent-lost-prepare-response', 'intent-cleanup-response',
  'intent-pending-record', 'intent-pending-partial', 'intent-pending-inode',
  'intent-pending-inode-mutation', 'intent-pending-inode-retained',
  'intent-pending-inode-unchanged', 'intent-pending-inode-cleanup',
  'intent-pending-same-size', 'intent-pending-same-size-mutation',
  'intent-pending-same-size-retained', 'intent-pending-same-size-unchanged',
  'intent-pending-same-size-cleanup',
  'intent-missing-admin-public', 'intent-swapped-admin-public',
  'intent-wrong-admin-private', 'intent-public-replaced-after-capture',
  'intent-expired-admin-public', 'intent-expired-admin-request',
  'intent-expired-admin-issue', 'intent-expired-admin-profile',
  'intent-expired-admin-expiry', 'intent-expired-admin-mutation',
  'intent-expired-admin-public-mutation', 'intent-expired-admin-public-retained',
  'intent-expired-admin-restoration', 'intent-expired-admin-public-unchanged',
  'intent-expired-admin-public-cleanup',
  'intent-fingerprint', 'intent-final']);
const applyNames = ['passthrough', 'concurrent-hold', 'transport-held', 'transport-timeout', 'false-ack',
  'partial-ack', 'lost-response', 'crash-before-sent', 'crash-after-sent',
  'crash-after-readback', 'db-after-engine', 'db-after-confirm'];
const applyScenarios = ['typed-approval-denials', 'typed-approval-digest',
  'typed-approval-revision', 'typed-approval-source',
  'presend-pending-inode', 'presend-public-inode', 'presend-binding-inode',
  'source-certificate-drift', 'wrong-transition-credential',
  'mounted-admin-drift', 'e0b-drift', 'preexisting-candidate',
  'apply-engine-hidden-index', 'apply-engine-alias', 'apply-engine-role',
  'apply-host-postgres', 'apply-host-network', 'apply-host-apply-volume',
  'apply-stopped-reference', 'host-lost-transfer-command',
  'host-lost-create-command', 'host-cleanup-response', 'unmodified-cli',
  'terminal-proposal', ...applyNames.map(name => `case-${name}`)];
const prepareSteps = ['db-snapshot', 'db-shape', 'engine-prior', 'sources',
  'owner-run', 'owner-exit', 'owner-stderr', 'owner-stdout', 'pending-read',
  'sealed-fields', 'db-unchanged', 'engine-unchanged'];
const applyScenarioSet = new Set(applyScenarios);
const prepareStepSet = new Set(prepareSteps);
export function createApplyPrepareDiagnostic(scenario, setCheckpoint) {
  if (!applyScenarioSet.has(scenario) || typeof setCheckpoint !== 'function')
    throw Error('Unknown create apply scenario');
  setCheckpoint(scenario);
  return {
    step(name) {
      if (!prepareStepSet.has(name)) throw Error('Unknown create apply prepare step');
      setCheckpoint(`${scenario}-prepare-${name}`);
    },
    restore() { setCheckpoint(scenario); },
  };
}
const applyCheckpoints = new Set(['setup', 'fixture-reset',
  ...applyScenarios,
  ...['probe-create', 'engine', 'readiness', 'owner', 'evidence']
    .map(step => `preexisting-candidate-${step}`),
  ...applyScenarios.flatMap(scenario =>
    prepareSteps.map(step => `${scenario}-prepare-${step}`)),
  ...applyNames.flatMap(name => [`image-${name}`, `evidence-${name}`])]);
const writerCheckpoints = new Set(['setup', 'precreate-baseline', 'create-intent',
  'create-apply', 'bound-baseline', 'unmodified-owner', 'instrumented-image',
  'readonly-grant', 'instrumented-owner', 'fault-lost-transfer-return',
  'fault-lost-prepare-return', 'fault-lost-cleanup-return', 'fault-cleanup-refused',
  'fault-create-pending-inode', 'fault-create-binding-inode', 'fault-public-pem-inode',
  'fault-public-pem-bytes', 'fault-registry-revision',
  'fault-registry-candidate-uuid', 'fault-create-dispatch-owner', 'fault-mounted-admin-pem',
  'fault-mounted-e0b', 'fault-engine-hidden-index', 'fault-engine-alias',
  'fault-engine-role', 'fault-candidate-profile', 'fault-stopped-service',
  'fault-concurrent-owners', 'fault-partial-pending',
  'fault-writer-prepare-final-after-append',
  'fault-writer-prepare-final-after-file-sync',
  'terminal-default', 'terminal-runner', 'terminal-runner-volume',
  'terminal-runner-missing-o']);
for (const name of [...writerCheckpoints].filter(value => value.startsWith('fault-')))
  for (const stage of ['owner', 'logs', 'evidence', 'restore', 'cleanup'])
    writerCheckpoints.add(`${name}-${stage}`);
for (const name of [...writerCheckpoints].filter(value => value.startsWith('terminal-')))
  for (const stage of ['owner', 'logs', 'evidence'])
    writerCheckpoints.add(`${name}-${stage}`);
const writerVariants = new Set(['default', 'runner', 'runner-volume', 'runner-missing-o']);
const deliveryCases = new Set(['positive', 'prestart', 'lost-return', 'false-ack', 'held-timeout']);
const deliverySteps = new Set(['approval', 'derived-image', 'owner', 'phase-evidence',
  'consumer-markers', 'replay']);
for (const value of deliveryCases) writerCheckpoints.add(`writer-delivery-${value}`);
const writerPrecreateSteps = new Set(['registry-rows-command', 'registry-rows-parse',
  'registry-micro-command', 'registry-micro-parse', 'registry-micro-shape',
  'engine-open', 'engine-observe', 'engine-parse', 'e0b-command', 'e0b-parse',
  'admin-command', 'admin-parse', 'sources', 'host-networks', 'host-volumes',
  'host-postgres', 'baseline-stage', 'baseline-profile']);
export function writerPrecreateDiagnostic(setCheckpoint) {
  if (typeof setCheckpoint !== 'function') throw Error('Writer precreate diagnostic callback');
  setCheckpoint('precreate-baseline');
  return {
    step(name) {
      if (!writerPrecreateSteps.has(name)) throw Error('Writer precreate diagnostic step');
      setCheckpoint(`precreate-baseline-${name}`);
    },
    restore() { setCheckpoint('precreate-baseline'); },
  };
}
for (const step of writerPrecreateSteps) writerCheckpoints.add(`precreate-baseline-${step}`);
export function writerRolePrepareSummary(log, variant) {
  if (typeof log !== 'string' || log.length > 8 * 1024 * 1024 ||
      !writerVariants.has(variant)) throw Error('Writer summary input');
  const matches = log.split('\n').filter(line =>
    line.startsWith('Writer role preparation summary '));
  if (!matches.length) return '';
  if (matches.length !== 1) throw Error('Writer summary count');
  const line = matches[0];
  const match = /^Writer role preparation summary variant=(default|runner|runner-volume|runner-missing-o) transfer=(\d{1,3}) read=(\d{1,3}) get=(\d{1,3}) head=(\d{1,3}) cleanup=(\d{1,3})\.$/.exec(line);
  if (!match || match[1] !== variant ||
      match.slice(2).some(value => Number(value) > 999)) throw Error('Writer summary shape');
  return `${line}\n`;
}
async function checkedSummaryFile(name, value) {
  const info = await lstat(name);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 ||
      info.size !== Buffer.byteLength(value) || await readFile(name, 'utf8') !== value)
    throw Error('Writer summary file');
}
export async function persistWriterRolePrepareSummary(name, log, variant) {
  const value = writerRolePrepareSummary(log, variant);
  if (!value) return false;
  let handle;
  try { handle = await open(name, 'wx', 0o600); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    await checkedSummaryFile(name, value);
    return true;
  }
  try { await handle.writeFile(value); await handle.sync(); }
  finally { await handle.close(); }
  await checkedSummaryFile(name, value);
  return true;
}
export function filteredCreateBoundaryDiagnostics(log) {
  if (typeof log !== 'string' || log.length > 8 * 1024 * 1024) return [];
  const found = [];
  let checkpoint = false, diagnostic = false;
  for (const line of log.split('\n')) {
    if (line.length > 160) continue;
    const match = /^Create boundary delivery fixture failed at ([a-z-]+)\.$/.exec(line);
    const intent = /^Create intent prepare fixture failed at ([a-z-]+)\.$/.exec(line);
    const apply = /^Create apply runtime fixture failed at ([a-z0-9-]+)\.$/.exec(line);
    const writer = /^Writer role preparation fixture failed at ([a-z0-9-]+)\.$/.exec(line);
    const delivery = /^Writer role delivery fixture case=([a-z-]+) step=([a-z-]+)\.$/.exec(line);
    if (!checkpoint && match && checkpoints.has(match[1])) {
      found.push(line); checkpoint = true;
    } else if (!checkpoint && intent && intentCheckpoints.has(intent[1])) {
      found.push(line); checkpoint = true;
    } else if (!checkpoint && apply && applyCheckpoints.has(apply[1])) {
      found.push(line); checkpoint = true;
    } else if (!checkpoint && writer && writerCheckpoints.has(writer[1])) {
      found.push(line); checkpoint = true;
    } else if (!checkpoint && delivery && deliveryCases.has(delivery[1]) &&
        deliverySteps.has(delivery[2])) {
      found.push(line); checkpoint = true;
    } else if (!diagnostic && isCreateBoundaryDiagnosticLine(line)) {
      found.push(line); diagnostic = true;
    }
  }
  return found;
}
if (process.argv[1]?.endsWith('/search-create-boundary-delivery-diagnostic-filter.mjs')) {
  try {
    if (process.argv.length === 3) {
      if ((await stat(process.argv[2])).size > 8 * 1024 * 1024) process.exitCode = 1;
      else process.stdout.write(`${filteredCreateBoundaryDiagnostics(await readFile(process.argv[2], 'utf8')).join('\n')}\n`);
    } else if (process.argv.length === 6 && process.argv[2] === '--writer-summary') {
      await persistWriterRolePrepareSummary(process.argv[4],
        await readFile(process.argv[3], 'utf8'), process.argv[5]);
    } else if (process.argv.length === 5 && process.argv[2] === '--writer-emit') {
      const name = process.argv[3], variant = process.argv[4];
      const value = await readFile(name, 'utf8');
      if (writerRolePrepareSummary(value, variant) !== value) throw Error('Writer summary emit');
      await checkedSummaryFile(name, value);
      process.stdout.write(value);
    } else process.exitCode = 1;
  } catch { process.exitCode = 1; }
}
