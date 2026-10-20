import { describe, expect, it } from 'vitest';
import { OAuth2Client, type OAuth2ClientOptions } from 'google-auth-library';
import { GoogleCredentialError, refreshGoogleGrant } from './credentials.js';

const input = { clientId: '123456-fixture.apps.googleusercontent.com', clientSecret: 'fixture-secret',
  redirectUri: 'https://example.com/api/google/callback', refreshToken: 'fixture-refresh' };
const transport = (fetchImplementation: NonNullable<NonNullable<OAuth2ClientOptions['transporterOptions']>['fetchImplementation']>) =>
  new OAuth2Client({ transporterOptions: { fetchImplementation } }).transporter;

function response(status: number, retryAfter?: string, error = 'temporarily_unavailable') {
  return new Response(JSON.stringify({ error }), { status,
    headers: { 'content-type': 'application/json', ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }) } });
}

describe('Google refresh with real Gaxios transport', () => {
  it('makes only two outer attempts when Gaxios receives 503', async () => {
    let requests = 0;
    const provider = transport(async () => { requests++; return response(503, '0'); });
    await expect(refreshGoogleGrant({ ...input, transport: provider })).rejects.toMatchObject({ code: 'transient' });
    expect(requests).toBe(2);
  });

  it.each([
    ['seconds', '60'],
    ['HTTP date', new Date(Date.now() + 60_000).toUTCString()],
  ])('returns a future Retry-After %s without an early second request', async (_name, hint) => {
    let requests = 0;
    const provider = transport(async () => { requests++; return response(503, hint); });
    const error = await refreshGoogleGrant({ ...input, transport: provider }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GoogleCredentialError);
    expect((error as GoogleCredentialError).code).toBe('transient');
    expect((error as GoogleCredentialError).retryAfterMs).toBeGreaterThan(50_000);
    expect(requests).toBe(1);
  });

  it('aborts the actual Gaxios request at the deadline', async () => {
    let requests = 0;
    let aborted = false;
    const provider = transport(async (_url, options) => {
      requests++;
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('private transport detail')); }, { once: true });
      });
    });
    await expect(refreshGoogleGrant({ ...input, transport: provider, requestTimeoutMs: 30 })).rejects.toMatchObject({ code: 'transient' });
    expect(requests).toBe(1);
    expect(aborted).toBe(true);
  });

  it('treats a rejected client secret as a reconnect requirement', async () => {
    let requests = 0;
    const provider = transport(async () => { requests++; return response(401, undefined, 'invalid_client'); });
    await expect(refreshGoogleGrant({ ...input, transport: provider })).rejects.toMatchObject({ code: 'needs_reconnect' });
    expect(requests).toBe(1);
  });
});
