import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { PrivateBlobStore } from '../../packages/db/dist/private-blob-store.js';

const store = new PrivateBlobStore(process.env.PRIVATE_BLOB_DIR, 1024);
const [operation, key] = process.argv.slice(2);
if (operation === 'write') {
  process.stdout.write(`${await store.write(Buffer.from(key))}\n`);
} else if (operation === 'read') {
  assert.equal((await store.read(key)).toString(), process.argv[4]);
} else if (operation === 'delete') {
  await store.delete(key);
} else {
  throw new Error('Unknown blob volume test operation');
}
