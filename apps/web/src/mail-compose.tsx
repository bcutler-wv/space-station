import { useEffect, useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { draftAttachmentListSchema, draftAttachmentMutationSchema, draftAttachmentRevisionSchema,
  draftCreateSchema, draftSchema, draftSummaryPageSchema, replyContextSchema,
  sendDiscoveryPageSchema, sendOperationSchema } from '@station/shared';
import { csrfHeaders } from './auth-screen.js';

const LIMIT = 512 * 1024;
const DRAFT_LIMIT = 32 * 1024 * 1024;
const TIMEOUT = 12_000;
type Draft = z.infer<typeof draftSchema>;
type Attachment = z.infer<typeof draftAttachmentListSchema>['attachments'][number];
type Operation = z.infer<typeof sendOperationSchema>;
type Fields = Pick<Draft, 'to' | 'cc' | 'bcc' | 'subject' | 'bodyText' | 'attachmentRefs'>;
type Account = { id: string; email: string; orbitId: string; needsReconnect: boolean };
type Scope = { accountId: string; orbitId?: string };
let signedOut = false;
window.addEventListener('station:logout', () => { signedOut = true; });
class MailHttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function bounded(response: Response, max = LIMIT): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > max) throw new Error('The response is too large. Try again.');
  if (!response.body) throw new Error('The server returned no data. Try again.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) { void reader.cancel(); throw new Error('The response is too large. Try again.'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('The server response is invalid. Try again.'); }
}

export async function mailRequest<S extends z.ZodType>(path: string, schema: S, options: RequestInit = {}, signal?: AbortSignal, maxBytes = LIMIT): Promise<z.output<S>> {
  if (signedOut) throw new Error('Signed out.');
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT) });
  const value = await bounded(response, response.ok ? maxBytes : 8192);
  if (!response.ok) throw new MailHttpError(typeof value === 'object' && value && 'error' in value && typeof value.error === 'string' ? value.error :
    response.status === 401 ? 'Your session ended. Sign in again.' : `Request failed (${response.status}). Try again.`, response.status);
  if (signedOut) throw new Error('Signed out.');
  return schema.parse(value);
}

const scopeQuery = (scope: Scope) => new URLSearchParams(scope).toString();
const json = (method: string, value: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(value) });
export async function createDraft(accountId: string, orbitId?: string, parentItemId?: string, signal?: AbortSignal) {
  const scope = new URLSearchParams({ accountId, ...(orbitId ? { orbitId } : {}) });
  const context = parentItemId ? await mailRequest(`/api/mail/items/${parentItemId}/reply-context?${scope}`, replyContextSchema, {}, signal) : null;
  const id = crypto.randomUUID();
  const payload = draftCreateSchema.parse({ id, creationKey: id, accountId, ...(orbitId ? { orbitId } : {}),
    ...(parentItemId ? { parentItemId } : {}), to: context?.to ?? [], cc: [], bcc: [],
    subject: context?.subject ?? '', bodyText: '', attachmentRefs: [] });
  return mailRequest('/api/mail/drafts', draftSchema, json('POST', payload), signal, DRAFT_LIMIT);
}

