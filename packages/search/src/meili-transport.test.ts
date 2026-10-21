import { describe, expect, it, vi } from 'vitest';
import { MeilisearchRequestError } from 'meilisearch';
import { boundedMeiliHttpClient, classifyMeiliError, createMeiliClient,
  MEILI_ENGINE, MeiliContractError } from './meili-transport.js';

const endpoint = new URL('http://127.0.0.1:7700/health');

describe('bounded official SDK transport', () => {
  it('rejects non-private endpoints and malformed key configuration', () => {
    expect(() => createMeiliClient({ host:'https://example.com', apiKey:'long-enough-example-key' })).toThrow(MeiliContractError);
    expect(() => createMeiliClient({ host:'http://127.0.0.1:7700/path', apiKey:'long-enough-example-key' })).toThrow(MeiliContractError);
    expect(() => createMeiliClient({ host:'http://127.0.0.1:7700', apiKey:'short' })).toThrow(MeiliContractError);
    expect(createMeiliClient({ host:'http://meilisearch:7700', apiKey:'long-enough-example-key' })).toBeDefined();
  });

  it('rejects redirects and never follows a new host', async () => {
    let redirectMode: RequestRedirect | undefined;
    const fake = async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      redirectMode = init?.redirect;
      return new Response(null, { status:302, headers:{ location:'http://example.com/private' } });
    };
    await expect(boundedMeiliHttpClient(endpoint, {}, fake)).rejects.toMatchObject({ kind:'transport' });
    expect(redirectMode).toBe('error');
  });

  it('caps declared and streamed JSON bodies before parsing', async () => {
    const declared = async () => new Response('{}', { headers:{ 'content-length':String(MEILI_ENGINE.responseBytes + 1) } });
    await expect(boundedMeiliHttpClient(endpoint, {}, declared)).rejects.toMatchObject({ kind:'transport' });
    const oversize = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(MEILI_ENGINE.responseBytes + 1));
      controller.close();
    } });
    const streamed = async () => new Response(oversize);
    await expect(boundedMeiliHttpClient(endpoint, {}, streamed)).rejects.toMatchObject({ kind:'transport' });
  });

  it('keeps the deadline effective while a response body stalls', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ pull() { /* Deliberately never produces a chunk. */ } });
    const fake = async () => new Response(stream);
    const timer = setTimeout(() => controller.abort(), 15);
    try {
      await expect(boundedMeiliHttpClient(endpoint, { signal:controller.signal }, fake)).rejects.toMatchObject({ kind:'timeout' });
    } finally { clearTimeout(timer); }
  });

  it('classifies a timeout wrapped by the SDK without exposing response content', () => {
    const cause = new MeiliContractError('timeout', 'Search-engine response timed out.');
    const wrapped = new MeilisearchRequestError(endpoint.toString(), cause);
    expect(classifyMeiliError(wrapped)).toBe('timeout');
  });

  it('keeps the official SDK request timeout active until its body is consumed', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream<Uint8Array>({
      pull() { /* The response has headers but never finishes its body. */ },
    })));
    try {
      const client = createMeiliClient({ host:'http://127.0.0.1:7700', apiKey:'long-enough-example-key' });
      const pending = client.getVersion();
      const outcome = pending.then(() => 'resolved', error => classifyMeiliError(error));
      await vi.advanceTimersByTimeAsync(MEILI_ENGINE.requestMs + 1);
      expect(await outcome).toBe('timeout');
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
