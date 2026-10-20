import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PRODUCT_NAME, appearanceResponseSchema, setupStatusSchema, googleStartSchema, googleStartResponseSchema, googleStatusSchema, googleOkSchema } from '@station/shared';
import { applyTheme, DEFAULT_SEED } from '@station/theme';
import { csrfHeaders } from './auth-screen.js';

const scope = 'https://www.googleapis.com/auth/gmail.modify';
type Status = ReturnType<typeof googleStatusSchema.parse>;
type Account = Status['accounts'][number];
const message = async (response: Response, fallback: string) => {
  if (response.ok) return;
  const body = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(body.error ?? fallback);
};
async function loadStatus(): Promise<Status> {
  const response = await fetch('/api/google/status', { cache: 'no-store' });
  await message(response, 'Connection status could not be loaded. Reload and try again.');
  return googleStatusSchema.parse(await response.json());
}
async function start(value: { clientId: string; clientSecret: string }) {
  const response = await fetch('/api/google/start', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(value) });
  await message(response, 'Google connection could not start. Check your client details and try again.');
  return googleStartResponseSchema.parse(await response.json());
}
async function confirm() {
  const response = await fetch('/api/google/confirm', { method: 'POST', cache: 'no-store', headers: csrfHeaders() });
  await message(response, 'Google connection could not be completed. Start again.');
  return googleOkSchema.parse(await response.json());
}
async function chooseBackfill(value: { accountId: string; window: '30_days' | '1_year' | 'all' }) {
  const response = await fetch('/api/google/backfill', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(value) });
  await message(response, 'Backfill choice could not be saved. Reload and try again.');
  return googleOkSchema.parse(await response.json());
}
function CopyValue({ label, value }: { label: string; value: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);
  return <div className="google-copy"><label>{label}<input ref={inputRef} readOnly value={value} onFocus={(event) => event.currentTarget.select()} /></label><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopyState('copied'); } catch { inputRef.current?.focus(); inputRef.current?.select(); setCopyState('manual'); } }} aria-label={`Copy ${label}`}>Copy</button><span role="status">{copyState === 'copied' ? 'Copied' : copyState === 'manual' ? 'Value selected. Copy it with your keyboard.' : ''}</span></div>;
}
function AccountCard({ account, orbitName, onSaved }: { account: Account; orbitName: string | undefined; onSaved: () => void }) {
  const [window, setWindow] = useState<'30_days' | '1_year' | 'all' | ''>('');
  const save = useMutation({ mutationFn: chooseBackfill, onSuccess: onSaved });
  return <section className="google-account"><h2>{account.email}</h2>
    <p>{account.status === 'needs_reconnect' ? 'This account needs to reconnect.' : 'Google mail access connected.'}</p>
    <p>Orbit: {orbitName ?? 'First Orbit'}. Gmail mail access is authorized.</p>
    {account.backfill ? <p>Backfill choice: {account.backfill === '30_days' ? '30 days' : account.backfill === '1_year' ? '1 year' : 'All mail'}. Mail sync is pending implementation.</p> : <>
      <p>Choose how far back to import mail. Older windows may take more time and storage; an estimate is not available yet. Mail sync is pending implementation.</p>
      <fieldset><legend>Backfill window</legend>{([['30_days', '30 days'], ['1_year', '1 year'], ['all', 'All mail']] as const).map(([value, label]) => <label key={value}><input type="radio" name={`backfill-${account.id}`} checked={window === value} onChange={() => setWindow(value)} /> {label}</label>)}</fieldset>
      <button className="button primary" type="button" disabled={!window || save.isPending || account.status === 'needs_reconnect'} onClick={() => { if (window) save.mutate({ accountId: account.id, window }); }}>Save backfill choice</button>
      {save.isError && <p role="alert">{save.error.message}</p>}
    </>}
  </section>;
}
const media = window.matchMedia('(prefers-color-scheme: dark)');
const subscribeDark = (onChange: () => void) => { media.addEventListener('change', onChange); return () => media.removeEventListener('change', onChange); };
function GoogleLayout({ children }: { children: ReactNode }) {
  const systemDark = useSyncExternalStore(subscribeDark, () => media.matches);
  const appearance = useQuery({ queryKey: ['appearance'], queryFn: async () => {
    const response = await fetch('/api/appearance');
    await message(response, 'Appearance could not be loaded.');
    return appearanceResponseSchema.parse(await response.json());
  }, retry: false });
  useEffect(() => { applyTheme(appearance.data?.seed ?? DEFAULT_SEED, appearance.data?.mode === 'dark' || (appearance.data?.mode !== 'light' && systemDark)); }, [appearance.data, systemDark]);
  return <main className="setup-page"><div className="setup-card"><p><Link to="/setup">← First Orbit setup</Link></p>{children}</div></main>;
}
export function GoogleScreen() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['google-status'], queryFn: loadStatus, retry: false });
  const setup = useQuery({ queryKey: ['setup'], queryFn: async () => {
    const response = await fetch('/api/setup');
    await message(response, 'Orbit setup could not be loaded.');
    return setupStatusSchema.parse(await response.json());
  }, retry: false });
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const clientIdRef = useRef<HTMLInputElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const clear = () => { setClientSecret(''); if (secretRef.current) secretRef.current.value = ''; };
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      clear();
      setStarting(false);
    };
    window.addEventListener('pagehide', clear);
    window.addEventListener('pageshow', restore);
    return () => { window.removeEventListener('pagehide', clear); window.removeEventListener('pageshow', restore); };
  }, []);
  const begin = async () => {
    const parsed = googleStartSchema.safeParse({ clientId, clientSecret });
    if (!parsed.success) {
      setStartError('Enter a valid Google web client ID and a client secret of 8 to 2048 characters.');
      if (!googleStartSchema.shape.clientId.safeParse(clientId).success) clientIdRef.current?.focus();
      else secretRef.current?.focus();
      return;
    }
    setStarting(true); setStartError('');
    try {
      const { authorizationUrl } = await start(parsed.data);
      setClientSecret(''); if (secretRef.current) secretRef.current.value = '';
      window.location.assign(authorizationUrl);
    } catch (error) {
      setClientSecret(''); if (secretRef.current) secretRef.current.value = '';
      setStartError(error instanceof Error ? error.message : 'Connection could not start. Try again.');
      setStarting(false);
    }
  };
  return <GoogleLayout><h1>Connect Google mail</h1>
    {status.isPending && <p>Loading connection status…</p>}
    {status.isError && <p role="alert">{status.error.message} <Link to="/setup">Check your Orbit and address</Link>.</p>}
    {status.data && <>
      {status.data.accounts.map((account) => <AccountCard key={account.id} account={account} orbitName={setup.data?.orbit?.id === account.orbitId ? setup.data.orbit.name : undefined} onSaved={() => { void queryClient.invalidateQueries({ queryKey: ['google-status'] }); }} />)}
      <section><h2>Set up a Google web client</h2><p>Use your own Google Cloud project. {PRODUCT_NAME} asks for Gmail mail access only; Calendar permission comes later. Never enter your Google account password here.</p>
        <ol>
          <li>Create or select a project in <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">Google Cloud</a>.</li>
          <li><a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer">Enable the Gmail API</a> in that project.</li>
          <li>Configure the <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener noreferrer">Google Auth Platform</a>: branding, audience, and data access. Choose Internal only for eligible Workspace users; otherwise use External and add your account as a test user while testing. External Testing refresh grants generally expire after seven days. Internal and personal-use verification exceptions may apply, but restricted Gmail scope verification or other requirements depend on your audience and Google's current policy. <a href="https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification" target="_blank" rel="noopener noreferrer">Read Google's verification guidance</a>.</li>
          <li>Create an OAuth client of type <strong>Web application</strong> in <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noopener noreferrer">Google Auth Platform clients</a>. Add the exact authorized redirect URI below.</li>
          <li>Add the Gmail permission below under Data Access, then paste the client's ID and secret here. <a href="https://developers.google.com/identity/protocols/oauth2/web-server" target="_blank" rel="noopener noreferrer">Google's web-server instructions</a> explain these steps.</li>
        </ol>
        <CopyValue label="Authorized redirect URI" value={status.data.redirectUri} />
        <CopyValue label="Gmail scope" value={scope} />
        <form noValidate onSubmit={(event) => { event.preventDefault(); void begin(); }}>
          <label>Web client ID<input ref={clientIdRef} required maxLength={512} autoComplete="off" value={clientId} onChange={(event) => setClientId(event.target.value)} pattern="[0-9]+-[a-z0-9_-]+\.apps\.googleusercontent\.com" /></label>
          <label>Web client secret<input ref={secretRef} required type="password" minLength={8} maxLength={2048} autoComplete="off" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} /></label>
          <button className="button primary" disabled={starting} type="submit">{starting ? 'Opening Google…' : 'Continue to Google'}</button>
          {startError && <p role="alert">{startError} Re-enter the client secret to try again.</p>}
        </form>
        <p>If the {PRODUCT_NAME} master key is lost, you must reconnect each account.</p>
      </section>
    </>}
  </GoogleLayout>;
}
export function GoogleContinuationScreen() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['google-status'], queryFn: loadStatus, retry: false });
  const finish = useMutation({ mutationFn: confirm, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['google-status'] }); } });
  useEffect(() => { if (status.data?.pendingConfirmation) document.getElementById('google-confirm')?.focus(); }, [status.data?.pendingConfirmation]);
  return <GoogleLayout><h1>Finish Google connection</h1>
    {status.isPending && <p>Checking your return…</p>}
    {status.isError && <p role="alert">{status.error.message} Sign in with the browser that started the connection, or return to setup.</p>}
    {finish.isSuccess ? <p role="status">Account connected. <Link to="/setup/google">Choose a backfill window</Link>.</p> : status.data && (status.data.pendingConfirmation ? <>
      <p>Google returned to {PRODUCT_NAME}. Confirm this connection to link the account to your first Orbit. This request uses your signed-in session.</p>
      <button id="google-confirm" className="button primary" disabled={finish.isPending || finish.isError} onClick={() => finish.mutate()}>Confirm Google connection</button>
      {finish.isError && <p role="alert">{finish.error.message} <Link to="/setup/google">Start a new connection</Link>.</p>}
    </> : <p role="alert">No pending Google return was found. It may have been cancelled, expired, already used, or opened in a different browser. <Link to="/setup/google">Start a new connection</Link> in this browser.</p>)}
  </GoogleLayout>;
}