export function DraftOverview({ accounts, orbitId, onOpen }: { accounts: Account[]; orbitId?: string; onOpen: (draft: { id: string; accountId: string; orbitId: string | null }) => void }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const account = accounts.find((entry) => entry.id === accountId) ?? accounts[0];
  type Cursor = { draft: string | false | null; send: string | false | null };
  type OverviewPage = { drafts: z.infer<typeof draftSummaryPageSchema>['drafts']; sends: Operation[]; next: Cursor };
  const query = useInfiniteQuery({ queryKey: ['mail-reader', 'draft-overview', account?.id, orbitId ?? null],
    enabled: Boolean(account), retry: false, staleTime: Infinity, refetchOnWindowFocus: false,
    initialPageParam: { draft: null, send: null } as Cursor,
    getNextPageParam: (page: OverviewPage) => page.next.draft !== false || page.next.send !== false ? page.next : undefined,
    queryFn: async ({ signal, pageParam }): Promise<OverviewPage> => {
      const scope = scopeQuery({ accountId: account!.id, ...(orbitId ? { orbitId } : {}) });
      const [drafts, sends] = await Promise.all([
        pageParam.draft === false ? Promise.resolve({ drafts: [], nextCursor: null }) :
          mailRequest(`/api/mail/drafts?${scope}&limit=20${pageParam.draft ? `&cursor=${encodeURIComponent(pageParam.draft)}` : ''}`, draftSummaryPageSchema, {}, signal),
        pageParam.send === false ? Promise.resolve({ operations: [], nextCursor: null }) :
          mailRequest(`/api/mail/sends/unresolved?${scope}&limit=20${pageParam.send ? `&cursor=${encodeURIComponent(pageParam.send)}` : ''}`, sendDiscoveryPageSchema, {}, signal),
      ]);
      return { drafts: drafts.drafts, sends: sends.operations, next: { draft: drafts.nextCursor ?? false, send: sends.nextCursor ?? false } as Cursor };
    } });
  const drafts = query.data?.pages.flatMap((page) => page.drafts) ?? [];
  const sends = query.data?.pages.flatMap((page) => page.sends) ?? [];
  return <section className="mail-draft-overview" aria-label="Drafts and sends">
    <div className="mail-draft-overview-head"><h2>Drafts and sends</h2><button type="button" onClick={() => void query.refetch()}>Refresh</button></div>
    {accounts.length > 1 && <label className="mail-draft-account">Account<select aria-label="Draft account" value={account?.id ?? ''} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((entry) => <option key={entry.id} value={entry.id}>{entry.email}</option>)}</select></label>}
    {query.isPending && <p role="status">Loading drafts…</p>}
    {query.isError && <p role="alert">{query.error.message}</p>}
    {query.isSuccess && drafts.length === 0 && sends.length === 0 && <p>No saved drafts or unresolved sends for this account.</p>}
    {account && <>
      {sends.map((send) => <button key={send.id} type="button" className="mail-draft-row" onClick={() => onOpen({ id: send.draftId, accountId: account.id, orbitId: send.orbitId })}>
        <span>Send needs attention</span><small>{account.email} · {send.state === 'outcome_unknown' ? 'Outcome unknown' : 'In progress'}</small>
      </button>)}
      {drafts.map((draft) => <button key={draft.id} type="button" className="mail-draft-row" onClick={() => onOpen(draft)}>
        <span>{draft.subject || '(No subject)'}</span><small>{account.email} · Saved {new Date(draft.updatedAt).toLocaleString()}</small>
      </button>)}
      {query.hasNextPage && <button type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load older drafts and sends</button>}
    </>}
  </section>;
}

const parseAddresses = (value: string) => value.split(/[;,\n]+/).map((entry) => entry.trim()).filter(Boolean).map((address) => ({ address, name: '' }));
const addressText = (values: Draft['to']) => values.map((entry) => entry.address).join(', ');

