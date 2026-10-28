import { readFile, stat } from 'node:fs/promises';
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
  'intent-expired-admin-public', 'intent-fingerprint', 'intent-final']);
export function filteredCreateBoundaryDiagnostics(log) {
  if (typeof log !== 'string' || log.length > 8 * 1024 * 1024) return [];
  const found = [];
  let checkpoint = false, diagnostic = false;
  for (const line of log.split('\n')) {
    if (line.length > 160) continue;
    const match = /^Create boundary delivery fixture failed at ([a-z-]+)\.$/.exec(line);
    const intent = /^Create intent prepare fixture failed at ([a-z-]+)\.$/.exec(line);
    if (!checkpoint && match && checkpoints.has(match[1])) {
      found.push(line); checkpoint = true;
    } else if (!checkpoint && intent && intentCheckpoints.has(intent[1])) {
      found.push(line); checkpoint = true;
    } else if (!diagnostic && isCreateBoundaryDiagnosticLine(line)) {
      found.push(line); diagnostic = true;
    }
  }
  return found;
}
if (process.argv.length === 3 && process.argv[1]?.endsWith('/search-create-boundary-delivery-diagnostic-filter.mjs')) {
  try {
    if ((await stat(process.argv[2])).size > 8 * 1024 * 1024) process.exitCode = 1;
    else process.stdout.write(`${filteredCreateBoundaryDiagnostics(await readFile(process.argv[2], 'utf8')).join('\n')}\n`);
  } catch { process.exitCode = 1; }
}
