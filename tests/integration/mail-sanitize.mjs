import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { parseInChild } from '../../apps/worker/dist/mail-parser-service.js';
import { sanitizeMailHtml } from '../../apps/worker/dist/mail-html-sanitize.js';

const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(require.resolve('../../apps/worker/package.json'))('jsdom');
const mime = (html) => Buffer.from(`From: sender@example.com\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`);
const assertInertAfterReparse = (html) => {
  let markup = html;
  for (let pass = 0; pass < 2; pass++) {
    const dom = new JSDOM(`<!doctype html><body>${markup}</body>`);
    try {
      const body = dom.window.document.body;
      assert.equal(body.querySelectorAll('script,style,svg,math,iframe,form,input,base,meta,img,object,embed,link').length, 0);
      for (const element of body.querySelectorAll('*')) {
        for (const attribute of element.attributes) {
          assert.doesNotMatch(attribute.name, /^(on|style$|srcset$|background$|ping$|id$|name$)/i);
          if (attribute.name === 'href') {
            assert.equal(element.tagName, 'A');
            assert.match(attribute.value, /^(https?:\/\/|mailto:)/);
            assert.equal(element.getAttribute('rel'), 'noopener noreferrer');
          }
        }
      }
      markup = body.innerHTML;
    } finally { dom.window.close(); }
  }
};
const hostile = [
  '<script>alert(1)</script><b>Visible</b><iframe src="https://example.com/frame"></iframe>',
  '<svg><foreignObject><script>alert(1)</script></foreignObject></svg><math><mtext><img src=x onerror=alert(1)></mtext></math><p>Text</p>',
  '<form action="https://example.com/post"><input value="secret"></form><style>@import url(https://example.com/css)</style><div style="background:url(https://example.com/track)" onclick="bad()">Safe</div>',
  '<base href="https://example.com/"><meta http-equiv="refresh" content="0;url=https://example.com/"><a href="jav&#x61;script:alert(1)">Bad</a>',
  '<a href="https://user:pass@example.com/">Credentials</a><a href="https://example.com/%0d%0afoo">Controls</a>',
  '<img src="data:image/png;base64,AA==" srcset="https://example.com/1 1x, https://example.com/2 2x" onload="bad()"><span data-station-image-ref="attacker">Fake</span>',
  '<div id="location" name="constructor"><a href="https://example.com/">Real</a></div>',
  '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>"></table></mtext></math><p>Visible</p>',
  '<svg><desc><table><tr><td><style><img src=x onerror=alert(1)></style></td></tr></table></desc></svg><p>Visible</p>',
  '<table><tr><td><svg><foreignObject><p><img src=x onerror=alert(1)></p></foreignObject></svg></td></tr></table>',
];
for (const [index, input] of hostile.entries()) {
  const result = await parseInChild(mime(input));
  assert.equal(result.ok, true, `fixture ${index}: ${JSON.stringify(result)}`);
  const html = result.mail.sanitizedHtml.html;
  assert.doesNotMatch(html, /<script|<svg|<math|<iframe|<form|<style|<input|<base|<meta|<img/i);
  assert.doesNotMatch(html, /onclick|onerror|onload|srcset|style=|id=|name=|javascript:|data:image|https:\/\/user|%0d|attacker/i);
  assertInertAfterReparse(html);
}

const good = await parseInChild(mime('<p>Hello <a href="https://example.com/path?q=1">Open</a><a href="mailto:help@example.com">Mail</a></p><table><tr><th>Head</th><td><strong>Cell</strong></td></tr></table><img src="https://example.com/pixel?id=2" alt="Chart"><img src="cid:chart@example.com">'));
assert.equal(good.ok, true, JSON.stringify(good));
const safe = good.mail.sanitizedHtml;
assert.match(safe.html, /<table><tbody><tr><th>Head<\/th><td><strong>Cell<\/strong><\/td><\/tr><\/tbody><\/table>/);
assert.match(safe.html, /href="https:\/\/example.com\/path\?q=1" rel="noopener noreferrer" target="_blank"/);
assert.match(safe.html, /href="mailto:help@example.com" rel="noopener noreferrer" target="_blank"/);
assert.deepEqual(safe.images.map(({ kind, source }) => ({ kind, source })), [
  { kind: 'remote', source: 'https://example.com/pixel?id=2' },
  { kind: 'cid', source: 'chart@example.com' },
]);
for (const { refId } of safe.images) assert.match(safe.html, new RegExp(`data-station-image-ref="${refId}"`));
assert.doesNotMatch(safe.html, /<img|src=|srcset=/i);
assertInertAfterReparse(safe.html);
const hostileAlt = sanitizeMailHtml('<img src="https://example.com/a" alt="&lt;/span&gt;&lt;img src=x onerror=alert(1)&gt;">');
assert.equal(hostileAlt.images.length, 1);
assert.match(hostileAlt.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
assertInertAfterReparse(hostileAlt.html);
// Re-sanitizing strips generated data attributes too. A later reader must
// restore only IDs found in the independently validated stored image metadata.
const resanitized = sanitizeMailHtml(safe.html);
assert.doesNotMatch(resanitized.html, /data-station-image-ref=/);

let requests = 0;
const server = createServer((_request, response) => { requests++; response.end('unexpected'); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const source = `http://127.0.0.1:${server.address().port}/track`;
  const noFetch = sanitizeMailHtml(`<img src="${source}"><link rel="stylesheet" href="${source}"><style>@import url(${source})</style>`);
  assert.equal(noFetch.images.length, 1);
  assert.doesNotMatch(noFetch.html, /<link|<img|src=/i);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests, 0);
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }

const oversized = await parseInChild(mime('<p>' + 'a'.repeat(524_288) + '</p>'));
assert.deepEqual(oversized, { ok: false, code: 'limit_exceeded' });
const imageTag = '<img src="https://example.com/x">';
const sixtyFour = sanitizeMailHtml(imageTag.repeat(64));
assert.equal(sixtyFour.images.length, 64);
assertInertAfterReparse(sixtyFour.html);
assert.throws(() => sanitizeMailHtml(imageTag.repeat(65)), /limit/);
assert.deepEqual(await parseInChild(mime(imageTag.repeat(65))), { ok: false, code: 'limit_exceeded' });
const maxUrl = 'https://example.com/' + 'x'.repeat(2_048 - 'https://example.com/'.length);
const overUrl = maxUrl + 'x';
const boundedUrl = sanitizeMailHtml(`<img src="${maxUrl}"><img src="${overUrl}"><a href="${maxUrl}">Allowed</a><a href="${overUrl}">No link</a>`);
assert.equal(boundedUrl.images.length, 1);
assert.equal(boundedUrl.images[0].source, maxUrl);
assert.equal((boundedUrl.html.match(/href=/g) ?? []).length, 1);
assertInertAfterReparse(boundedUrl.html);
assert.throws(() => sanitizeMailHtml('&'.repeat(250_000)), /limit/);
assert.deepEqual(await parseInChild(mime('&'.repeat(250_000))), { ok: false, code: 'limit_exceeded' });
assert.equal((await parseInChild(mime('<p>After limit</p>'))).ok, true);
console.log('Mail sanitation fixtures passed.');
