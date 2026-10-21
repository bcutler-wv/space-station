import { readFile, rm } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import console from 'node:console';

const path = process.argv[2];
if (!path || !path.startsWith('.cache/results/')) throw new Error('Expected an owned bounded search log artifact.');
const log = await readFile(path, 'utf8');
if (Buffer.byteLength(log) > 65_536) throw new Error('Search log artifact exceeds its bound.');
for (const role of ['ca', 'node', 'admin', 'query', 'indexer', 'outsider']) {
  const key = await readFile(`.cache/search-security/${role}.key`, 'utf8');
  for (const line of key.split('\n')) {
    if (line.length > 32 && log.includes(line)) {
      await rm(path);
      throw new Error('Search logs contained private key material; artifact removed.');
    }
  }
}
console.info('Bounded search logs contain no generated private key material.');
