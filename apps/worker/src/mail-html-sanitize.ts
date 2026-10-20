import { randomBytes } from 'node:crypto';
import createDOMPurify from 'dompurify';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  MAIL_HTML_ATTRIBUTES, MAIL_HTML_LIMITS, MAIL_HTML_POLICY_VERSION, MAIL_HTML_TAGS,
  safeMailImage, safeMailLink,
} from '@station/shared';

export function sanitizeMailHtml(input: string) {
  if (Buffer.byteLength(input) > MAIL_HTML_LIMITS.inputBytes) throw new Error('limit');
  // This runs only in the killable parser child. A blank document has no hostile
  // resources, script execution, or page URL; jsdom's default resource loading is off.
  const dom = new JSDOM('', { virtualConsole: new VirtualConsole() });
  try {
    const purify = createDOMPurify(dom.window);
    const fragment = purify.sanitize(input, {
      ALLOWED_TAGS: [...MAIL_HTML_TAGS],
      ALLOWED_ATTR: [...MAIL_HTML_ATTRIBUTES],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      RETURN_DOM_FRAGMENT: true,
    });
    for (const link of fragment.querySelectorAll('a')) {
      const href = link.getAttribute('href');
      const safe = href === null ? null : safeMailLink(href);
      if (safe) {
        link.setAttribute('href', safe);
        link.setAttribute('rel', 'noopener noreferrer');
        link.setAttribute('target', '_blank');
      } else link.removeAttribute('href');
    }
    const images: Array<{ refId: string; kind: 'remote' | 'cid'; source: string }> = [];
    for (const image of fragment.querySelectorAll('img')) {
      const source = image.getAttribute('src');
      const safe = source === null ? null : safeMailImage(source);
      const placeholder = dom.window.document.createElement('span');
      const alt = image.getAttribute('alt');
      placeholder.textContent = alt ? `[Image: ${alt}]` : '[Image blocked]';
      if (safe) {
        if (images.length >= MAIL_HTML_LIMITS.images) throw new Error('limit');
        const refId = randomBytes(16).toString('hex');
        images.push({ refId, ...safe });
        // Only generated here, after DOMPurify stripped every input data attribute.
        placeholder.setAttribute('data-station-image-ref', refId);
      }
      image.replaceWith(placeholder);
    }
    const holder = dom.window.document.createElement('div');
    holder.append(fragment);
    const html = holder.innerHTML;
    if (Buffer.byteLength(html) > MAIL_HTML_LIMITS.outputBytes) throw new Error('limit');
    return { policyVersion: MAIL_HTML_POLICY_VERSION, html, images };
  } finally { dom.window.close(); }
}
