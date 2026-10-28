const stages = new Set(['input', 'lock', 'owner-verify', 'owner-capture', 'invocation',
  'preflight', 'volume-absence', 'transfer-dispatch', 'volume-create',
  'transfer-volume', 'transfer-run', 'transfer-postflight', 'transfer-confirm',
  'inspect-dispatch', 'inspect-run', 'inspect-postflight', 'inspect-confirm',
  'remote-cleanup', 'local-cleanup', 'deadline']);
const reasons = new Set(['unknown', 'invariant', 'deadline', 'spawn', 'timeout',
  'command-response', 'config', 'infrastructure', 'dispatch-stderr', 'dispatch-stdout',
  'wait-stderr', 'wait-exit', 'logs-stderr', 'logs-stdout', 'inspect-policy',
  'inspect-tmpfs', 'inspect-mounts', 'inspect-host-mounts', 'inspect-network',
  'inspect-terminal', 'volume', 'owner']);

export class CreateBoundaryOwnerDiagnosticError extends Error {
  constructor(stage, reason) {
    super('Private create boundary owner operation failed.');
    if (!stages.has(stage) || !reasons.has(reason)) throw new TypeError('Invalid diagnostic category.');
    this.stage = stage;
    this.reason = reason;
  }
}

export function createBoundaryDiagnostic(error, stage = 'input') {
  return new CreateBoundaryOwnerDiagnosticError(stages.has(stage) ? stage : 'input',
    error instanceof CreateBoundaryOwnerDiagnosticError && reasons.has(error.reason) ?
      error.reason : 'unknown');
}

export function createBoundaryDiagnosticLine(error) {
  if (!(error instanceof CreateBoundaryOwnerDiagnosticError) ||
      !stages.has(error.stage) || !reasons.has(error.reason)) return '';
  return `Private create boundary owner diagnostic stage=${error.stage} reason=${error.reason}.\n`;
}

export function isCreateBoundaryDiagnosticLine(line) {
  const match = /^Private create boundary owner diagnostic stage=([a-z-]+) reason=([a-z-]+)\.$/.exec(line);
  return !!match && stages.has(match[1]) && reasons.has(match[2]);
}
