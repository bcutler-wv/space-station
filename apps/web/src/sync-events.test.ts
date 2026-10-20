import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSyncProgress } from './sync-events.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('passive sync progress deadline', () => {
  it('ends a stalled response body and aborts its request', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      return { ok: true, status: 200, json: () => new Promise(() => {}) } as Response;
    }));
    const pending = expect(loadSyncProgress()).rejects.toThrow('Sync progress timed out. Try again.');
    await vi.advanceTimersByTimeAsync(5_001);
    await pending;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('rejects an old body when its connection is cancelled', async () => {
    const connection = new AbortController();
    let releaseBody!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200,
      json: () => new Promise(resolve => { releaseBody = resolve; }) }) as Response));
    const pending = expect(loadSyncProgress({ signal: connection.signal })).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(releaseBody).toBeTypeOf('function'));
    connection.abort();
    await pending;
    releaseBody({ accounts: [] });
  });
});
