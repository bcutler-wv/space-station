import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { mailActionOptionsSchema, mailChangeDiscoveryPageSchema, mailChangeOperationSchema } from '@station/shared';
import { csrfHeaders } from './auth-screen.js';
import { MailHttpError, mailRequest } from './mail-compose.js';

type Options = z.infer<typeof mailActionOptionsSchema>;
type Operation = z.infer<typeof mailChangeOperationSchema>;
type DiscoveryOperation = z.infer<typeof mailChangeDiscoveryPageSchema>['operations'][number];
type Action = Operation['action'];
type Scope = { itemId: string; accountId: string; orbitId?: string };
type Intent = { key: string; action: Action; labelId?: string; itemSequence: number; itemRevision: string | null };
const query = ({ accountId, orbitId }: Scope) => new URLSearchParams({ accountId, ...(orbitId ? { orbitId } : {}) }).toString();
const statusQuery = (accountId: string, orbitId: string | null) => new URLSearchParams({ accountId, ...(orbitId ? { orbitId } : {}) }).toString();
const terminal = (value: Operation | null) => value?.state === 'succeeded' || value?.state === 'failed';
const actionable = (value: Options | null) => Boolean(value && !value.blocked);
const successCopy = (value: Operation) => value.confirmation === 'observed' ?
  'Gmail currently shows the requested state. Refresh mail after sync updates its local labels and read state.' :
  'Change confirmed. Gmail reported the requested state. Refresh mail after sync updates its local labels and read state.';
const actionName = (action: Action) => ({ archive: 'Archive', mark_read: 'Mark read', mark_unread: 'Mark unread',
  add_label: 'Add label', remove_label: 'Remove label' })[action];

