import { describe, expect, it } from 'vitest';
import { evaluateAttachmentPrivacy, evaluatePrivacy, type ScopedPrivacyRule } from './privacy.js';
import type { PrivacyDefaults } from './setup.js';

const allow = { index: 'allow', ai: 'allow' } as const;
const item = { account: 'work@example.com', sender: 'sender@example.com', labels: ['Sensitive'], orbitIds: ['work', 'shared'] };

describe('privacy policy', () => {
  it('combines global and all Orbit defaults most restrictively', () => {
    expect(evaluatePrivacy(item, allow, new Map<string, PrivacyDefaults>([['work', allow], ['shared', { index: 'exclude', ai: 'allow' }]]), [])).toEqual({ canIndex: false, canUseAi: true, canEmbed: false });
    expect(evaluatePrivacy(item, allow, new Map([['work', allow]]), []).canUseAi).toBe(false);
    expect(evaluatePrivacy(item, { index: 'allow', ai: 'exclude' }, new Map([['work', allow], ['shared', allow]]), []).canUseAi).toBe(false);
    expect(evaluatePrivacy({ ...item, orbitIds: [] }, allow, new Map(), [])).toEqual({ canIndex: false, canUseAi: false, canEmbed: false });
  });
  it('matches only bounded exact account, sender and label rules in scope', () => {
    const rules: ScopedPrivacyRule[] = [
      { scope: 'global', orbitId: null, kind: 'account', value: 'WORK@example.com', effect: 'no_index' },
      { scope: 'orbit', orbitId: 'shared', kind: 'sender', value: 'SENDER@example.com', effect: 'no_ai' },
      { scope: 'orbit', orbitId: 'other', kind: 'label', value: 'Sensitive', effect: 'no_ai_and_no_index' },
    ];
    const result = evaluatePrivacy(item, allow, new Map([['work', allow], ['shared', allow]]), rules);
    expect(result).toEqual({ canIndex: false, canUseAi: false, canEmbed: false });
    expect(evaluateAttachmentPrivacy(result)).toEqual(result);
    expect(evaluatePrivacy({ ...item, sender: 'not-sender@example.com', account: 'other@example.com', labels: ['Insensitives'] }, allow, new Map([['work', allow], ['shared', allow]]), rules)).toEqual({ canIndex: true, canUseAi: true, canEmbed: true });
  });
});
