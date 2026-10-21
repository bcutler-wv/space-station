import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { createRequire } from 'node:module';
import process from 'node:process';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const peggyRoot = dirname(require.resolve('peggy/package.json'));
const executable = join(peggyRoot, 'bin/peggy.js');
const grammar = join(root, 'src/query.peggy');
const output = join(root, 'src/generated-parser.js');
const declaration = join(root, 'src/generated-parser.d.ts');
const notice = join(root, 'vendor/peggy-LICENSE');
const check = process.argv.includes('--check');
const cache = fileURLToPath(new URL('../../../.cache/results/', import.meta.url));
await mkdir(cache, { recursive: true });
const temporary = await mkdtemp(join(cache, 'search-parser-'));
try {
  const generated = join(temporary, 'generated-parser.js');
  const result = spawnSync(process.execPath, [executable, '--format', 'es', '--dts', '--return-types',
    '{"Start":"unknown"}', '-o', generated, grammar], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `Peggy exited ${result.status}`);
  const outputs = [
    [output, generated],
    [declaration, join(temporary, 'generated-parser.d.ts')],
    [notice, join(peggyRoot, 'LICENSE')],
  ];
  for (const [target, source] of outputs) {
    const actual = await readFile(source);
    if (check && !(await readFile(target)).equals(actual)) throw new Error(`${target} differs from pinned Peggy generation`);
    else { await mkdir(dirname(target), { recursive: true }); await writeFile(target, actual); }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
