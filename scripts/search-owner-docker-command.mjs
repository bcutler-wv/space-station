import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';

/** Private bounded Docker subprocess; caller fixes arguments and safe failure mapping. */
export async function runBoundedOwnerDockerCommand({ repository, deadline, args, env,
  timeoutMs = 10_000, reject }) {
  const remaining = Math.min(timeoutMs, Math.floor(deadline - performance.now()));
  if (remaining < 1) reject('deadline');
  const child = spawn('docker', args, { cwd: repository, env,
    stdio: ['ignore', 'pipe', 'pipe'] });
  const outputs = [[], []]; let sizes = [0, 0], overflow = false, timedOut = false;
  const collect = (index, chunk) => {
    sizes[index] += chunk.length;
    if (sizes[index] > 256 * 1024) { overflow = true; child.kill('SIGKILL'); }
    else outputs[index].push(chunk);
  };
  child.stdout.on('data', chunk => collect(0, chunk));
  child.stderr.on('data', chunk => collect(1, chunk));
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, remaining);
  try {
    const exit = await new Promise((resolve, fail) => {
      child.once('error', fail);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }).catch(() => reject('spawn'));
    if (overflow || timedOut) reject('timeout');
    if (exit.signal) reject('spawn');
    return { ...exit, stdout: Buffer.concat(outputs[0]).toString('utf8'),
      stderr: Buffer.concat(outputs[1]).toString('utf8') };
  } finally { clearTimeout(timer); }
}
