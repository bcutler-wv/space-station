import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from '@tanstack/react-router';
import type { z } from 'zod';
import { conversationPageSchema, labelListSchema, mailContextSchema, mailNavigationSearchSchema, messagePageSchema, readerIdSchema } from '@station/shared';
import { MailBody } from './mail-body.js';
import { MailMessageActions, PendingMessageChanges } from './mail-message-actions.js';
import { createDraft, DraftOverview, MailCompose } from './mail-compose.js';

type Scope = { accountId?: string | undefined; orbitId?: string | undefined; labelId?: string | undefined; subject?: string | undefined };
type Thread = { accountId: string; threadId: string };
const mailKey = ['mail-reader'] as const;
const timeoutMs = 10_000;
const jsonLimit = 512 * 1024;
let mailSignedOut = false;
// Installed once for the browser document, including when Mail is unmounted.
window.addEventListener('station:logout', () => { mailSignedOut = true; });

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) throw new Error('Mail response is too large. Narrow the view and try again.');
  if (!response.body) throw new Error('Mail response is empty. Try again.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        throw new Error('Mail response is too large. Narrow the view and try again.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Mail response is invalid. Try again.'); }
}

async function getJson<S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
  if (mailSignedOut) throw new Error('Signed out.');
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const error = await boundedJson(response, 8 * 1024).catch(() => ({})) as { error?: string };
    throw new Error(error.error ?? (response.status === 401 ? 'Your session ended. Sign in again.' : 'Mail could not be loaded. Try again.'));
  }
  const result = schema.parse(await boundedJson(response, jsonLimit));
  if (mailSignedOut) throw new Error('Signed out.');
  return result;
}
function readScope(searchStr: string): { valid: true; scope: Scope } | { valid: false } {
  const search = new URLSearchParams(searchStr);
  const keys = [...search.keys()];
  if (new Set(keys).size !== keys.length) return { valid: false };
  const parsed = mailNavigationSearchSchema.safeParse(Object.fromEntries(search));
  return parsed.success ? { valid: true, scope: parsed.data } : { valid: false };
}
function parameters(scope: Scope): URLSearchParams {
  const search = new URLSearchParams();
  if (scope.accountId) search.set('accountId', scope.accountId);
  else if (scope.orbitId) search.set('orbitId', scope.orbitId);
  if (scope.labelId) search.set('labelId', scope.labelId);
  if (scope.subject) search.set('subject', scope.subject);
  return search;
}
function canShortcut(target: EventTarget | null, event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (!(target instanceof HTMLElement)) return true;
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return false;
  if (target.closest('.mail-row')) return true;
  return !target.closest('button, a');
}
function displayDate(value: string | null) {
  return value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Date unavailable';
}