export function MailMessageActions({ itemId, accountId, orbitId, onRefreshMail }: Scope & { onRefreshMail: () => void }) {
  const scope = { itemId, accountId, ...(orbitId ? { orbitId } : {}) };
  const [options, setOptions] = useState<Options | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const operationRef = useRef<Operation | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [transportUnknown, setTransportUnknown] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const current = (value: number) => generation.current === value && !controller.current?.signal.aborted;
  useEffect(() => {
    const stop = () => { generation.current++; controller.current?.abort(); setOptions(null); operationRef.current = null; setOperation(null); setIntent(null); };
    window.addEventListener('station:logout', stop);
    return () => { stop(); busyRef.current = false; window.removeEventListener('station:logout', stop); };
  }, []);
  const start = () => {
    if (busyRef.current) return null;
    busyRef.current = true; setBusy(true); setError('');
    controller.current?.abort(); controller.current = new AbortController();
    return { value: ++generation.current, signal: controller.current.signal };
  };
  const finish = (value: number) => { if (current(value)) { busyRef.current = false; setBusy(false); } };
  const apply = (next: Operation, value: number) => {
    if (!current(value)) return;
    const prior = operationRef.current;
    const accepted = prior?.id === next.id && terminal(prior) && !terminal(next) ? prior : next;
    operationRef.current = accepted; setOperation(accepted); setTransportUnknown(false);
  };
  const loadOptions = async () => {
    const task = start(); if (!task) return;
    setOptions(null);
    try {
      const next = await mailRequest(`/api/mail/items/${itemId}/action-options?${query(scope)}`, mailActionOptionsSchema, {}, task.signal, 128 * 1024);
      if (!current(task.value)) return;
      if (next.itemId !== itemId || next.accountId !== accountId || next.orbitId !== (orbitId ?? null))
        throw new Error('The action options did not match this message. Reload mail.');
      if (next.blockingOperationId) {
        const blocked = await mailRequest(`/api/mail/changes/${next.blockingOperationId}?${statusQuery(accountId, next.blockingOrbitId)}`, mailChangeOperationSchema, {}, task.signal);
        if (blocked.itemId !== itemId || blocked.accountId !== accountId || blocked.orbitId !== next.blockingOrbitId) throw new Error('The pending action belongs to another message. Reload mail.');
        if (!current(task.value)) return;
        const oldPending = operationRef.current?.id === blocked.id && terminal(operationRef.current) && !terminal(blocked);
        setOptions(oldPending ? null : next);
        apply(blocked, task.value);
      } else if (!next.blocked && (!intent || terminal(operation))) {
        setOptions(next); operationRef.current = null; setOperation(null); setTransportUnknown(false); setIntent(null);
      } else {
        setOptions(next);
      }
      setRejected(false);
    } catch (issue) { if (current(task.value)) setError((issue as Error).message); }
    finally { finish(task.value); }
  };
  useEffect(() => { void loadOptions(); }, []);
  const doAction = async (action: Action, labelId?: string) => {
    if (busyRef.current || transportUnknown || rejected || operation && !terminal(operation) || !actionable(options)) return;
    const snapshot = options!;
    const chosen: Intent = { key: crypto.randomUUID(), action, ...(labelId ? { labelId } : {}), itemSequence: snapshot.itemSequence, itemRevision: snapshot.itemRevision };
    const task = start(); if (!task) return;
    setIntent(chosen); setOptions(null); operationRef.current = null; setOperation(null);
    try {
      const body = { idempotencyKey: chosen.key, action: chosen.action, ...(chosen.labelId ? { labelId: chosen.labelId } : {}), itemSequence: chosen.itemSequence, itemRevision: chosen.itemRevision };
      const next = await mailRequest(`/api/mail/items/${itemId}/change?${query(scope)}`, mailChangeOperationSchema,
        { method: 'POST', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(body) }, task.signal);
      apply(next, task.value);
    } catch (issue) {
      if (current(task.value)) {
        const parsed = issue instanceof MailHttpError ? mailChangeOperationSchema.safeParse(issue.payload) : null;
        if (parsed?.success) { apply(parsed.data, task.value); setError(''); }
        else if (issue instanceof MailHttpError && [400, 403, 404, 409].includes(issue.status)) {
          setIntent(null); setRejected(true); setTransportUnknown(false);
          setError(`${issue.message} Refresh options before choosing another action.`);
        } else { setTransportUnknown(true); setError(`${(issue as Error).message} The change may have happened. Check status before another action.`); }
      }
    } finally { finish(task.value); }
  };
  const check = async (reconcile = false) => {
    const task = start(); if (!task) return;
    try {
      let next: Operation;
      if (operation) {
        const path = `/api/mail/changes/${operation.id}${reconcile ? '/reconcile' : ''}?${statusQuery(operation.accountId, operation.orbitId)}`;
        next = await mailRequest(path, mailChangeOperationSchema, reconcile ? { method: 'POST', headers: csrfHeaders() } : {}, task.signal);
      } else if (intent) {
        next = await mailRequest(`/api/mail/items/${itemId}/change?${query(scope)}&idempotencyKey=${intent.key}`, mailChangeOperationSchema, {}, task.signal);
      } else throw new Error('Reload action options to find this change.');
      if (next.itemId !== itemId || next.accountId !== accountId) throw new Error('The action belongs to another message. Reload mail.');
      apply(next, task.value);
      setError('');
    } catch (issue) { if (current(task.value)) setError(`${(issue as Error).message} Check again later. No change was sent again.`); }
    finally { finish(task.value); }
  };
  const unresolved = transportUnknown || operation?.state === 'outcome_unknown';
  const displayOptions = operation && terminal(operation) && options?.blockingOperationId === operation.id &&
    options.blockedReason === 'operation_pending' ? null : options;
  const blocked = busy || transportUnknown || rejected || Boolean(operation && operation.state !== 'failed') || !actionable(options);
  return <section className="mail-action-panel" aria-label="Message actions">
    <div className="mail-action-head"><strong>Message actions</strong><button type="button" disabled={busy} onClick={() => void loadOptions()}>Refresh options</button></div>
    {busy && <p role="status">Checking message action…</p>}
    {displayOptions && <p className="mail-action-note">{displayOptions.message}</p>}
    {displayOptions?.labelsIncomplete && <p className="mail-action-note">Some Gmail labels are not available here yet. Check again after mail sync.</p>}
    {displayOptions?.blockedReason === 'draft' && <p>Gmail identifies this as a draft. Message actions are unavailable.</p>}
    {displayOptions?.blockedReason === 'awaiting_sync' && !operation && <p role="status">The change is waiting for mail sync. Refresh mail after it updates.</p>}
    {operation && <p role="status">{operation.state === 'succeeded' ? successCopy(operation) : operation.state === 'failed' ? 'Change failed. Refresh options before trying a new action.' : operation.state === 'outcome_unknown' ? 'The result is uncertain. Check Gmail, then check the desired state here.' : 'Change pending. Check status before taking another action.'}</p>}
    {unresolved && <p className="mail-action-note">If the state still differs, change this message in Gmail and check the desired state again here. An unresolved result continues to block new actions.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="mail-action-buttons">
      <button type="button" disabled={blocked || !options?.canArchive} onClick={() => void doAction('archive')}>Archive this message</button>
      <button type="button" disabled={blocked || !options?.canMarkRead} onClick={() => void doAction('mark_read')}>Mark read</button>
      <button type="button" disabled={blocked || !options?.canMarkUnread} onClick={() => void doAction('mark_unread')}>Mark unread</button>
      {operation || intent ? <button type="button" disabled={busy} onClick={() => void check()}>Check status</button> : null}
      {operation && !terminal(operation) && <button type="button" disabled={busy} onClick={() => void check(true)}>Check desired state</button>}
      <button type="button" disabled={busy} onClick={onRefreshMail}>Refresh mail</button>
    </div>
    {options && options.labels.length > 0 && <div className="mail-action-labels"><h3>Existing Gmail labels</h3>{options.labels.map((label) => <div className="mail-action-label" key={label.id}><span title={label.name}>{label.name}</span><button type="button" disabled={blocked || !label.canAdd} aria-label={`Add ${label.name}`} onClick={() => void doAction('add_label', label.id)}>Add</button><button type="button" disabled={blocked || !label.canRemove} aria-label={`Remove ${label.name}`} onClick={() => void doAction('remove_label', label.id)}>Remove</button></div>)}</div>}
  </section>;
}

type AccountChoice = { id: string; email: string; orbitId: string };
export function PendingMessageChanges({ accounts, orbitId }: { accounts: AccountChoice[]; orbitId?: string }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [onlyOrbit, setOnlyOrbit] = useState(false);
  const [rows, setRows] = useState<DiscoveryOperation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const selected = accounts.some((entry) => entry.id === accountId) ? accountId : accounts[0]?.id ?? '';
  const selectedOrbit = onlyOrbit ? orbitId : undefined;
  const reset = () => { generation.current++; controller.current?.abort(); controller.current = null; busyRef.current = false;
    setRows([]); setCursor(null); setLoaded(false); setBusy(false); setError(''); };
  useEffect(() => {
    reset();
  }, [selected, selectedOrbit]);
  useEffect(() => {
    const stop = () => { generation.current++; controller.current?.abort(); controller.current = null; busyRef.current = false; setRows([]); };
    window.addEventListener('station:logout', stop);
    return () => { stop(); window.removeEventListener('station:logout', stop); };
  }, []);
  const begin = () => {
    if (busyRef.current || !selected) return null;
    busyRef.current = true; setBusy(true); setError('');
    controller.current?.abort(); controller.current = new AbortController();
    return { generation: ++generation.current, signal: controller.current.signal };
  };
  const live = (task: { generation: number; signal: AbortSignal }) => generation.current === task.generation && !task.signal.aborted;
  const end = (task: { generation: number; signal: AbortSignal }) => { if (live(task)) { busyRef.current = false; setBusy(false); } };
  const load = async (more = false) => {
    const task = begin(); if (!task) return;
    try {
      const scope = new URLSearchParams({ accountId: selected, ...(selectedOrbit ? { orbitId: selectedOrbit } : {}), limit: '20', ...(more && cursor ? { cursor } : {}) });
      const page = await mailRequest(`/api/mail/changes/unresolved?${scope}`, mailChangeDiscoveryPageSchema, {}, task.signal);
      if (live(task)) { setRows((prior) => more ? [...prior, ...page.operations] : page.operations); setCursor(page.nextCursor); setLoaded(true); }
    } catch (issue) { if (live(task)) setError((issue as Error).message); }
    finally { end(task); }
  };
  const review = async (entry: DiscoveryOperation, reconcile: boolean) => {
    const task = begin(); if (!task) return;
    try {
      const path = `/api/mail/changes/${entry.id}${reconcile ? '/reconcile' : ''}?${statusQuery(entry.accountId, entry.orbitId)}`;
      const next = await mailRequest(path, mailChangeOperationSchema, reconcile ? { method: 'POST', headers: csrfHeaders() } : {}, task.signal);
      if (next.id !== entry.id || next.itemId !== entry.itemId || next.accountId !== entry.accountId || next.orbitId !== entry.orbitId)
        throw new Error('The change status did not match this message. Refresh the list.');
      if (live(task)) setRows((prior) => prior.map((value) => value.id === next.id && !(terminal(value) && !terminal(next)) ?
        { ...next, context: value.context } : value));
    } catch (issue) { if (live(task)) setError((issue as Error).message); }
    finally { end(task); }
  };
  return <section className="mail-draft-overview" aria-label="Pending message changes">
    <div className="mail-draft-overview-head"><h2>Pending message changes</h2><button type="button" disabled={busy || !selected} onClick={() => void load()}>Refresh</button></div>
    <p>Review uncertain changes before acting on the same message again.</p>
    <div className="mail-pending-filters"><label>Account<select aria-label="Change account" value={selected} onChange={(event) => { reset(); setAccountId(event.target.value); }}>{accounts.map((entry) => <option key={entry.id} value={entry.id}>{entry.email}</option>)}</select></label>
      {orbitId && <label><input type="checkbox" checked={onlyOrbit} onChange={(event) => { reset(); setOnlyOrbit(event.target.checked); }} />Only this Orbit</label>}</div>
    {error && <p role="alert">{error} Try refreshing this list.</p>}
    {busy && <p role="status">Checking pending changes…</p>}
    {loaded && rows.length === 0 && <p>No pending changes in this scope.</p>}
    {rows.map((entry) => <div className="mail-pending-row" key={entry.id}><p><strong>{actionName(entry.action)}</strong> · Updated {new Date(entry.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {accounts.find((account) => account.id === entry.accountId)?.email ?? 'This account'}</p>
      {entry.context ? <p><a href={`/mail/thread/${entry.accountId}/${entry.context.threadId}?${new URLSearchParams(entry.orbitId ? { orbitId: entry.orbitId } : { accountId: entry.accountId })}`}>{entry.context.subject || '(No subject)'}</a></p> : <p>The message is no longer available here. Review it in Gmail using this account.</p>}
      <p>{entry.state === 'outcome_unknown' ? 'Result uncertain. Check the desired state before another action.' : entry.state === 'succeeded' ? successCopy(entry) : entry.state === 'failed' ? 'Failed. Refresh message options before a new action.' : 'Still pending. Check status shortly.'}</p>
      <div><button type="button" disabled={busy} onClick={() => void review(entry, false)}>Check status</button>{!terminal(entry) && <button type="button" disabled={busy} onClick={() => void review(entry, true)}>Check desired state</button>}</div>
      {entry.state === 'outcome_unknown' && <p>Review this message in Gmail. If its state differs, change it there and check the desired state again. This unresolved change blocks new actions.</p>}</div>)}
    {cursor && <button type="button" disabled={busy} onClick={() => void load(true)}>Load more changes</button>}
  </section>;
}
