import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const fail = () => { throw Error('Private writer role apply file failed.'); };
export const sameWriterRoleApplyStat = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.uid === b.uid && a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export async function writerRoleApplyDir(name, uid, mode, previous) {
  const stat = await lstat(name);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== uid ||
      (stat.mode & 0o777) !== mode || await realpath(name) !== name ||
      previous && !sameWriterRoleApplyStat(stat, previous)) fail();
  return stat;
}

export async function writerRoleApplyFile(name, uid, modes, max, previous) {
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== uid ||
        !(Array.isArray(modes) ? modes : [modes]).includes(stat.mode & 0o777) ||
        stat.size < 1 || stat.size > max || !sameWriterRoleApplyStat(stat, await lstat(name)) ||
        await realpath(name) !== name || previous && !sameWriterRoleApplyStat(stat, previous.stat)) fail();
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytesRead !== stat.size || !sameWriterRoleApplyStat(stat, await handle.stat()) ||
        !sameWriterRoleApplyStat(stat, await lstat(name)) ||
        previous && !bytes.equals(previous.bytes)) fail();
    return { stat, bytes: Buffer.from(bytes), name };
  } finally { await handle.close(); }
}

export function writerRoleApplyPublicLayout(rows) {
  if (!Array.isArray(rows) || rows.length < 4 || rows.length > 1_028) fail();
  const inventory = new Map([['', new Set()]]);
  for (const row of rows) {
    if (!row || typeof row.path !== 'string' || row.path.startsWith('/') ||
        row.path.length > 192) fail();
    const parts = row.path.split('/');
    if (parts.some(part => !/^[a-z0-9.-]+$/.test(part) || part === '.' || part === '..')) fail();
    let parent = '';
    for (let i = 0; i < parts.length - 1; i++) {
      inventory.get(parent).add(parts[i]);
      parent = parent ? `${parent}/${parts[i]}` : parts[i];
      if (!inventory.has(parent)) inventory.set(parent, new Set());
    }
    inventory.get(parent).add(parts.at(-1));
  }
  return inventory;
}

export async function writerRoleApplyPublicTree(root, rows, uid, previous) {
  const layout = writerRoleApplyPublicLayout(rows);
  const dirs = new Map(), files = new Map();
  for (const [relative, children] of layout) {
    const name = path.join(root, relative);
    dirs.set(relative, await writerRoleApplyDir(name, uid, 0o700, previous?.dirs.get(relative)));
    if ((await readdir(name)).sort().join('|') !== [...children].sort().join('|')) fail();
  }
  for (const row of rows) files.set(row.path, await writerRoleApplyFile(
    path.join(root, row.path), uid, 0o400, 16_384, previous?.files.get(row.path)));
  return { dirs, files, layout };
}

export async function syncWriterRoleApplyDir(name) {
  const handle = await open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
