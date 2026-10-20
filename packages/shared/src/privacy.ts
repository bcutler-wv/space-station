import type { ExclusionRule, PrivacyDefaults } from './setup.js';

export interface PrivacyItem {
  account: string;
  sender: string;
  labels: readonly string[];
  orbitIds: readonly string[];
}
export interface ScopedPrivacyRule extends ExclusionRule {
  orbitId: string | null;
}

function matches(rule: ScopedPrivacyRule, item: PrivacyItem): boolean {
  if (rule.scope === 'orbit' && (!rule.orbitId || !item.orbitIds.includes(rule.orbitId))) return false;
  const value = rule.value.trim().toLowerCase();
  if (rule.kind === 'account') return item.account.toLowerCase() === value;
  if (rule.kind === 'sender') return item.sender.toLowerCase() === value;
  return item.labels.some((label) => label.toLowerCase() === value);
}

export function evaluatePrivacy(
  item: PrivacyItem,
  globalDefaults: PrivacyDefaults,
  orbitDefaults: ReadonlyMap<string, PrivacyDefaults>,
  rules: readonly ScopedPrivacyRule[],
) {
  let canIndex = item.orbitIds.length > 0 && globalDefaults.index === 'allow';
  let canUseAi = item.orbitIds.length > 0 && globalDefaults.ai === 'allow';
  for (const orbitId of item.orbitIds) {
    const defaults = orbitDefaults.get(orbitId);
    // Missing policy is restrictive, including while setup is incomplete.
    canIndex &&= defaults?.index === 'allow';
    canUseAi &&= defaults?.ai === 'allow';
  }
  for (const rule of rules) {
    if (!matches(rule, item)) continue;
    if (rule.effect === 'no_index' || rule.effect === 'no_ai_and_no_index') canIndex = false;
    if (rule.effect === 'no_ai' || rule.effect === 'no_ai_and_no_index') canUseAi = false;
  }
  return { canIndex, canUseAi, canEmbed: canIndex && canUseAi };
}

export function evaluateAttachmentPrivacy(parentPolicy: ReturnType<typeof evaluatePrivacy>) {
  return { ...parentPolicy };
}
