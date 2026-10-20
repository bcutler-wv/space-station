import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PRODUCT_NAME, appearanceResponseSchema, privacyDefaultsSchema, setupStatusSchema, type ExclusionRule, type PrivacyDefaults, type SetupSubmit, type SetupStatus } from '@station/shared';
import { applyTheme } from '@station/theme';
import { csrfHeaders } from './auth-screen.js';

async function loadSetup(): Promise<SetupStatus> {
  const response = await fetch('/api/setup');
  if (!response.ok) throw new Error('Setup could not be loaded. Check the server connection.');
  return setupStatusSchema.parse(await response.json());
}
async function saveSetup(value: SetupSubmit): Promise<SetupStatus> {
  const response = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify(value) });
  if (!response.ok) {
    const body = await response.json() as { error?: string };
    throw new Error(body.error ?? 'Setup could not be saved. Try again.');
  }
  return setupStatusSchema.parse(await response.json());
}
async function reconfirmOrigin(origin: string): Promise<SetupStatus> {
  const response = await fetch('/api/setup/origin', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...csrfHeaders() }, body: JSON.stringify({ confirmedOrigin: origin }) });
  if (!response.ok) throw new Error('Address confirmation could not be saved. Try again.');
  return setupStatusSchema.parse(await response.json());
}
export function SetupScreen() {
  const queryClient = useQueryClient();
  const appearance = useQuery({ queryKey: ['appearance'], queryFn: async () => {
    const response = await fetch('/api/appearance');
    if (!response.ok) throw new Error('Appearance settings could not be loaded.');
    return appearanceResponseSchema.parse(await response.json());
  }, retry: false });
  useEffect(() => {
    if (!appearance.data) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(appearance.data!.seed, appearance.data!.mode === 'dark' || (appearance.data!.mode === 'system' && media.matches));
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [appearance.data]);
  const setup = useQuery({ queryKey: ['setup'], queryFn: loadSetup, retry: false });
  const [name, setName] = useState('');
  const [context, setContext] = useState('');
  const [colorSlot, setColorSlot] = useState(1);
  const [globalDefaults, setGlobalDefaults] = useState<Partial<PrivacyDefaults>>({});
  const [orbitDefaults, setOrbitDefaults] = useState<Partial<PrivacyDefaults>>({});
  const [rules, setRules] = useState<ExclusionRule[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const save = useMutation({ mutationFn: saveSetup, onSuccess: (value) => queryClient.setQueryData(['setup'], value) });
  const reconfirm = useMutation({ mutationFn: reconfirmOrigin, onSuccess: (value) => queryClient.setQueryData(['setup'], value) });
  const status = setup.data;
  const originMatches = status?.configuredOrigin === window.location.origin && window.location.protocol === 'https:';
  const setChoice = (scope: 'global' | 'orbit', field: 'index' | 'ai', value: PrivacyDefaults['index']) => {
    if (scope === 'global') setGlobalDefaults((current) => ({ ...current, [field]: value }));
    else setOrbitDefaults((current) => ({ ...current, [field]: value }));
  };
  return <main className="setup-page">
    <div className="setup-card">
      <h1>Set up your first Orbit</h1>
      {setup.isError && <p role="alert">Setup could not be loaded. Check the server connection and reload.</p>}
      {!status && !setup.isError && <p>Loading setup…</p>}
      {status?.completed ? <>
        <p>Your Orbit and privacy choices are saved.</p>
        <h2>{status.orbit?.name}</h2><p>{status.orbit?.context}</p>
        {status.confirmedOrigin === status.configuredOrigin && originMatches ? <p><Link className="button primary" to="/setup/google">Connect Google mail</Link></p> : <><p role="alert">The configured HTTPS address changed or this page is at another address. Open and confirm the configured address before connecting an account.</p><p>{status.configuredOrigin}</p><label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={!originMatches} /> I confirm this is the address I will use</label><button type="button" disabled={!confirmed || !originMatches || reconfirm.isPending} onClick={() => reconfirm.mutate(status.configuredOrigin)}>Confirm address</button>{reconfirm.isError && <p role="alert">{reconfirm.error.message}</p>}</>}
        <Link to="/">View sample Mission Control</Link>
      </> : status && <form onSubmit={(event) => {
        event.preventDefault();
        if (!originMatches || !confirmed) return;
        const global = privacyDefaultsSchema.safeParse(globalDefaults);
        const orbit = privacyDefaultsSchema.safeParse(orbitDefaults);
        if (!global.success || !orbit.success) return;
        save.mutate({ version: 1, confirmedOrigin: status.configuredOrigin, orbit: { name, context, colorSlot }, globalDefaults: global.data, orbitDefaults: orbit.data, exclusions: rules });
      }}>
        <section><h2>1. Check the address</h2>
          <p>{PRODUCT_NAME} is configured for <strong>{status.configuredOrigin}</strong>. Open that exact HTTPS address to connect accounts later.</p>
          {!originMatches && <p role="alert">This page is at a different address. Open the configured HTTPS address and reload.</p>}
          <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={!originMatches} /> I confirm this is the address I will use</label>
        </section>
        <section><h2>2. Create an Orbit</h2>
          <label>Orbit name <input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>What is this part of your work? <textarea required maxLength={500} value={context} onChange={(event) => setContext(event.target.value)} /></label>
          <fieldset><legend>Orbit color</legend>{[1,2,3,4].map((slot) => <label key={slot} className={`orbit-color-choice orbit-${slot}`}><input type="radio" name="orbit-color" checked={colorSlot === slot} onChange={() => setColorSlot(slot)} /> Color {slot}</label>)}</fieldset>
        </section>
        <section><h2>3. Choose privacy defaults</h2>
          <p>Rules apply before any content sync. If an item belongs to several Orbits, the most restrictive setting wins. Attachments follow their parent item.</p>
          {([['global', globalDefaults], ['orbit', orbitDefaults]] as const).map(([scope, defaults]) => <fieldset key={scope}><legend>{scope === 'global' ? 'Global' : 'First Orbit'}</legend>
            {(['index', 'ai'] as const).map((field) => <label key={field}>{field === 'index' ? 'Search indexing' : 'AI processing'}
              <select required value={defaults[field] ?? ''} onChange={(event) => setChoice(scope, field, event.target.value as PrivacyDefaults['index'])}>
                <option value="" disabled>Choose</option><option value="allow">Allow</option><option value="exclude">Exclude</option>
              </select></label>)}
          </fieldset>)}
          <h3>Exact-match exclusions</h3><p>Account and sender rules use full email addresses. Label rules match the whole label, ignoring case.</p>
          {rules.map((rule, index) => <div className="setup-rule" key={index}>
            <label>Scope <select value={rule.scope} onChange={(event) => setRules((current) => current.map((entry, i) => i === index ? { ...entry, scope: event.target.value as ExclusionRule['scope'] } : entry))}><option value="global">Global</option><option value="orbit">First Orbit</option></select></label>
            <label>Match <select value={rule.kind} onChange={(event) => setRules((current) => current.map((entry, i) => i === index ? { ...entry, kind: event.target.value as ExclusionRule['kind'] } : entry))}><option value="account">Account</option><option value="sender">Sender</option><option value="label">Label</option></select></label>
            <label>Value <input required maxLength={254} type={rule.kind === 'label' ? 'text' : 'email'} value={rule.value} onChange={(event) => setRules((current) => current.map((entry, i) => i === index ? { ...entry, value: event.target.value } : entry))} /></label>
            <label>Effect <select value={rule.effect} onChange={(event) => setRules((current) => current.map((entry, i) => i === index ? { ...entry, effect: event.target.value as ExclusionRule['effect'] } : entry))}><option value="no_ai_and_no_index">Exclude from search and AI</option><option value="no_index">Exclude from search</option><option value="no_ai">Exclude from AI</option></select></label>
            <button type="button" onClick={() => setRules((current) => current.filter((_, i) => i !== index))}>Remove rule</button>
          </div>)}
          <button type="button" disabled={rules.length >= 50} onClick={() => setRules((current) => [...current, { scope: 'global', kind: 'sender', value: '', effect: 'no_ai_and_no_index' }])}>Add exclusion</button>
        </section>
        {save.isError && <p role="alert">{save.error.message}</p>}
        <button className="button primary" type="submit" disabled={!originMatches || !confirmed || save.isPending}>{save.isPending ? 'Saving…' : 'Save Orbit and privacy choices'}</button>
        <p><Link to="/">View sample Mission Control</Link></p>
      </form>}
    </div>
  </main>;
}
