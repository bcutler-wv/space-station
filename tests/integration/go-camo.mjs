import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { Console } from 'node:console';
const { fetch, AbortSignal } = globalThis;
const log = new Console(process.stdout);

const key = process.env.GOCAMO_HMAC;
assert.match(key ?? '', /^[A-Za-z0-9_-]{43}$/);
const base = 'http://go-camo:8080';
const sign = (url) => `${base}/${createHmac('sha1', key).update(url).digest('hex')}/${Buffer.from(url).toString('hex')}`;
const request = (url) => fetch(sign(url), { signal: AbortSignal.timeout(8_000), redirect: 'manual' });
const positive = await request('http://raster.example.com/raster');
assert.equal(positive.status, 200);
assert.equal(positive.headers.get('content-type'), 'image/png');
assert.ok((await positive.arrayBuffer()).byteLength > 20);
const invalid = await fetch(`${base}/${'0'.repeat(40)}/${Buffer.from('http://raster.example.com/raster').toString('hex')}`);
assert.notEqual(invalid.status, 200, 'Invalid HMAC is rejected');
await invalid.body?.cancel();
for (const url of ['http://127.0.0.1/raster', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/raster']) {
  const result = await request(url);
  assert.notEqual(result.status, 200, `${url} was blocked at the dial`);
  await result.body?.cancel();
}
const redirect = await request('http://raster.example.com/redirect');
assert.notEqual(redirect.status, 200, 'Redirects are disabled');
await redirect.body?.cancel();
log.log('Pinned go-camo signature, dial filter, redirect and local positive fixture passed');
