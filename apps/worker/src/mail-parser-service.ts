import { createServer } from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAIL_LIMITS, parseResultSchema, type ParseResult } from '@station/shared';

const childPath = fileURLToPath(new URL('./mail-parse-child.js', import.meta.url));
let active = 0;
const errorResult = (code: Exclude<ParseResult, { ok: true }>['code']): ParseResult => ({ ok: false, code });

type ChildFactory = () => ChildProcessWithoutNullStreams;
type ParserRunner = (raw: Buffer, timeoutMs: number, signal: AbortSignal) => Promise<ParseResult>;

export function parseInChild(raw: Buffer, timeoutMs: number = MAIL_LIMITS.timeoutMs, signal?: AbortSignal, childFactory?: ChildFactory): Promise<ParseResult> {
  return new Promise((resolve) => {
    const child = childFactory ? childFactory() : spawn(process.execPath, [childPath], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '' } });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let failure: ParseResult | undefined;
    const fail = (result: ParseResult) => {
      if (failure) return;
      failure = result;
      child.kill('SIGKILL');
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => fail(errorResult('timeout')), timeoutMs);
    const onAbort = () => fail(errorResult('service_unavailable'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on('error', () => fail(errorResult('service_unavailable')));
    child.on('close', () => {
      cleanup();
      if (failure) { resolve(failure); return; }
      try {
        const parsed = parseResultSchema.safeParse(JSON.parse(Buffer.concat(output, outputBytes).toString('utf8')));
        resolve(parsed.success ? parsed.data : errorResult('malformed'));
      } catch { resolve(errorResult('malformed')); }
    });
    child.stdout.on('data', (data: Buffer) => {
      outputBytes += data.length;
      if (outputBytes > MAIL_LIMITS.outputBytes) fail(errorResult('limit_exceeded'));
      else output.push(data);
    });
    child.stdin.on('error', () => fail(errorResult('service_unavailable')));
    if (!failure) child.stdin.end(raw);
  });
}

export function createMailParserServer(runParse: ParserRunner = parseInChild) {
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === '/health') {
      // Liveness only. The CI gate and worker call exercise an actual child parse.
      response.end(JSON.stringify({ alive: true }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/parse' || request.headers['content-type'] !== 'message/rfc822') {
      response.writeHead(404).end(JSON.stringify(errorResult('malformed')));
      return;
    }
    if (active >= MAIL_LIMITS.concurrency) {
      response.on('finish', () => request.destroy());
      response.writeHead(429).end(JSON.stringify(errorResult('busy')));
      return;
    }
    active++;
    const controller = new AbortController();
    const requestTimer = setTimeout(() => {
      controller.abort();
      if (!response.destroyed) response.writeHead(408).end(JSON.stringify(errorResult('timeout')));
      request.destroy();
    }, MAIL_LIMITS.timeoutMs + 500);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let aborted = false;
    request.on('aborted', () => { aborted = true; controller.abort(); });
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      for await (const chunk of request) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += data.length;
        if (bytes > MAIL_LIMITS.rawBytes) {
          response.on('finish', () => request.destroy());
          response.writeHead(413).end(JSON.stringify(errorResult('input_too_large')));
          return;
        }
        chunks.push(data);
      }
      if (aborted) return;
      const result = await runParse(Buffer.concat(chunks), MAIL_LIMITS.timeoutMs, controller.signal);
      if (!response.destroyed) response.writeHead(result.ok ? 200 : 422).end(JSON.stringify(result));
    } catch {
      if (!response.destroyed) response.writeHead(422).end(JSON.stringify(errorResult('malformed')));
    } finally { clearTimeout(requestTimer); active--; }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createMailParserServer().listen(8090, '0.0.0.0');
}
