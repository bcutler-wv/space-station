import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const roots = ['apps', 'packages'];
const allowed = 'packages/theme/src/tokens.css';
const color = /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|color)\s*\(/gi;
let failed = false;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !['dist', 'node_modules'].includes(entry.name)) await walk(path);
    else if (/\.(css|tsx?|jsx?)$/.test(path) && path !== allowed) {
      const source = await readFile(path, 'utf8');
      if (color.test(source)) { console.error(`Stray color literal: ${path}`); failed = true; }
      color.lastIndex = 0;
    }
  }
}
for (const root of roots) await walk(root);
if (failed) process.exitCode = 1;
