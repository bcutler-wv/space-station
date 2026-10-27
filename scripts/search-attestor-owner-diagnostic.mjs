// Only these fixed operational categories may cross the private owner CLI boundary.
const stages = new Set(['input', 'lock', 'owner-verify', 'owner-capture', 'invocation',
  'preflight', 'prepare-dispatch', 'prepare-run', 'prepare-confirm', 'prepare-manifest',
  'public-stage', 'volume-absence', 'transfer-dispatch', 'volume-create',
  'transfer-volume', 'transfer-run', 'transfer-confirm', 'transfer-postflight',
  'attestor-dispatch', 'attestor-run', 'attestor-confirm', 'attestor-postflight',
  'remote-cleanup', 'local-cleanup', 'deadline']);
const reasons = new Set(['unknown', 'invariant', 'deadline', 'spawn', 'timeout',
  'command-response', 'config', 'infrastructure', 'dispatch-stderr', 'dispatch-stdout',
  'dispatch-command', 'wait-command', 'logs-command',
  'inspect-response', 'inspect-policy', 'inspect-tmpfs', 'inspect-mounts',
  'inspect-host-mounts', 'inspect-network', 'inspect-terminal',
  'wait-stderr', 'wait-exit', 'logs-stderr', 'logs-stdout', 'volume', 'owner']);
for (const when of ['started', 'finished']) {
  reasons.add(`${when}-inspect-response`);
  for (const group of ['policy', 'tmpfs', 'mounts', 'host-mounts', 'network', 'terminal'])
    reasons.add(`${when}-inspect-${group}`);
}
for (const operation of ['config', 'infrastructure', 'inspect-response', 'dispatch-command',
  'started-inspect-response', 'finished-inspect-response', 'wait-command', 'logs-command'])
  for (const kind of ['timeout', 'spawn']) reasons.add(`${operation}-${kind}`);

export class AttestorOwnerDiagnosticError extends Error {
  constructor(stage, reason) {
    super('Private search attestor owner operation failed.');
    if (!stages.has(stage) || !reasons.has(reason)) throw new TypeError('Invalid diagnostic category.');
    this.stage = stage;
    this.reason = reason;
  }
}

export function ownerDiagnostic(error, stage = 'input') {
  const safeStage = stages.has(stage) ? stage : 'input';
  const safeReason = error instanceof AttestorOwnerDiagnosticError &&
    reasons.has(error.reason) ? error.reason : 'unknown';
  return new AttestorOwnerDiagnosticError(safeStage, safeReason);
}

export function ownerDiagnosticLine(error) {
  if (!(error instanceof AttestorOwnerDiagnosticError) ||
      !stages.has(error.stage) || !reasons.has(error.reason)) return '';
  return `Private search attestor owner diagnostic stage=${error.stage} reason=${error.reason}.\n`;
}

export function isOwnerDiagnosticLine(line) {
  const match = /^Private search attestor owner diagnostic stage=([a-z-]+) reason=([a-z-]+)\.$/.exec(line);
  return !!match && stages.has(match[1]) && reasons.has(match[2]);
}

export function capturedOwnerDiagnostic(stderr) {
  const generic = 'Private search attestor owner operation failed; inspect private retained evidence.\n';
  if (typeof stderr !== 'string' || !stderr.startsWith(generic) ||
      !stderr.endsWith('\n')) return '';
  const line = stderr.slice(generic.length, -1);
  return isOwnerDiagnosticLine(line) ? `${line}\n` : '';
}
