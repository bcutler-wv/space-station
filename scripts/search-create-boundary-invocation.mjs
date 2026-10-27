import { Buffer } from 'node:buffer';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const project = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const fail = () => { throw new Error('Private create boundary invocation is invalid.'); };

/** Fixed owner-written marker, not a caller-supplied create intent. */
export function parseCreateBoundaryInvocation(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 90 || bytes.length > 256 || bytes.at(-1) !== 10) fail();
    const value = JSON.parse(bytes.subarray(0, -1).toString('utf8'));
    if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
        Object.keys(value).sort().join('|') !==
          'databaseOid|invocationId|owner|project|systemIdentifier|version' ||
        value.version !== 1 || typeof value.invocationId !== 'string' || !uuid.test(value.invocationId) ||
        typeof value.project !== 'string' || !project.test(value.project) ||
        value.owner !== 'station' ||
        typeof value.databaseOid !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value.databaseOid) ||
        Number(value.databaseOid) > 4_294_967_295 ||
        typeof value.systemIdentifier !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.systemIdentifier) ||
        BigInt(value.systemIdentifier) > 18_446_744_073_709_551_615n ||
        !bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))) fail();
    return value;
  } catch { fail(); }
}
