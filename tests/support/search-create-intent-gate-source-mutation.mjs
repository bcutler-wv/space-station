import { copyFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Disposable gate-only source mutation; restoration is safe after any partial change. */
export function sourceMutation(root, target, replacement) {
  const name = path.join(root, target), moved = `${name}.intent-original`;
  let changed = false;
  return {
    async change() {
      if (changed) throw Error('fixture source already changed');
      await rename(name, moved);
      changed = true;
      if (replacement) await copyFile(path.join(root, replacement), name);
    },
    async restore() {
      if (!changed) return;
      await rm(name, { force: true });
      await rename(moved, name);
      changed = false;
    },
  };
}
