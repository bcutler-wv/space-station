import { Meilisearch, MeilisearchApiError, MeilisearchRequestError,
  MeilisearchRequestTimeOutError, MeilisearchTaskTimeOutError } from 'meilisearch';
import type { EnqueuedTaskPromise, Task } from 'meilisearch';

export const MEILI_ENGINE = {
  version: '1.55.0',
  commit: '420ff1362801adb58c938aec89700e8f7e32e566',
  requestMs: 5_000,
  taskMs: 20_000,
  responseBytes: 1_048_576,
} as const;

export type MeiliFailureKind = 'configuration' | 'version' | 'transport' | 'timeout' | 'api' | 'task';

export class MeiliContractError extends Error {
  constructor(readonly kind: MeiliFailureKind, message: string) { super(message); }
}

export function classifyMeiliError(error: unknown): MeiliFailureKind {
  return classify(error, 0);
}

function classify(error: unknown, depth: number): MeiliFailureKind {
  if (error instanceof MeiliContractError) return error.kind;
  if (error instanceof MeilisearchRequestTimeOutError || error instanceof MeilisearchTaskTimeOutError) return 'timeout';
  if (error instanceof MeilisearchApiError) return 'api';
  if (error instanceof MeilisearchRequestError) return depth < 3 ? classify(error.cause, depth + 1) : 'transport';
  return 'transport';
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal | null): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) throw new MeiliContractError('timeout', 'Search-engine response timed out.');
  if (!signal) return reader.read();
  let abort: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new MeiliContractError('timeout', 'Search-engine response timed out.'));
    signal.addEventListener('abort', abort, { once:true });
  });
  try { return await Promise.race([reader.read(), expired]); }
  finally { if (abort) signal.removeEventListener('abort', abort); }
}

/** SDK v0.62.0 custom HTTP hook: parsed JSON, bounded through body consumption. */
export async function boundedMeiliHttpClient(url: Parameters<typeof fetch>[0], init: RequestInit = {}, fetchFn: typeof fetch = fetch): Promise<unknown> {
  const signal = init.signal ?? null;
  let response: Response;
  try { response = await fetchFn(url, { ...init, redirect:'error' }); }
  catch {
    if (signal?.aborted) throw new MeiliContractError('timeout', 'Search-engine request timed out.');
    throw new MeiliContractError('transport', 'Search-engine request failed.');
  }
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    void response.body?.cancel().catch(() => undefined);
    throw new MeiliContractError('transport', 'Search-engine redirect refused.');
  }
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MEILI_ENGINE.responseBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new MeiliContractError('transport', 'Search-engine response exceeded the size limit.');
  }
  let body = '';
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal:true });
    let bytes = 0;
    try {
      while (true) {
        const part = await readChunk(reader, signal);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MEILI_ENGINE.responseBytes)
          throw new MeiliContractError('transport', 'Search-engine response exceeded the size limit.');
        body += decoder.decode(part.value, { stream:true });
      }
      body += decoder.decode();
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      if (error instanceof MeiliContractError) throw error;
      if (signal?.aborted) throw new MeiliContractError('timeout', 'Search-engine response timed out.');
      throw new MeiliContractError('transport', 'Could not read search-engine response.');
    } finally { reader.releaseLock(); }
  }
  if (!response.ok) throw new MeiliContractError('api', 'Search-engine API request failed.');
  if (!body) return undefined;
  try { return JSON.parse(body) as unknown; }
  catch { throw new MeiliContractError('transport', 'Search-engine response was not valid JSON.'); }
}

export function createMeiliClient(input: { host: string; apiKey: string }): Meilisearch {
  let url: URL;
  try { url = new URL(input.host); }
  catch { throw new MeiliContractError('configuration', 'Invalid private search-engine address.'); }
  if (url.protocol !== 'http:' || !['meilisearch','127.0.0.1','localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new MeiliContractError('configuration', 'Invalid private search-engine address.');
  if (input.apiKey.length < 16 || /\s/.test(input.apiKey))
    throw new MeiliContractError('configuration', 'Invalid private search-engine key.');
  return new Meilisearch({ host: url.origin, apiKey: input.apiKey, timeout: MEILI_ENGINE.requestMs,
    requestInit: { redirect:'error' }, httpClient: boundedMeiliHttpClient });
}

/** Verify the pinned server before any engine settings or fixture data are used. */
export async function verifyMeiliEngine(client: Meilisearch): Promise<void> {
  const version = await client.getVersion();
  if (version.pkgVersion !== MEILI_ENGINE.version || version.commitSha !== MEILI_ENGINE.commit)
    throw new MeiliContractError('version', 'Search-engine version does not match the pinned Community release.');
}

/** Settings and document writes are asynchronous. Receipt alone is not success. */
export async function awaitMeiliTask(taskPromise: EnqueuedTaskPromise): Promise<Task> {
  const task = await taskPromise.waitTask({ timeout: MEILI_ENGINE.taskMs, interval: 100 });
  if (task.status !== 'succeeded')
    throw new MeiliContractError('task', `Search-engine task ${task.uid} ended as ${task.status}.`);
  return task;
}

/** Deliberate, version-pinned activation of the experimental substring filter. */
export async function bootstrapMeiliEngine(client: Meilisearch): Promise<void> {
  await verifyMeiliEngine(client);
  const current = await client.getExperimentalFeatures();
  if (!current.containsFilter) await client.updateExperimentalFeatures({ containsFilter: true });
  const after = await client.getExperimentalFeatures();
  if (!after.containsFilter) throw new MeiliContractError('configuration', 'Search-engine substring filter is unavailable.');
}
