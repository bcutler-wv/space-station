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
export function filteredCreateBoundaryDiagnostics(log) {
  if (typeof log !== 'string' || log.length > 8 * 1024 * 1024) return [];
  const found = [];
  let checkpoint = false, diagnostic = false;
  for (const line of log.split('\n')) {
    if (line.length > 160) continue;
    const match = /^Create boundary delivery fixture failed at ([a-z-]+)\.$/.exec(line);
    if (!checkpoint && match && checkpoints.has(match[1])) {
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
