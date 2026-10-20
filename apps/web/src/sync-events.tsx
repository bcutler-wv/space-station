import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { syncChangeEventSchema, syncProgressResponseSchema, syncResetEventSchema, SYNC_EVENT_NAMES } from '@station/shared';

export type SyncConnection = 'live' | 'reconnecting';
export const syncProgressKey = ['sync-progress'] as const;
export const syncConnectionKey = ['sync-connection'] as const;
const PROGRESS_DEADLINE_MS = 5_000;

export async function loadSyncProgress({ signal }: { signal?: AbortSignal } = {}) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectCancelled: ((error: Error) => void) | undefined;
  const cancel = () => { controller.abort(); rejectCancelled?.(new Error('Sync progress request was cancelled.')); };
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = reject;
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    timeout = setTimeout(() => { controller.abort(); reject(new Error('Sync progress timed out. Try again.')); }, PROGRESS_DEADLINE_MS);
  });
  const read = async () => {
    const response = await fetch('/api/sync/progress', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    if (response.status === 401) throw new Error('Your session ended. Sign in again to see sync progress.');
    if (!response.ok) throw new Error('Sync progress could not be loaded. Try again.');
    return syncProgressResponseSchema.parse(await response.json());
  };
  try { return await Promise.race([read(), cancelled]); }
  finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

// Mounted once inside the authenticated gate, so route changes never add streams.
export function SyncEvents({ onAuthLost }: { onAuthLost: () => void }) {
  const queryClient = useQueryClient();
  useEffect(() => {
    let source: EventSource | null = null;
    let refetchTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    let probe: AbortController | undefined;
    let stopped = false;
    let failures = 0;
    let generation = 0;
    let snapshot = 0;
    let activeRead: number | null = null;
    let dirty = false;
    const connection = (value: SyncConnection) => queryClient.setQueryData(syncConnectionKey, value);
    const close = () => {
      generation++; snapshot++; activeRead = null; dirty = false;
      void queryClient.cancelQueries({ queryKey: syncProgressKey });
      source?.close(); source = null;
      probe?.abort(); probe = undefined;
      if (stableTimer) clearTimeout(stableTimer);
      stableTimer = undefined;
    };
    const readFresh = (stream: EventSource, reset = false) => {
      if (!reset && activeRead !== null) { dirty = true; return; }
      // A route can mount its own progress query after this stream opened.
      // Replace that untracked request so an event cannot certify its older snapshot.
      const replaceUntracked = queryClient.getQueryState(syncProgressKey)?.fetchStatus === 'fetching';
      const streamGeneration = generation;
      const requestSnapshot = ++snapshot;
      activeRead = requestSnapshot;
      if (reset) dirty = false;
      if (reset) connection('reconnecting');
      void (async () => {
        try {
          if (reset || replaceUntracked) await queryClient.cancelQueries({ queryKey: syncProgressKey });
          if (stopped || document.hidden || source !== stream || generation !== streamGeneration || snapshot !== requestSnapshot) return;
          await queryClient.fetchQuery({ queryKey: syncProgressKey, queryFn: ({ signal }) => loadSyncProgress({ signal }), staleTime: 0, retry: false });
          if (source === stream && generation === streamGeneration && snapshot === requestSnapshot) connection('live');
        } catch {
          if (source === stream && generation === streamGeneration && snapshot === requestSnapshot) connection('reconnecting');
        } finally {
          if (activeRead === requestSnapshot) {
            activeRead = null;
            if (dirty && source === stream && !stopped && !document.hidden) { dirty = false; refresh(); }
          }
        }
      })();
    };
    const refresh = (now = false) => {
      if (stopped || document.hidden || refetchTimer) return;
      refetchTimer = setTimeout(() => {
        refetchTimer = undefined;
        if (stopped || document.hidden || !source) return;
        void queryClient.invalidateQueries({ queryKey: syncProgressKey, refetchType: 'none' });
        if (queryClient.getQueryCache().find({ queryKey: syncProgressKey })?.getObserversCount()) {
          readFresh(source);
        }
      }, now ? 0 : 3_000);
    };
    const connect = () => {
      if (stopped || document.hidden || source) return;
      const stream = new EventSource('/api/sync/events', { withCredentials: true });
      source = stream;
      generation++;
      stream.addEventListener(SYNC_EVENT_NAMES.reset, (event: MessageEvent<string>) => {
        if (source !== stream || stopped) return;
        if (!syncResetEventSchema.safeParse({ event: SYNC_EVENT_NAMES.reset, id: event.lastEventId }).success) return;
        if (refetchTimer) clearTimeout(refetchTimer);
        refetchTimer = undefined;
        void queryClient.invalidateQueries({ queryKey: syncProgressKey, refetchType: 'none' });
        readFresh(stream, true);
      });
      for (const name of [SYNC_EVENT_NAMES.progress, SYNC_EVENT_NAMES.mail] as const) {
        stream.addEventListener(name, (event: MessageEvent<string>) => {
          if (source !== stream || stopped) return;
          let accountId: unknown;
          try { accountId = JSON.parse(event.data); } catch { return; }
          const parsed = syncChangeEventSchema.safeParse({ event: name, id: event.lastEventId, accountId });
          if (parsed.success) refresh();
        });
      }
      stream.onopen = () => {
        stableTimer = setTimeout(() => { if (source === stream) failures = 0; }, 10_000);
        readFresh(stream, true);
      };
      stream.onerror = () => {
        if (source !== stream) return;
        close();
        const probeGeneration = generation;
        connection('reconnecting');
        // The progress route is passive. Auth status would extend the idle clock.
        probe = new AbortController();
        const thisProbe = probe;
        const probeTimer = setTimeout(() => thisProbe.abort(), 5_000);
        void fetch('/api/sync/progress', { cache: 'no-store', credentials: 'same-origin', signal: probe.signal }).then(async (response) => {
          if (stopped || document.hidden || generation !== probeGeneration) return;
          if (response.status === 401) { stopped = true; onAuthLost(); return; }
          if (response.ok) {
            const parsed = syncProgressResponseSchema.safeParse(await response.json());
            if (parsed.success && generation === probeGeneration && !stopped) queryClient.setQueryData(syncProgressKey, parsed.data);
          }
        }).catch(() => undefined).finally(() => {
          clearTimeout(probeTimer);
          if (stopped || document.hidden || generation !== probeGeneration) return;
          probe = undefined;
          const wait = Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5));
          reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, wait);
        });
      };
    };
    const visibility = () => {
      if (document.hidden) {
        close();
        connection('reconnecting');
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (refetchTimer) clearTimeout(refetchTimer);
        reconnectTimer = refetchTimer = undefined;
      } else connect();
    };
    const logout = () => {
      stopped = true; close();
      queryClient.removeQueries({ queryKey: syncProgressKey });
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refetchTimer) clearTimeout(refetchTimer);
      reconnectTimer = refetchTimer = undefined;
    };
    connection('reconnecting');
    connect();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('station:logout', logout);
    return () => {
      stopped = true; close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refetchTimer) clearTimeout(refetchTimer);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('station:logout', logout);
    };
  }, [onAuthLost, queryClient]);
  return null;
}
