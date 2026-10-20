// Ingest and the later reader must use this same conservative HTML allowlist.
export const MAIL_HTML_POLICY_VERSION = 1 as const;
export const MAIL_HTML_LIMITS = {
  inputBytes: 524_288,
  outputBytes: 1_048_576,
  images: 64,
  urlLength: 2_048,
} as const;

export const MAIL_HTML_TAGS = [
  'a', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'h1', 'h2', 'h3', 'h4', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's',
  'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead',
  'tr', 'u', 'ul',
] as const;
export const MAIL_HTML_ATTRIBUTES = ['href', 'title', 'alt', 'src', 'colspan', 'rowspan'] as const;

const encodedControls = /%0[0-9a-f]|%1[0-9a-f]|%7f/i;
const hasForbiddenUrlCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || (code >= 127 && code <= 159) || character.trim() === '' || character === '\\';
  });

export function safeMailLink(value: string): string | null {
  if (value.length > MAIL_HTML_LIMITS.urlLength || hasForbiddenUrlCharacter(value) || encodedControls.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.href.length > MAIL_HTML_LIMITS.urlLength) return null;
    if (url.protocol === 'mailto:') return !url.search && !url.hash && url.pathname.length > 0 ? url.href : null;
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
  } catch { /* Relative and malformed destinations are not preserved. */ }
  return null;
}

export function safeMailImage(value: string): { kind: 'remote' | 'cid'; source: string } | null {
  if (value.length > MAIL_HTML_LIMITS.urlLength || hasForbiddenUrlCharacter(value) || encodedControls.test(value)) return null;
  if (/^cid:[a-z0-9_.@+-]{1,1024}$/i.test(value)) return { kind: 'cid', source: value.slice(4) };
  try {
    const url = new URL(value);
    if (url.href.length <= MAIL_HTML_LIMITS.urlLength &&
        (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
      return { kind: 'remote', source: url.href };
    }
  } catch { /* No relative, data, or protocol-relative image sources. */ }
  return null;
}
