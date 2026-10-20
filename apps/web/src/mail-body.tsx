import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import DOMPurify from 'dompurify';
import { imageConsentResponseSchema, readerBodySchema, MAIL_HTML_TAGS, MAIL_HTML_ATTRIBUTES, MAIL_HTML_LIMITS, safeMailLink } from '@station/shared';
import { csrfHeaders } from './auth-screen.js';
import rubikFontUrl from '@fontsource/rubik/files/rubik-latin-400-normal.woff2?url';

type Body = ReturnType<typeof readerBodySchema.parse>;
type Consent = ReturnType<typeof imageConsentResponseSchema.parse>;
type ImageMap = Record<string, string>;
type Scope = { accountId: string; itemId: string; orbitId?: string };
const BODY_CAP = 32 * 1024 * 1024;
const IMAGE_CAP = 2 * 1024 * 1024;
const AGGREGATE_CAP = 32 * 1024 * 1024;
const DEADLINE = 10_000;

async function bounded(response: Response, cap: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? '0') > cap) throw new Error('unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw new Error('limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function jsonRequest(path: string, schema: typeof readerBodySchema, signal: AbortSignal): Promise<Body>;
async function jsonRequest(path: string, schema: typeof imageConsentResponseSchema, signal: AbortSignal): Promise<Consent>;
async function jsonRequest(path: string, schema: typeof readerBodySchema | typeof imageConsentResponseSchema, signal: AbortSignal): Promise<Body | Consent> {
  const response = await fetch(path, { credentials: 'same-origin', signal });
  const bytes = await bounded(response, schema === readerBodySchema ? BODY_CAP : 32_768, signal);
  return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
function joinedSignal(parent: AbortSignal): { signal: AbortSignal; cancel: () => void } {
  const timeout = AbortSignal.timeout(DEADLINE);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) controller.abort();
  parent.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, cancel: () => { parent.removeEventListener('abort', abort); timeout.removeEventListener('abort', abort); controller.abort(); } };
}
function frameColor(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^[#a-zA-Z0-9.,%()\s+-]+$/.test(value) && CSS.supports('color', value) ? value : 'inherit';
}
function documentHtml(body: Body, consent: Consent, urls: ImageMap, fontData: string): string | null {
  if (!body.html || body.htmlPolicyVersion !== 1) return null;
  if (new TextEncoder().encode(body.html).byteLength > MAIL_HTML_LIMITS.outputBytes) return null;
  const known = new Map(consent.refs.map(({ refId, kind }) => [refId, kind]));
  if (known.size !== consent.refs.length || body.imageRefs.length !== known.size ||
    new Set(body.imageRefs).size !== known.size || body.imageRefs.some((id) => !known.has(id))) return null;
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const tokens = new Map<string, string>();
  const staged = body.html.replace(/<span data-station-image-ref="([a-f0-9]{32})">[^<]*<\/span>/g, (_whole, refId: string) => {
    const token = `STATION_IMAGE_${nonce}_${refId}`;
    if (!known.has(refId) || tokens.has(token)) return '';
    tokens.set(token, refId);
    return `<span>${token}</span>`;
  });
  if (tokens.size !== known.size) return null;
  // DOMPurify parses into its own inert document. The parent CSP forbids external resource loads even during parsing.
  const fragment = DOMPurify.sanitize(staged, {
    ALLOWED_TAGS: MAIL_HTML_TAGS.filter((tag) => tag !== 'img'),
    ALLOWED_ATTR: MAIL_HTML_ATTRIBUTES.filter((attribute) => attribute !== 'src'),
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, ALLOW_UNKNOWN_PROTOCOLS: false,
    RETURN_DOM_FRAGMENT: true,
  });
  const seen = new Set<string>();
  for (const element of Array.from(fragment.querySelectorAll('*'))) {
    const marker = element.localName === 'span' ? tokens.get(element.textContent ?? '') : undefined;
    if (marker) {
      if (seen.has(marker)) return null;
      seen.add(marker);
      const source = urls[marker];
      if (source) {
        const image = document.createElement('img');
        image.src = source;
        image.alt = 'Message image';
        element.replaceChildren(image);
      } else element.textContent = '[Image blocked]';
    }
    if (element.localName === 'a') {
      const href = element.getAttribute('href');
      const safe = href ? safeMailLink(href) : null;
      if (safe) { element.setAttribute('href', safe); element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noopener noreferrer'); }
      else element.removeAttribute('href');
    }
    if (element.localName === 'img') element.remove();
    element.removeAttribute('src');
  }
  if (seen.size !== known.size) return null;
  const holder = document.createElement('div');
  holder.append(fragment);
  const html = holder.innerHTML;
  // Opaque-origin frames cannot load blob URLs created by the parent. Embed only capped normalized PNG bytes.
  const dark = document.documentElement.dataset.theme === 'dark';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'"><style>${fontData ? `@font-face{font-family:MailRubik;src:url(${fontData}) format('woff2')}` : ''}html{color-scheme:${dark ? 'dark' : 'light'};background:${frameColor('--surface-container-lowest')};color:${frameColor('--on-surface')}}body{font:400 15px/1.6 MailRubik,Rubik,system-ui,sans-serif;margin:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%;overflow-wrap:anywhere}a{color:${frameColor('--primary')};text-decoration:underline}pre{white-space:pre-wrap}</style></head><body>${html}</body></html>`;
}
function pngDataUrl(bytes: Uint8Array): string {
  let encoded = '';
  for (let offset = 0; offset < bytes.length; offset += 32_766)
    encoded += btoa(String.fromCharCode(...bytes.subarray(offset, offset + 32_766)));
  return `data:image/png;base64,${encoded}`;
}

export function MailBody({ accountId, itemId, orbitId }: Scope) {
  const [body, setBody] = useState<Body | null>(null);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [urls, setUrls] = useState<ImageMap>({});
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fontData, setFontData] = useState('');
  const [themeTick, setThemeTick] = useState(0);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const current = useRef<AbortController | null>(null);
  const mutationControllers = useRef(new Set<AbortController>());
  const fontController = useRef<AbortController | null>(null);
  const generation = useRef(0);
  // Effect teardown is replayed by React StrictMode; only explicit logout is terminal.
  const loggedOut = useRef(false);
  const scopeKey = `${accountId}:${itemId}:${orbitId ?? ''}`;
  const query = new URLSearchParams({ accountId, ...(orbitId ? { orbitId } : {}) });
  const requestBody = `/api/mail/items/${encodeURIComponent(itemId)}/body?${query}`;
  const requestConsent = `/api/mail/items/${encodeURIComponent(itemId)}/images/consent?${query}`;
  const endpoint = (suffix: string) => `/api/mail/items/${encodeURIComponent(itemId)}/images/${suffix}`;
  const clearImages = () => setUrls({});
  useLayoutEffect(() => {
    const invalidate = () => {
      generation.current++;
      current.current?.abort();
      fontController.current?.abort();
      for (const controller of mutationControllers.current) controller.abort();
      mutationControllers.current.clear();
    };
    const stop = () => {
      if (loggedOut.current) return;
      loggedOut.current = true;
      invalidate();
      flushSync(() => {
        setBody(null); setConsent(null); setUrls({}); setFontData(''); setError('');
        setBusy(false); setLoadedScope(null); setSignedOut(true);
      });
    };
    window.addEventListener('station:logout', stop);
    return () => { window.removeEventListener('station:logout', stop); invalidate(); };
  }, []);
  useEffect(() => {
    const observer = new MutationObserver(() => { if (!loggedOut.current) setThemeTick((old) => old + 1); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    const controller = new AbortController();
    fontController.current = controller;
    void (async () => {
      let timeout: ReturnType<typeof joinedSignal> | undefined;
      try {
        timeout = joinedSignal(controller.signal);
        const response = await fetch(rubikFontUrl, { signal: timeout.signal });
        const bytes = await bounded(response, 32_768, timeout.signal);
        if (!controller.signal.aborted && !loggedOut.current) setFontData(`data:font/woff2;base64,${btoa(String.fromCharCode(...bytes))}`);
      } catch { /* The system sans font remains readable if the local asset fails. */ }
      finally { timeout?.cancel(); }
    })();
    return () => { observer.disconnect(); controller.abort(); if (fontController.current === controller) fontController.current = null; };
  }, []);
  useLayoutEffect(() => {
    if (loggedOut.current) return;
    const sequence = ++generation.current;
    const controller = new AbortController();
    current.current = controller;
    let live = true;
    setState('loading'); setBody(null); setConsent(null); setError(''); setBusy(false); setExpanded(false); setLoadedScope(null); clearImages();
    const run = async () => {
      try {
        const deadline = joinedSignal(controller.signal);
        let nextBody: Body, nextConsent: Consent;
        try {
          [nextBody, nextConsent] = await Promise.all([
            jsonRequest(requestBody, readerBodySchema, deadline.signal),
            jsonRequest(requestConsent, imageConsentResponseSchema, deadline.signal),
          ]);
        } finally { deadline.cancel(); }
        if (!live || controller.signal.aborted || loggedOut.current || sequence !== generation.current) return;
        setBody(nextBody); setConsent(nextConsent); setLoadedScope(scopeKey); setState('ready');
        if (nextBody.status !== 'available') return;
        const allowed = nextConsent.refs.filter(({ kind }) => kind === 'cid' || nextConsent.effectiveRemoteEnabled);
        const jobs = allowed.slice(0, 64);
        let next = 0, total = 0, exhausted = false;
        async function worker() {
          while (next < jobs.length && !controller.signal.aborted && !exhausted) {
            const ref = jobs[next++];
            if (!ref) break;
            const timeout = joinedSignal(controller.signal);
            try {
              const response = await fetch(endpoint('fetch'), { method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
                body: JSON.stringify({ accountId, ...(orbitId ? { orbitId } : {}), refId: ref.refId }), signal: timeout.signal });
              if (response.headers.get('content-type') !== 'image/png') throw new Error('format');
              const bytes = await bounded(response, IMAGE_CAP, timeout.signal);
              if (bytes.length < 8 || ![137,80,78,71,13,10,26,10].every((byte, index) => bytes[index] === byte)) throw new Error('format');
              total += bytes.length;
              if (total > AGGREGATE_CAP) { exhausted = true; throw new Error('limit'); }
              if (!live || controller.signal.aborted || loggedOut.current || sequence !== generation.current) break;
              const url = pngDataUrl(bytes);
              setUrls((old) => ({ ...old, [ref.refId]: url }));
            } catch { /* An image can fail while the rest of the message remains readable. */ }
            finally { timeout.cancel(); }
          }
        }
        await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
      } catch { if (live && !controller.signal.aborted && !loggedOut.current && sequence === generation.current) { setLoadedScope(scopeKey); setState('error'); } }
    };
    void run();
    return () => {
      live = false; generation.current++; controller.abort();
      for (const mutation of mutationControllers.current) mutation.abort();
      mutationControllers.current.clear();
      if (!loggedOut.current) clearImages();
      if (current.current === controller) current.current = null;
    };
  }, [accountId, itemId, orbitId, revision]);
  const srcdoc = useMemo(() => body && consent ? documentHtml(body, consent, urls, fontData) : null, [body, consent, urls, fontData, themeTick]);
  async function choice(suffix: 'consent' | 'sender-preference', enabled: boolean) {
    if (loggedOut.current) return;
    const sequence = generation.current;
    setBusy(true); setError(''); current.current?.abort(); clearImages();
    const controller = new AbortController();
    mutationControllers.current.add(controller);
    let timeout: ReturnType<typeof joinedSignal> | undefined;
    try {
      timeout = joinedSignal(controller.signal);
      const response = await fetch(endpoint(suffix), { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
        body: JSON.stringify({ accountId, ...(orbitId ? { orbitId } : {}), enabled }), signal: timeout.signal });
      await bounded(response, 2048, timeout.signal);
      if (!loggedOut.current && sequence === generation.current) setRevision((old) => old + 1);
    } catch {
      if (!loggedOut.current && sequence === generation.current) { setError('Image setting could not be saved. Try again.'); setRevision((old) => old + 1); }
    } finally {
      timeout?.cancel(); mutationControllers.current.delete(controller);
      if (!loggedOut.current && sequence === generation.current) setBusy(false);
    }
  }
  if (signedOut) return null;
  if (loadedScope !== scopeKey && state !== 'loading') return <section className="mail-body"><p>Loading message…</p></section>;
  if (state === 'loading') return <section className="mail-body"><p>Loading message…</p></section>;
  if (state === 'error') return <section className="mail-body"><p>Message is unavailable. Try again.</p><button onClick={() => setRevision((old) => old + 1)}>Retry</button></section>;
  if (!body || !consent) return null;
  if (body.status === 'unsupported') return <section className="mail-body"><p>This message format is unsupported.</p></section>;
  if (body.status === 'unavailable') return <section className="mail-body"><p>This message is unavailable. Try again later.</p><button onClick={() => setRevision((old) => old + 1)}>Retry</button></section>;
  const remoteCount = consent.refs.filter(({ kind }) => kind === 'remote').length;
  return <section className="mail-body" aria-label="Message body">
    {remoteCount > 0 && <div className="mail-body-controls">
      <p>Remote images can tell the sender when you open this message. The image proxy hides your IP address but does not prevent tracking.</p>
      <button disabled={busy} onClick={() => void choice('consent', !consent.effectiveRemoteEnabled)}>{consent.effectiveRemoteEnabled ? 'Block images in this message' : 'Load images in this message'}</button>
      <button disabled={busy || !consent.senderAddress} onClick={() => void choice('sender-preference', !consent.senderEnabled)}>{consent.senderEnabled ? 'Stop loading images from this sender' : 'Always load images from this sender'}</button>
      {consent.senderAddress && <small>Claimed sender: {consent.senderAddress}</small>}
    </div>}
    {error && <p role="alert">{error}</p>}
    {srcdoc ? <><iframe title="Message content" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={srcdoc} className={expanded ? 'mail-body-frame expanded' : 'mail-body-frame'} />
      <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</button></>
      : body.text ? <pre className="mail-body-text">{body.text}</pre> : <p>No message content is available.</p>}
  </section>;
}
