import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const log = await readFile(process.argv[2], 'utf8');
const generated = [];
for (const [file, expression] of [
  ['.env', /^(?:POSTGRES_PASSWORD|STATION_MASTER_KEY)=(.+)$/gm],
  ['.cache/go-camo.env', /^GOCAMO_HMAC=(.+)$/gm],
]) {
  const contents = await readFile(path.join(root, file), 'utf8');
  generated.push(...[...contents.matchAll(expression)].map(match => match[1]));
}
generated.push((await readFile(path.join(root,
  '.cache/search-db/initial-v1/verifier.password'), 'utf8')).trim());
generated.push((await readFile(path.join(root,
  '.cache/search-db/initial-v1/transition.password'), 'utf8')).trim());
const privateKey = await readFile(path.join(root, '.cache/search-security/ca.key'), 'utf8');
generated.push(privateKey.split('\n').find(line => line.length >= 40)?.slice(0, 32));
for (const marker of generated) {
  assert.ok(marker && marker.length >= 16);
  assert.equal(log.includes(marker), false, 'Generated secret marker in fixture output');
}
process.stdout.write('Generated-secret log scan passed.\n');
