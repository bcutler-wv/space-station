import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { PrivateBlobStore } from './private-blob-store.js';

const base = path.resolve('.cache/test-private-blobs');
let root: string;
beforeEach(async () => {
  await mkdir(base, { recursive: true });
  root = await mkdtemp(path.join(base, 'case-'));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('PrivateBlobStore', () => {
  it('publishes bounded immutable files and deletes by generated key', async () => {
    const store = new PrivateBlobStore(root, 10);
    const key = await store.write(Buffer.from('hello'));
    expect(key).toMatch(/^b_[0-9a-f]{64}$/);
    expect((await store.read(key)).toString()).toBe('hello');
    expect((await lstat(path.join(root, key))).mode & 0o777).toBe(0o640);
    await expect(store.write(Buffer.alloc(11))).rejects.toThrow('byte limit');
    expect(await readdir(root)).toEqual([key]);
    await store.delete(key);
    await store.delete(key);
    await expect(store.read(key)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts only generated reserved keys and never replaces a publication', async () => {
    const store = new PrivateBlobStore(root);
    const key = PrivateBlobStore.generateKey();
    await store.writeReserved(key, Buffer.from('first'));
    await expect(store.writeReserved(key, Buffer.from('second'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await store.read(key)).toString()).toBe('first');
    await expect(store.writeReserved('../unsafe', Buffer.from('x'))).rejects.toThrow('Invalid blob key');
    await store.deleteTemporary(key);
  });
  it('removes only the crashed temporary file for one reserved key', async () => {
    const store = new PrivateBlobStore(root);
    const crashed = PrivateBlobStore.generateKey();
    const other = PrivateBlobStore.generateKey();
    await writeFile(path.join(root, `.tmp-${crashed}`), 'partial');
    await writeFile(path.join(root, `.tmp-${other}`), 'other partial');
    await store.deleteTemporary(crashed);
    expect(await readdir(root)).toEqual([`.tmp-${other}`]);
  });

  it('rejects traversal and symlink targets', async () => {
    const store = new PrivateBlobStore(root);
    for (const key of ['../outside', '/etc/passwd', 'b_ABC', `b_${'a'.repeat(64)}/other`]) {
      await expect(store.read(key)).rejects.toThrow('Invalid blob key');
      await expect(store.delete(key)).rejects.toThrow('Invalid blob key');
    }
    const target = path.join(base, 'outside');
    await writeFile(target, 'secret');
    const key = `b_${'a'.repeat(64)}`;
    await symlink(target, path.join(root, key));
    await expect(store.read(key)).rejects.toMatchObject({ code: 'ELOOP' });
    await expect(store.delete(key)).rejects.toThrow('regular file');
    expect(await readFile(target, 'utf8')).toBe('secret');
    await rm(target);
    const linkedRoot = path.join(base, 'linked-root');
    await symlink(root, linkedRoot);
    await expect(new PrivateBlobStore(linkedRoot).write(Buffer.from('x'))).rejects.toThrow('real directory');
    await expect(new PrivateBlobStore(`${linkedRoot}/`).write(Buffer.from('x'))).rejects.toThrow('real directory');
    await rm(linkedRoot);
  });

  it('bounds reads even if the stored file is unexpectedly oversized', async () => {
    const key = `b_${'b'.repeat(64)}`;
    await writeFile(path.join(root, key), Buffer.alloc(11));
    await expect(new PrivateBlobStore(root, 10).read(key)).rejects.toThrow('bounded regular file');
  });

  it('rejects a FIFO without waiting for a writer', async () => {
    const key = `b_${'c'.repeat(64)}`;
    try {
      execFileSync('mkfifo', [path.join(root, key)]);
    } catch (error) {
      // The agent-dev sandbox blocks subprocess creation; CI exercises this on Ubuntu.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(new PrivateBlobStore(root).read(key)).rejects.toThrow('regular file');
  });

  it('cleans interrupted temporary writes before publication', async () => {
    const store = new PrivateBlobStore(root);
    let checks = 0;
    const signal = { throwIfAborted: () => { if (++checks === 2) throw new Error('interrupted'); } } as AbortSignal;
    await expect(store.write(Buffer.from('content'), signal)).rejects.toThrow('interrupted');
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps concurrent publications distinct and readable', async () => {
    const store = new PrivateBlobStore(root);
    const payloads = Array.from({ length: 32 }, (_, i) => Buffer.from(`value-${i}`));
    const keys = await Promise.all(payloads.map((p) => store.write(p)));
    expect(new Set(keys).size).toBe(keys.length);
    const values = await Promise.all(keys.map((key) => store.read(key)));
    expect(values.map((v) => v.toString())).toEqual(payloads.map((p) => p.toString()));
    expect((await readdir(root)).sort()).toEqual([...keys].sort());
  });

  it('makes simultaneous deletion of the same key safe to retry', async () => {
    const store = new PrivateBlobStore(root);
    const key = await store.write(Buffer.from('once'));
    await Promise.all(Array.from({ length: 32 }, () => store.delete(key)));
    expect(await readdir(root)).toEqual([]);
  });
});
