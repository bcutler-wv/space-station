import { describe, expect, it } from 'vitest';
import { GMAIL_MODIFY_SCOPE, GoogleMailAuthorization, type GoogleTransport } from './index.js';

const clientId = '123456-test.apps.googleusercontent.com';
const redirect = 'https://example.com/api/google/callback';

describe('Google SDK transport fixture', () => {
  it('builds S256 authorization and exchanges a mail grant for Gmail profile', async () => {
    const requests: { method?: string; url?: string; data?: URLSearchParams }[] = [];
    const transport = { interceptors: { request: { add() {} }, response: { add() {} } }, request: async (options: { method?: string; url?: string; data?: URLSearchParams }) => {
      requests.push(options);
      if (options.url?.includes('/token')) return { data: {
        access_token: 'fixture-access', refresh_token: 'fixture-refresh', scope: GMAIL_MODIFY_SCOPE,
        token_type: 'Bearer', expires_in: 3600,
      } };
      if (options.url?.includes('/profile')) return { data: { emailAddress: 'owner@example.com' } };
      throw new Error(`Unexpected fixture URL: ${options.url}`);
    } } as unknown as NonNullable<GoogleTransport>;
    const provider = new GoogleMailAuthorization(clientId, 'fixture-secret', redirect, transport);
    const { url, codeVerifier } = await provider.authorization('state-fixture');
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://accounts.google.com');
    expect(parsed.searchParams.get('redirect_uri')).toBe(redirect);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')).toBe(GMAIL_MODIFY_SCOPE);
    const result = await provider.exchange('fixture-code', codeVerifier);
    expect(result.email).toBe('owner@example.com');
    expect(result.refreshToken).toBe('fixture-refresh');
    expect(requests[0]?.data?.get('code_verifier')).toBe(codeVerifier);
  });

  it.each(['missing_scope', 'missing_refresh', 'token_error', 'profile_error'])('fails closed on %s', async (mode) => {
    const transport = { interceptors: { request: { add() {} }, response: { add() {} } }, request: async (options: { url?: string }) => {
      if (options.url?.includes('/token')) {
        if (mode === 'token_error') throw new Error('provider raw error fixture');
        return { data: { access_token: 'fixture-access',
          ...(mode === 'missing_refresh' ? {} : { refresh_token: 'fixture-refresh' }),
          scope: mode === 'missing_scope' ? 'https://www.googleapis.com/auth/gmail.readonly' : GMAIL_MODIFY_SCOPE,
          token_type: 'Bearer', expires_in: 3600 } };
      }
      if (mode === 'profile_error') throw new Error('provider raw profile fixture');
      return { data: { emailAddress: 'owner@example.com' } };
    } } as unknown as NonNullable<GoogleTransport>;
    const provider = new GoogleMailAuthorization(clientId, 'fixture-secret', redirect, transport);
    const { codeVerifier } = await provider.authorization('fixture-state');
    if (mode.startsWith('missing_')) await expect(provider.exchange('fixture-code', codeVerifier)).rejects.toThrow('GOOGLE_CONSENT_INCOMPLETE');
    else await expect(provider.exchange('fixture-code', codeVerifier)).rejects.toThrow('provider raw');
  });
});
