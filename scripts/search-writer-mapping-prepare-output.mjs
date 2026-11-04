import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { canonicalAttestorValue } from './search-attestor-pure.mjs';
import { parseWriterMappingPrepareInput } from './search-writer-mapping-prepare-input.mjs';
import { validateSerializedWriterMappingIntent } from
  './search-writer-mapping-intent-pure.mjs';

const fail = () => { throw Error('Private writer mapping preparation output failed.'); };
const sha = /^[0-9a-f]{64}$/;
const hash = value => createHash('sha256').update(canonicalAttestorValue(value).bytes)
  .digest('hex');
const exact = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.length === names.length && keys.every(key => typeof key === 'string' &&
    names.includes(key) && descriptors[key].enumerable &&
    Object.hasOwn(descriptors[key], 'value'));
};
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Strict structural bytes only; no constructor brand or acquisition authority. */
export function parseWriterMappingPrepareOutput(bytes, originalInputBytes, expected,
  expectedAdminPublic) {
  try {
    const input = parseWriterMappingPrepareInput(originalInputBytes, expected);
    if (!Buffer.isBuffer(bytes) || bytes.length < 3 || bytes.length > 256 * 1024 ||
        bytes.at(-1) !== 10 || !exact(expectedAdminPublic,
          ['caSha256', 'adminSha256'])) fail();
    const value = JSON.parse(bytes.subarray(0, -1).toString('utf8'));
    if (!canonicalAttestorValue(value, 256 * 1024).bytes.equals(bytes.subarray(0, -1)) ||
        !exact(value, ['intent', 'sha256', 'adminPublic']) ||
        !exact(value.adminPublic, ['caSha256', 'adminSha256']) ||
        canonicalAttestorValue(value.adminPublic).bytes.toString('hex') !==
          canonicalAttestorValue(expectedAdminPublic).bytes.toString('hex') ||
        typeof value.sha256 !== 'string' || !sha.test(value.sha256) ||
        hash(value.intent) !== value.sha256) fail();
    const intent = validateSerializedWriterMappingIntent(value.intent, input);
    if (value.adminPublic.caSha256 !== input.priorPublicDigests.find(row =>
      row.path === 'ca.pem')?.sha256 ||
      value.adminPublic.adminSha256 !== input.priorPublicDigests.find(row =>
        row.path === 'v1/admin.pem')?.sha256) fail();
    return freeze({ intent, sha256: value.sha256 });
  } catch { fail(); }
}
