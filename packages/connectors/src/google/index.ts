import { gmail } from '@googleapis/gmail';
import { CodeChallengeMethod, OAuth2Client, type OAuth2ClientOptions } from 'google-auth-library';

export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export type GoogleTransport = OAuth2ClientOptions['transporter'];

/** A fresh SDK client is created for each request and never shares credentials globally. */
export class GoogleMailAuthorization {
  private readonly client: OAuth2Client;

  constructor(clientId: string, clientSecret: string, redirectUri: string, transport?: GoogleTransport) {
    this.client = new OAuth2Client({ clientId, clientSecret, redirectUri, transporterOptions: { timeout: 10_000 }, ...(transport ? { transporter: transport } : {}) });
  }

  async authorization(state: string) {
    const { codeVerifier, codeChallenge } = await this.client.generateCodeVerifierAsync();
    if (!codeVerifier || !codeChallenge) throw new Error('Google PKCE generation failed.');
    const url = this.client.generateAuthUrl({
      access_type: 'offline', prompt: 'consent', response_type: 'code',
      scope: [GMAIL_MODIFY_SCOPE], state,
      code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256,
    });
    return { url, codeVerifier };
  }

  async exchange(code: string, codeVerifier: string) {
    const { tokens } = await this.client.getToken({ code, codeVerifier });
    const scopes = tokens.scope?.split(/\s+/).filter(Boolean) ?? [];
    if (!tokens.refresh_token || !tokens.access_token || !scopes.includes(GMAIL_MODIFY_SCOPE))
      throw new Error('GOOGLE_CONSENT_INCOMPLETE');
    this.client.setCredentials(tokens);
    const response = await gmail({ version: 'v1', auth: this.client }).users.getProfile({ userId: 'me' }, { timeout: 10_000 });
    const email = response.data.emailAddress;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('GOOGLE_PROFILE_MISSING');
    return {
      email: email.toLowerCase(),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scopes,
      accessTokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    };
  }
}
