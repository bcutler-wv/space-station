import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from './secret-envelope.js';

describe('versioned secret envelope', () => {
  it('roundtrips only with the same key and record context', () => {
    const key = randomBytes(32);
    const envelope = sealSecret('sensitive', key, 'google_accounts/a/access');
    expect(openSecret(envelope, key, 'google_accounts/a/access')).toBe('sensitive');
    expect(() => openSecret(envelope, key, 'google_accounts/b/access')).toThrow();
    expect(() => openSecret(envelope, randomBytes(32), 'google_accounts/a/access')).toThrow();
    const [version, wrappedKey, payload] = envelope.split('.');
    const tampered = Buffer.from(payload!, 'base64url');
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => openSecret(`${version}.${wrappedKey}.${tampered.toString('base64url')}`, key, 'google_accounts/a/access')).toThrow();
    expect(() => openSecret(`v2.${wrappedKey}.${payload}`, key, 'google_accounts/a/access')).toThrow();
  });
});