export function MailCompose({ accountId, draftId, accounts, orbitId, orbitName, onClose }: { accountId: string; draftId: string; accounts: Account[]; orbitId?: string; orbitName?: string | undefined; onClose: () => void }) {
  const everReady = useRef(false);
  const scope: Scope = { accountId, ...(orbitId ? { orbitId } : {}) };
  const valid = /^[a-f\d-]{36}$/i.test(accountId) && /^[a-f\d-]{36}$/i.test(draftId) &&
    accounts.some((account) => account.id === accountId);
  const draft = useQuery({ queryKey: ['mail-reader', 'draft', accountId, draftId, orbitId ?? null], enabled: valid,
    queryFn: ({ signal }) => mailRequest(`/api/mail/drafts/${draftId}?${scopeQuery(scope)}`, draftSchema, {}, signal, DRAFT_LIMIT),
    retry: false, staleTime: Infinity, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false });
  const attachments = useQuery({ queryKey: ['mail-reader', 'draft-attachments', accountId, draftId, orbitId ?? null], enabled: valid && draft.data?.state === 'editing',
    queryFn: ({ signal }) => mailRequest(`/api/mail/drafts/${draftId}/attachments?${scopeQuery(scope)}`, draftAttachmentListSchema, {}, signal),
    retry: false, staleTime: Infinity, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false });
  if (!valid) return <p role="alert">This draft address is invalid or outside this mailbox.</p>;
  if (!everReady.current && (draft.isPending || draft.isFetching || (draft.data?.state === 'editing' && (attachments.isPending || attachments.isFetching)))) return <p role="status">Loading draft…</p>;
  if (!everReady.current && (draft.isError || attachments.isError)) return <p role="alert">{draft.error?.message ?? attachments.error?.message} <button type="button" onClick={() => { void draft.refetch(); void attachments.refetch(); }}>Retry</button></p>;
  if (!draft.data) return <p role="alert">This draft is unavailable. Return to mail and try again.</p>;
  everReady.current = true;
  return <Editor key={draft.data.id} initial={draft.data} initialAttachments={attachments.data?.attachments ?? []}
    account={accounts.find((entry) => entry.id === accountId)!} orbitName={orbitName} onClose={onClose} />;
}