export function MailScreen({ thread, draftRoute }: { thread?: Thread; draftRoute?: { accountId: string; draftId: string } }) {
  const queryClient = useQueryClient();
  const loggedOut = useRef(mailSignedOut);
  const [signedOut, setSignedOut] = useState(mailSignedOut);
  useEffect(() => {
    const stop = () => {
      mailSignedOut = true;
      loggedOut.current = true;
      setSignedOut(true);
    };
    window.addEventListener('station:logout', stop);
    return () => window.removeEventListener('station:logout', stop);
  }, []);
  const navigate = useNavigate();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const parsedResult = useMemo(() => readScope(searchStr), [searchStr]);
  const parsed: Scope = parsedResult.valid ? parsedResult.scope : {};
  const validThread = !thread || (readerIdSchema.safeParse(thread.accountId).success && readerIdSchema.safeParse(thread.threadId).success);
  const threadInScope = !thread || !parsed.accountId || parsed.accountId === thread.accountId;
  const validDraftRoute = !draftRoute || (readerIdSchema.safeParse(draftRoute.accountId).success && readerIdSchema.safeParse(draftRoute.draftId).success &&
    (!parsed.accountId || parsed.accountId === draftRoute.accountId));
  const validAddress = parsedResult.valid && validThread && threadInScope && validDraftRoute;
  const context = useQuery({ queryKey: [...mailKey, 'context'], enabled: validAddress && !signedOut, queryFn: ({ signal }) => getJson<typeof mailContextSchema>('/api/mail/context', mailContextSchema, signal), retry: false, staleTime: Infinity, refetchOnWindowFocus: false });
  const firstOrbit = context.data?.orbits.find((entry) => context.data?.accounts.some((account) => account.orbitId === entry.id));
  const scope: Scope = parsed.accountId || parsed.orbitId ? parsed : thread ? { ...parsed, accountId: thread.accountId } :
    draftRoute ? { ...parsed, accountId: draftRoute.accountId } : { ...parsed, ...(firstOrbit ? { orbitId: firstOrbit.id } : {}) };
  useEffect(() => {
    if (!loggedOut.current && validAddress && !draftRoute && !parsed.accountId && !parsed.orbitId && (thread || firstOrbit))
      void navigate({ to: thread ? '/mail/thread/$accountId/$threadId' : '/mail',
        ...(thread ? { params: { accountId: thread.accountId, threadId: thread.threadId } } : {}),
        search: Object.fromEntries(parameters(thread ? { ...parsed, accountId: thread.accountId } : { ...parsed, orbitId: firstOrbit!.id })), replace: true });
  }, [parsed, firstOrbit, thread, draftRoute, navigate, signedOut, validAddress]);
  const selectedAccount = scope.accountId ? context.data?.accounts.find((entry) => entry.id === scope.accountId) : undefined;
  const selectedOrbit = scope.orbitId ? context.data?.orbits.find((entry) => entry.id === scope.orbitId) : undefined;
  const validScope = validAddress && Boolean(selectedAccount || selectedOrbit);
  const [draft, setDraft] = useState(scope.subject ?? '');
  const [notice, setNotice] = useState(false);
  const [focused, setFocused] = useState(0);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [actionItem, setActionItem] = useState<string | null>(null);
  const [showDrafts, setShowDrafts] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [composeAccount, setComposeAccount] = useState('');
  const createController = useRef<AbortController | null>(null);
  const createGeneration = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const threadHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterPage = useRef<number | null>(null);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    createGeneration.current++;
    createController.current?.abort();
    createController.current = null;
    setCreating(false);
    return () => { createGeneration.current++; createController.current?.abort(); createController.current = null; };
  }, [scopeKey, thread?.threadId, draftRoute?.draftId]);
  useEffect(() => { setDraft(scope.subject ?? ''); }, [scope.subject]);
  useEffect(() => { setFocused(0); setOpenItem(null); setActionItem(null); }, [scopeKey, thread?.threadId]);
  useEffect(() => {
    if (loggedOut.current || !validAddress) return;
    const accountId = selectedAccount?.id;
    const onMail = (event: Event) => {
      const changed = (event as CustomEvent<{ accountId?: string }>).detail?.accountId;
      if (!changed || changed === accountId || (selectedOrbit && context.data?.accounts.some((entry) => entry.orbitId === selectedOrbit.id && entry.id === changed))) setNotice(true);
    };
    window.addEventListener('station:mail-update', onMail);
    return () => window.removeEventListener('station:mail-update', onMail);
  }, [selectedAccount?.id, selectedOrbit?.id, context.data, validAddress]);
  const labels = useQuery({ queryKey: [...mailKey, 'labels', scope.accountId ?? null, scope.orbitId ?? null], enabled: validScope && !signedOut,
    queryFn: ({ signal }) => getJson<typeof labelListSchema>(`/api/mail/labels?${new URLSearchParams(scope.accountId ? { accountId: scope.accountId } : { orbitId: scope.orbitId! })}`, labelListSchema, signal),
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false });
  const conversations = useInfiniteQuery({ queryKey: [...mailKey, 'conversations', scopeKey], enabled: validScope && !thread && !signedOut,
    initialPageParam: null as string | null, getNextPageParam: (page: z.infer<typeof conversationPageSchema>) => page.nextCursor,
    queryFn: ({ pageParam, signal }) => { const query = parameters(scope); if (pageParam) query.set('cursor', pageParam); return getJson<typeof conversationPageSchema>(`/api/mail/conversations?${query}`, conversationPageSchema, signal); },
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false });
  const messages = useInfiniteQuery({ queryKey: [...mailKey, 'thread', thread?.accountId, thread?.threadId, scope.orbitId ?? null], enabled: validScope && validThread && threadInScope && Boolean(thread) && !signedOut,
    initialPageParam: null as string | null, getNextPageParam: (page: z.infer<typeof messagePageSchema>) => page.nextCursor,
    queryFn: ({ pageParam, signal }) => { const query = new URLSearchParams({ accountId: thread!.accountId }); if (scope.orbitId) query.set('orbitId', scope.orbitId); if (pageParam) query.set('cursor', pageParam); return getJson<typeof messagePageSchema>(`/api/mail/threads/${thread!.threadId}/messages?${query}`, messagePageSchema, signal); },
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false });
  const rows = conversations.data?.pages.flatMap((page) => page.conversations) ?? [];
  const threadRows = messages.data?.pages.flatMap((page) => page.messages) ?? [];
  useEffect(() => { (thread ? threadHeadingRef : headingRef).current?.focus(); }, [thread?.threadId, Boolean(threadRows.length)]);
  useEffect(() => {
    const index = focusAfterPage.current;
    if (index !== null && rows.length > index) {
      focusAfterPage.current = null;
      listRef.current?.querySelectorAll<HTMLButtonElement>('.mail-row')[index]?.focus();
    }
  }, [rows.length]);
  const updateScope = (next: Scope, replace = false) => { if (loggedOut.current || !validAddress) return; setNotice(false); void navigate({ to: '/mail', search: Object.fromEntries(parameters(next)), replace }); };
  useEffect(() => {
    if (loggedOut.current || !validAddress) return;
    if (draft === (scope.subject ?? '')) return;
    const handle = setTimeout(() => updateScope({ ...scope, subject: draft.trim().slice(0, 128) || undefined }, true), 350);
    return () => clearTimeout(handle);
  }, [draft, scopeKey, validAddress]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (loggedOut.current || !validAddress) return;
      if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
          !(event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]'))) {
        if (actionItem) { event.preventDefault(); setActionItem(null); threadHeadingRef.current?.focus(); return; }
        if (openItem) { event.preventDefault(); setOpenItem(null); threadHeadingRef.current?.focus(); return; }
        if (thread) { event.preventDefault(); void navigate({ to: '/mail', search: Object.fromEntries(parameters(scope)) }); return; }
      }
      if (!canShortcut(event.target, event)) return;
      if (thread || draftRoute || !rows.length) return;
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault(); const index = Math.max(0, Math.min(rows.length - 1, focused + (event.key === 'j' ? 1 : -1)));
        setFocused(index); listRef.current?.querySelectorAll<HTMLButtonElement>('.mail-row')[index]?.focus();
      }
      if (event.key === 'Enter') { event.preventDefault(); const row = rows[focused]; if (row) void navigate({ to: '/mail/thread/$accountId/$threadId', params: { accountId: row.accountId, threadId: row.threadId }, search: Object.fromEntries(parameters(scope)) }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, focused, thread, draftRoute, openItem, actionItem, navigate, scope, validAddress]);
  useEffect(() => { if (!validAddress) void queryClient.cancelQueries({ queryKey: mailKey }); }, [validAddress, queryClient]);
  const refresh = () => { if (loggedOut.current || !validAddress) return; setNotice(false); void queryClient.resetQueries({ queryKey: [...mailKey, 'conversations'] }); void queryClient.resetQueries({ queryKey: [...mailKey, 'thread'] }); void queryClient.invalidateQueries({ queryKey: [...mailKey, 'labels'], refetchType: 'active' }); };
  const availableAccounts = context.data?.accounts.filter((account) => scope.accountId ? account.id === scope.accountId :
    !scope.orbitId || account.orbitId === scope.orbitId) ?? [];
  const openDraft = (value: { id: string; accountId: string; orbitId: string | null }) => {
    if (loggedOut.current) return;
    void navigate({ to: '/mail/draft/$accountId/$draftId', params: { accountId: value.accountId, draftId: value.id },
      search: Object.fromEntries(parameters({ ...(value.orbitId ? { orbitId: value.orbitId } : { accountId: value.accountId }) })) });
  };
  const startDraft = (accountId: string, parentItemId?: string) => {
    if (loggedOut.current || creating) return;
    const account = context.data?.accounts.find((entry) => entry.id === accountId);
    if (!account || (scope.orbitId && account.orbitId !== scope.orbitId && !parentItemId)) return;
    setCreating(true); setCreateError('');
    const controller = new AbortController(); createController.current = controller;
    const generation = createGeneration.current;
    void createDraft(accountId, scope.orbitId, parentItemId, controller.signal).then((created) => {
      if (!loggedOut.current && createGeneration.current === generation) openDraft(created);
    }).catch((issue: Error) => {
      if (!loggedOut.current && createGeneration.current === generation && !controller.signal.aborted) setCreateError(issue.message);
    }).finally(() => { if (!loggedOut.current && createGeneration.current === generation) setCreating(false); });
  };
  if (signedOut) return <section className="mail-workspace" aria-label="Mail"><p role="status">Signing out…</p></section>;
  if (!validAddress) return <section className="mail-workspace" aria-label="Mail"><h1>Mail</h1><p role="alert">This mail address has invalid filters. Check the link or return to mail.</p><a href="/mail">Open mail</a></section>;
  return <section className="mail-workspace" aria-label="Mail">
    <div className="mail-heading"><div><p className="mail-overline">Live mailbox</p><h1 ref={headingRef} tabIndex={-1}>Mail</h1><p>Messages from your connected accounts.</p></div><div className="mail-heading-actions">{!draftRoute && <><button type="button" aria-expanded={showDrafts} onClick={() => { setShowDrafts(!showDrafts); setShowChanges(false); setComposeAccount(''); }}>Drafts and sends</button><button type="button" aria-expanded={showChanges} onClick={() => { setShowChanges(!showChanges); setShowDrafts(false); setComposeAccount(''); }}>Pending message changes</button><button type="button" disabled={!availableAccounts.length} onClick={() => { setComposeAccount(availableAccounts[0]?.id ?? ''); setShowDrafts(false); setShowChanges(false); }}>New message</button><button type="button" onClick={refresh}>Refresh mail</button></>}</div></div>
    {notice && <div className="mail-update" role="status"><span>New mail available.</span><button type="button" onClick={refresh}>Refresh</button></div>}
    {context.isPending && <p role="status">Loading mail accounts…</p>}
    {context.isError && <p role="alert">{context.error.message} <button onClick={() => void context.refetch()}>Retry</button></p>}
    {context.data && !context.data.accounts.length && <div className="mail-empty"><h2>No mail account connected</h2><p>Connect Google mail to read messages here.</p><a href="/setup/google">Connect Google mail</a></div>}
    {context.data && context.data.accounts.length > 0 && <>
      {createError && <p role="alert">{createError}</p>}
      {composeAccount && !draftRoute && <div className="mail-compose-start"><label>Send from<select aria-label="Send from" value={composeAccount} onChange={(event) => setComposeAccount(event.target.value)}>{availableAccounts.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}</select></label><button type="button" disabled={creating} onClick={() => startDraft(composeAccount)}>{creating ? 'Opening…' : 'Continue'}</button><button type="button" onClick={() => setComposeAccount('')}>Cancel</button></div>}
      {showDrafts && !draftRoute && <DraftOverview accounts={scope.orbitId ? context.data.accounts : availableAccounts} {...(scope.orbitId ? { orbitId: scope.orbitId } : {})} onOpen={openDraft} />}
      {showChanges && !draftRoute && <PendingMessageChanges key={scope.orbitId ?? 'all-orbits'} accounts={context.data.accounts} {...(scope.orbitId ? { orbitId: scope.orbitId } : {})} />}
      {draftRoute ? validScope ? <MailCompose key={`${draftRoute.accountId}:${draftRoute.draftId}:${scope.orbitId ?? ''}`} accountId={draftRoute.accountId} draftId={draftRoute.draftId} accounts={context.data.accounts}
        orbitName={scope.orbitId ? context.data.orbits.find((entry) => entry.id === scope.orbitId)?.name : undefined}
        {...(scope.orbitId ? { orbitId: scope.orbitId } : {})} onClose={() => void navigate({ to: '/mail', search: Object.fromEntries(parameters(scope)) })} /> :
        <p role="alert">This draft's mailbox or Orbit is unavailable. Check the link or return to mail.</p> : <>
      <div className="mail-controls"><label>Mailbox<select aria-label="Mailbox" value={scope.accountId ? `account:${scope.accountId}` : scope.orbitId ? `orbit:${scope.orbitId}` : ''} onChange={(event) => { const [kind, id] = event.target.value.split(':'); updateScope(kind === 'account' ? { accountId: id } : { orbitId: id }); }}>
        {context.data.orbits.filter((entry) => context.data.accounts.some((account) => account.orbitId === entry.id)).map((entry) => <option key={entry.id} value={`orbit:${entry.id}`}>{entry.name} Orbit</option>)}
        {context.data.accounts.map((entry) => <option key={entry.id} value={`account:${entry.id}`}>{entry.email}</option>)}
      </select></label><label>Label<select aria-label="Label" value={scope.labelId ?? ''} disabled={!validScope || labels.isPending || labels.isError} onChange={(event) => updateScope({ ...scope, labelId: event.target.value || undefined })}><option value="">All labels</option>{labels.data?.labels.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{scope.orbitId ? ` · ${context.data.accounts.find((account) => account.id === entry.accountId)?.email ?? 'Account'}` : ''}</option>)}</select></label>
      <label className="mail-subject">Subject contains<input aria-label="Subject contains" value={draft} maxLength={128} onChange={(event) => setDraft(event.target.value)} placeholder="Search subjects" /></label></div>
      {labels.isError && <p role="alert">Labels could not be loaded. <button onClick={() => void labels.refetch()}>Retry</button></p>}
      {!validScope && <p role="alert">This mailbox is no longer available. Choose another mailbox.</p>}
      {!validThread && <p role="alert">This conversation address is invalid. Return to mail.</p>}
      {!threadInScope && <p role="alert">This conversation belongs to another account. Return to mail.</p>}
      {selectedAccount?.needsReconnect && <p className="mail-update">This account needs to reconnect. <a href="/setup/google">Reconnect Google mail</a></p>}
      {thread ? <div className="mail-detail"><button type="button" className="mail-back" onClick={() => void navigate({ to: '/mail', search: Object.fromEntries(parameters(scope)) })}>Back to conversations</button>
        <h2 ref={threadHeadingRef} tabIndex={-1}>{threadRows.at(-1)?.subject || 'Conversation'}</h2>
        {messages.isPending && <p role="status">Loading conversation…</p>}
        {messages.isError && <p role="alert">{messages.error.message} <button onClick={() => void messages.refetch()}>Retry</button></p>}
        {messages.isSuccess && threadRows.length === 0 && <p>This conversation has no available messages.</p>}
        {threadRows.map((message) => <article className="mail-message" key={message.id} aria-label={message.subject || 'Message'}><div className="mail-message-head"><div><strong>{message.from?.name || message.from?.address || (message.direction === 'out' ? 'You' : 'Unknown sender')}</strong><p>{message.from?.address}</p></div><time>{displayDate(message.receivedAt || message.sentAt || message.internalAt)}</time></div><p className="mail-recipients">To: {message.recipients.filter((entry) => entry.role === 'to').map((entry) => entry.name || entry.address).join(', ') || 'Unavailable'}</p><p>{message.snippet}</p><div className="mail-message-actions"><button type="button" aria-expanded={openItem === message.id} onClick={() => setOpenItem(openItem === message.id ? null : message.id)}>{openItem === message.id ? 'Close message' : 'Read message'}</button><button type="button" aria-expanded={actionItem === message.id} onClick={() => setActionItem(actionItem === message.id ? null : message.id)}>{actionItem === message.id ? 'Close actions' : 'Message actions'}</button>{message.direction === 'in' && <button type="button" disabled={creating} onClick={() => startDraft(message.accountId, message.id)}>Reply</button>}</div>
          {actionItem === message.id && <MailMessageActions key={`${message.id}:${message.accountId}:${scope.orbitId ?? ''}`} itemId={message.id} accountId={message.accountId} {...(scope.orbitId ? { orbitId: scope.orbitId } : {})} onRefreshMail={refresh} />}
          {openItem === message.id && <MailBody accountId={thread.accountId} itemId={message.id} {...(scope.orbitId ? { orbitId: scope.orbitId } : {})} />}
          {message.attachments.filter((attachment) => !attachment.related).length > 0 && <div className="mail-attachments"><h3>Attachments</h3>{message.attachments.filter((attachment) => !attachment.related).map((attachment) => <a key={attachment.id} href={`/api/mail/items/${message.id}/attachments/${attachment.id}/download?${new URLSearchParams({ accountId: thread.accountId, ...(scope.orbitId ? { orbitId: scope.orbitId } : {}) })}`}>{attachment.filename || 'Attachment'} ({Math.ceil(attachment.size / 1024)} KB)</a>)}</div>}
        </article>)}
        {messages.hasNextPage && <button type="button" disabled={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>Load more messages</button>}
      </div> : <div className="mail-list" ref={listRef} role="list" aria-label="Conversations">
        {conversations.isPending && <p role="status">Loading conversations…</p>}
        {conversations.isError && <p role="alert">{conversations.error.message} <button onClick={() => void conversations.refetch()}>Retry</button></p>}
        {conversations.isSuccess && rows.length === 0 && <div className="mail-empty"><h2>No conversations here</h2><p>Try another label or subject, or wait for mail to import.</p></div>}
        {rows.map((row, index) => <div role="listitem" key={`${row.accountId}:${row.threadId}`}><button type="button" className="mail-row" onFocus={() => setFocused(index)} onClick={() => void navigate({ to: '/mail/thread/$accountId/$threadId', params: { accountId: row.accountId, threadId: row.threadId }, search: Object.fromEntries(parameters(scope)) })}><span className="mail-row-title">{row.subject || '(No subject)'}</span><span className="mail-row-date">{displayDate(row.lastActivityAt)}</span><span className="mail-row-snippet">{row.snippet || 'No preview available'}</span><span className="mail-row-meta">{scope.orbitId ? context.data.accounts.find((account) => account.id === row.accountId)?.email : `${row.messageCount} ${row.messageCount === 1 ? 'message' : 'messages'}`}</span></button></div>)}
        {conversations.hasNextPage && <button type="button" className="mail-more" disabled={conversations.isFetchingNextPage} onClick={() => { focusAfterPage.current = rows.length; void conversations.fetchNextPage(); }}>Load more conversations</button>}
      </div>}</>}
    </>}
  </section>;
}