function Editor({ initial, initialAttachments, account, orbitName, onClose }: { initial: Draft; initialAttachments: Attachment[]; account: Account; orbitName?: string | undefined; onClose: () => void }) {
  const queryClient = useQueryClient();
  const scope: Scope = { accountId: initial.accountId, ...(initial.orbitId ? { orbitId: initial.orbitId } : {}) };
  const path = `/api/mail/drafts/${initial.id}`;
  const query = scopeQuery(scope);
  const [fields, setFields] = useState<Fields>({ to: initial.to, cc: initial.cc, bcc: initial.bcc,
    subject: initial.subject, bodyText: initial.bodyText, attachmentRefs: initial.attachmentRefs });
  const fieldsRef = useRef(fields);
  const [addressInputs, setAddressInputs] = useState({ to: addressText(initial.to), cc: addressText(initial.cc), bcc: addressText(initial.bcc) });
  const [files, setFiles] = useState(initialAttachments);
  const revisionRef = useRef(initial.revision);
  const savedRef = useRef(JSON.stringify(fields));
  const [status, setStatus] = useState<'saved' | 'saving' | 'unsaved' | 'conflict' | 'offline'>('saved');
  const [error, setError] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState(initial.state);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const controllers = useRef(new Set<AbortController>());
  const alive = useRef(true);
  const generation = useRef(0);
  const statusVersion = useRef(0);
  const terminalSent = useRef(initial.state === 'sent');
  const loggedOut = useRef(false);
  const leavingAfterDiscard = useRef(false);
  const blocked = useRef(false);
  const sendingKey = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const dirty = status !== 'saved' || busy;
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const current = ++generation.current;
    alive.current = !loggedOut.current;
    blocked.current = loggedOut.current;
    const stop = () => { loggedOut.current = true; alive.current = false; blocked.current = true; generation.current++; statusVersion.current++; controllers.current.forEach((controller) => controller.abort());
      fieldsRef.current = { to: [], cc: [], bcc: [], subject: '', bodyText: '', attachmentRefs: [] }; setFields(fieldsRef.current); setFiles([]); setAddressInputs({ to: '', cc: '', bcc: '' }); };
    window.addEventListener('station:logout', stop);
    return () => { if (generation.current === current) generation.current++; statusVersion.current++; alive.current = false; blocked.current = true; controllers.current.forEach((controller) => controller.abort()); window.removeEventListener('station:logout', stop); };
  }, []);
  const blocker = useBlocker({ shouldBlockFn: ({ current, next }) => !leavingAfterDiscard.current && dirty &&
    (next.pathname !== current.pathname || JSON.stringify(next.search) !== JSON.stringify(current.search)),
    enableBeforeUnload: () => !leavingAfterDiscard.current && dirty, withResolver: true });
  const request = async <S extends z.ZodType>(url: string, schema: S, options: RequestInit = {}, maxBytes = LIMIT) => {
    const current = generation.current;
    const controller = new AbortController(); controllers.current.add(controller);
    try { const result = await mailRequest(url, schema, options, controller.signal, maxBytes);
      if (!alive.current || generation.current !== current) throw new Error('This draft is no longer active.');
      return result; }
    finally { controllers.current.delete(controller); }
  };
  const queue = <T,>(work: () => Promise<T>): Promise<T> => {
    const current = generation.current;
    const next = chain.current.then(() => { if (!alive.current || blocked.current || current !== generation.current) throw new Error('This draft is no longer active.'); return work(); });
    chain.current = next.catch(() => undefined);
    return next;
  };
  const flush = async () => {
    if (blocked.current || state !== 'editing') return false;
    while (savedRef.current !== JSON.stringify(fieldsRef.current)) {
      const snapshot = fieldsRef.current;
      setStatus('saving');
      const parsed = draftSchema.pick({ to: true, cc: true, bcc: true, subject: true, bodyText: true, attachmentRefs: true }).safeParse(snapshot);
      if (!parsed.success) { setStatus('unsaved'); setError('Check recipient addresses and draft length before saving.'); return false; }
      try {
        const result = await request(`${path}?${query}`, draftSchema, json('PUT', { ...snapshot, revision: revisionRef.current }), DRAFT_LIMIT);
        if (!alive.current) return false;
        revisionRef.current = result.revision; savedRef.current = JSON.stringify(snapshot);
        setStatus(savedRef.current === JSON.stringify(fieldsRef.current) ? 'saved' : 'unsaved'); setError('');
        void queryClient.invalidateQueries({ queryKey: ['mail-reader', 'draft-overview'] });
      } catch (issue) {
        if (!alive.current) return false;
        const message = issue instanceof Error ? issue.message : 'Save failed. Try again.';
        blocked.current = issue instanceof MailHttpError && issue.status === 409;
        setStatus(blocked.current ? 'conflict' : 'offline'); setError(message); return false;
      }
    }
    return true;
  };
  useEffect(() => {
    if (state !== 'editing' || status !== 'unsaved') return;
    const timer = window.setTimeout(() => { void queue(flush).catch(() => undefined); }, 550);
    return () => window.clearTimeout(timer);
  });
  const update = (next: Fields) => { if (sendingKey.current || state !== 'editing') return; fieldsRef.current = next; setFields(next);
    if (blocked.current) return;
    setStatus('unsaved'); setError(''); };
  const updateAddresses = (role: 'to' | 'cc' | 'bcc', value: string) => {
    if (sendingKey.current || state !== 'editing') return;
    setAddressInputs((current) => ({ ...current, [role]: value }));
    update({ ...fieldsRef.current, [role]: parseAddresses(value) });
  };
  const save = () => void queue(flush).catch(() => undefined);
  const upload = (file: File) => { void queue(async () => {
    if (!await flush()) return;
    if (file.size > 8 * 1024 * 1024 || file.size === 0) { setError('Choose a file between 1 byte and 8 MiB.'); return; }
    setBusy(true); setStatus('saving');
    try {
      const uploadKey = crypto.randomUUID();
      const result = await request(`${path}/attachments?${query}`, draftAttachmentMutationSchema, { method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Attachment-Name': encodeURIComponent(file.name),
          'X-Upload-Key': uploadKey, 'X-Draft-Revision': String(revisionRef.current), ...csrfHeaders() }, body: file });
      if (!alive.current) return;
      revisionRef.current = result.revision;
      const next = { ...fieldsRef.current, attachmentRefs: [...fieldsRef.current.attachmentRefs, result.attachment.id] };
      const saved = JSON.parse(savedRef.current) as Fields;
      fieldsRef.current = next; setFields(next); savedRef.current = JSON.stringify({ ...saved, attachmentRefs: next.attachmentRefs });
      setFiles((current) => [...current, result.attachment]); setStatus(savedRef.current === JSON.stringify(next) ? 'saved' : 'unsaved'); setError('');
    } catch (issue) { if (alive.current) { blocked.current = issue instanceof MailHttpError && issue.status === 409;
      setStatus(blocked.current ? 'conflict' : 'offline'); setError(issue instanceof Error ? issue.message : 'Upload failed. Try again.'); } }
    finally { if (alive.current) setBusy(false); }
  }).catch(() => undefined); };
  const remove = (id: string) => { void queue(async () => {
    if (!await flush()) return;
    setBusy(true);
    try {
      const result = await request(`${path}/attachments/${id}?${query}`, draftAttachmentRevisionSchema, json('DELETE', { revision: revisionRef.current }));
      if (!alive.current) return;
      revisionRef.current = result.revision;
      const next = { ...fieldsRef.current, attachmentRefs: fieldsRef.current.attachmentRefs.filter((ref) => ref !== id) };
      const saved = JSON.parse(savedRef.current) as Fields;
      fieldsRef.current = next; setFields(next); savedRef.current = JSON.stringify({ ...saved, attachmentRefs: next.attachmentRefs });
      setFiles((current) => current.filter((file) => file.id !== id)); setStatus(savedRef.current === JSON.stringify(next) ? 'saved' : 'unsaved'); setError('');
    } catch (issue) { if (alive.current) { blocked.current = issue instanceof MailHttpError && issue.status === 409;
      setStatus(blocked.current ? 'conflict' : 'offline'); setError(issue instanceof Error ? issue.message : 'Removal failed. Try again.'); } }
    finally { if (alive.current) setBusy(false); }
  }).catch(() => undefined); };
  const adoptOperation = async (result: Operation, version: number) => {
    if (!alive.current || version !== statusVersion.current || (terminalSent.current && result.state !== 'succeeded')) return;
    if (result.state === 'succeeded') {
      terminalSent.current = true; setOperation(result); setState('sent'); setError(''); return;
    }
    if (result.state === 'failed') {
      try {
        const current = await request(`${path}?${query}`, draftSchema, {}, DRAFT_LIMIT);
        if (!alive.current || version !== statusVersion.current || terminalSent.current) return;
        if (current.state !== 'editing') throw new Error('The draft has not reopened yet. Check status again.');
        const owned = await request(`${path}/attachments?${query}`, draftAttachmentListSchema);
        if (!alive.current || version !== statusVersion.current || terminalSent.current) return;
        const ready = owned.attachments.filter((file) => current.attachmentRefs.includes(file.id) && file.status === 'ready');
        if (owned.revision !== current.revision || ready.length !== current.attachmentRefs.length)
          throw new Error('Draft attachments changed while loading. Check status again.');
        const next: Fields = { to: current.to, cc: current.cc, bcc: current.bcc, subject: current.subject,
          bodyText: current.bodyText, attachmentRefs: current.attachmentRefs };
        fieldsRef.current = next; setFields(next); savedRef.current = JSON.stringify(next);
        setAddressInputs({ to: addressText(current.to), cc: addressText(current.cc), bcc: addressText(current.bcc) });
        setFiles(ready); revisionRef.current = current.revision; setStatus('saved');
        sendingKey.current = null; setOperation(result); setState('editing'); setError(result.message);
        queryClient.setQueryData(['mail-reader', 'draft', current.accountId, current.id, current.orbitId], current);
        queryClient.setQueryData(['mail-reader', 'draft-attachments', current.accountId, current.id, current.orbitId], owned);
      } catch (issue) { if (alive.current && version === statusVersion.current && !terminalSent.current)
        setError(issue instanceof Error ? issue.message : 'Draft details could not be loaded. Check status again.'); }
      return;
    }
    setOperation(result); setState('sending'); setError('');
  };
  const recover = async () => {
    const version = ++statusVersion.current;
    try {
      const statusQuery = sendingKey.current ? `${query}&idempotencyKey=${encodeURIComponent(sendingKey.current)}` : query;
      const result = await request(`${path}/send?${statusQuery}`, sendOperationSchema);
      await adoptOperation(result, version);
      return result;
    } catch (issue) { if (alive.current && version === statusVersion.current && !terminalSent.current)
      setError(issue instanceof Error ? issue.message : 'Send status is unavailable. Check again.'); return null; }
  };
  useEffect(() => { if (initial.state === 'sending') void recover(); }, []);
  const send = () => { if (sendingKey.current || busy || status === 'conflict') return;
    sendingKey.current = crypto.randomUUID(); setBusy(true);
    void queue(async () => {
      if (!await flush()) { sendingKey.current = null; return; }
      try {
        const result = await request(`${path}/send?${query}`, sendOperationSchema, json('POST', { idempotencyKey: sendingKey.current, revision: revisionRef.current }));
        if (!alive.current) return;
        await adoptOperation(result, ++statusVersion.current);
        void queryClient.invalidateQueries({ queryKey: ['mail-reader', 'draft-overview'] });
      } catch (issue) { if (alive.current) {
        setState('sending'); setError('The send response was lost. Check status before taking another action.');
        const recovered = await recover();
        if (!recovered && issue instanceof MailHttpError && issue.status >= 400 && issue.status < 500) {
          try { const current = await request(`${path}?${query}`, draftSchema, {}, DRAFT_LIMIT);
            if (alive.current && current.state === 'editing') { sendingKey.current = null; setState('editing'); setError(issue.message); }
          } catch { /* An unavailable draft must stay locked. */ }
        }
      } }
    }).catch(() => undefined).finally(() => { if (alive.current) setBusy(false); });
  };
  const reconcile = () => { if (!operation || busy) return; setBusy(true);
    const version = ++statusVersion.current;
    void queue(async () => {
      try { const result = await request(`/api/mail/sends/${operation.id}/reconcile?${query}`, sendOperationSchema, { method: 'POST', headers: csrfHeaders() });
        await adoptOperation(result, version); }
      catch (issue) { if (alive.current && version === statusVersion.current && !terminalSent.current)
        setError(issue instanceof Error ? issue.message : 'Sent could not be checked. Try again.'); }
    }).catch(() => undefined).finally(() => { if (alive.current) setBusy(false); });
  };
  const discard = () => { if (state !== 'editing' || busy || !window.confirm('Discard this draft and its attachments?')) return;
    setBusy(true); void queue(async () => {
      try { const result = await request(`${path}/discard?${query}`, draftSchema, json('POST', { revision: revisionRef.current }), DRAFT_LIMIT);
        if (alive.current) { leavingAfterDiscard.current = true; setState(result.state); setStatus('saved');
          void queryClient.invalidateQueries({ queryKey: ['mail-reader', 'draft-overview'] }); onClose(); } }
      catch (issue) { if (alive.current) setError(issue instanceof Error ? issue.message : 'Discard failed. Try again.'); }
    }).catch(() => undefined).finally(() => { if (alive.current) setBusy(false); });
  };
  const canSend = state === 'editing' && !busy && status === 'saved' && fields.to.length + fields.cc.length + fields.bcc.length > 0 &&
    !account.needsReconnect && !sendingKey.current;
  return <section className="mail-compose" aria-label="Compose message">
    <div className="mail-compose-head"><div><p className="mail-overline">{initial.parentItemId ? 'Reply' : 'New message'}</p>
      <h2 ref={heading} tabIndex={-1}>{initial.parentItemId ? 'Reply to message' : 'Compose message'}</h2>
      <p>From {account.email}{initial.orbitId && orbitName ? ` · ${orbitName} Orbit` : ''}</p></div>
      <button type="button" onClick={onClose}>Close</button></div>
    {blocker.status === 'blocked' && <div className="mail-compose-alert" role="alert"><p>{status === 'conflict' ?
      'Another tab changed this draft. Copy your text before leaving.' : status === 'offline' ?
      'This draft is not saved. Retry or copy your text before leaving.' : 'Changes are still saving. Save before leaving this draft.'}</p>
      <button type="button" onClick={() => { if (state !== 'editing' && !dirty) { blocker.proceed(); return; }
        void queue(flush).then((ok) => { if (ok) blocker.proceed(); }).catch(() => undefined); }}>Save and leave</button>
      <button type="button" onClick={() => { if (window.confirm('Leave this draft without saving these changes?')) blocker.proceed(); }}>Leave without saving</button>
      <button type="button" onClick={() => blocker.reset()}>Keep editing</button></div>}
    {state === 'editing' ? <>
      <div className="mail-compose-fields"><label>To<input autoComplete="off" value={addressInputs.to} disabled={Boolean(sendingKey.current)} onChange={(event) => updateAddresses('to', event.target.value)} placeholder="name@example.com" /></label>
        <label>Cc<input autoComplete="off" value={addressInputs.cc} disabled={Boolean(sendingKey.current)} onChange={(event) => updateAddresses('cc', event.target.value)} /></label>
        <label>Bcc<input autoComplete="off" value={addressInputs.bcc} disabled={Boolean(sendingKey.current)} onChange={(event) => updateAddresses('bcc', event.target.value)} /></label>
        <label>Subject<input value={fields.subject} maxLength={4096} disabled={Boolean(sendingKey.current)} readOnly={Boolean(initial.parentItemId)} onChange={(event) => update({ ...fieldsRef.current, subject: event.target.value })} /></label>
        {initial.parentItemId && <p className="mail-compose-hint">The reply subject stays fixed so this message remains in its conversation.</p>}
        <label className="mail-compose-body">Message<textarea value={fields.bodyText} disabled={Boolean(sendingKey.current)} onChange={(event) => update({ ...fieldsRef.current, bodyText: event.target.value })} rows={12} /></label></div>
      <div className="mail-compose-files"><h3>Attachments</h3>{files.map((file) => <div key={file.id} className="mail-compose-file"><a href={`${path}/attachments/${file.id}/download?${query}`}>{file.filename} ({Math.ceil(file.byteSize / 1024)} KB)</a>
        <button type="button" disabled={busy} onClick={() => remove(file.id)}>Remove</button></div>)}
        <label className="mail-compose-upload">Attach file<input type="file" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) upload(file); event.target.value = ''; }} /></label></div>
      <div className="mail-compose-footer"><span role="status">{status === 'saved' ? 'Saved' : status === 'saving' ? 'Saving…' : status === 'conflict' ? 'Conflict: your text is kept here' : status === 'offline' ? 'Not saved. Retry when connected.' : 'Unsaved changes'}</span>
        <div><button type="button" onClick={save} disabled={busy || status === 'saved' || status === 'conflict'}>Save now</button>
          <button type="button" onClick={discard} disabled={busy}>Discard</button>
          <button ref={sendButton} className="mail-compose-send" type="button" onClick={send} disabled={!canSend}>Send message</button></div></div>
      {status === 'conflict' && <p className="mail-compose-hint">Another tab changed this draft. Copy your text, then reopen the saved version. This text will stay here until you leave.</p>}
    </> : <div className="mail-compose-result"><h3>{state === 'sent' ? 'Message sent' : state === 'discarded' ? 'Draft discarded' : 'Send needs attention'}</h3>
      <p>{operation?.state === 'outcome_unknown' ? 'Delivery may have happened. Check your Sent folder, then use Check Sent here. This message will not be sent again automatically.' :
        operation?.message ?? 'The send may have reached Gmail. Check status or Sent before taking another action.'}</p>
      {state === 'sending' && <div><button type="button" disabled={busy} onClick={() => void recover()}>Check status</button>
        {operation?.state === 'outcome_unknown' && <button type="button" disabled={busy} onClick={reconcile}>Check Sent</button>}</div>}</div>}
    {error && <p role="alert" className="mail-compose-error">{error}</p>}
  </section>;
}
