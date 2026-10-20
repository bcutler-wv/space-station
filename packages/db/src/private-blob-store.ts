import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import path from 'node:path';

const KEY_PATTERN = /^b_[0-9a-f]{64}$/;
const HARD_MAX_BYTES = 16 * 1024 * 1024;

export class PrivateBlobStore {
  private readonly root: string;

  constructor(
    root: string,
    private readonly maxBytes = HARD_MAX_BYTES,
  ) {
    if (!path.isAbsolute(root) || maxBytes < 1 || maxBytes > HARD_MAX_BYTES || !Number.isInteger(maxBytes)) {
      throw new Error('Blob store requires an absolute directory and a valid byte limit');
    }
    this.root = path.resolve(root);
  }

  private async directory() {
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Blob directory must be a real directory');
    return open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  }

  private file(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error('Invalid blob key');
    return path.join(this.root, key);
  }

  static generateKey(): string { return `b_${randomBytes(32).toString('hex')}`; }

  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const key = PrivateBlobStore.generateKey();
    await this.writeReserved(key, bytes, signal);
    return key;
  }

  // The caller must first commit a blob_intents row, then hold its row lock
  // through this write. That makes crash cleanup safe against active writers.
  async writeReserved(key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.maxBytes) throw new Error('Blob exceeds byte limit');
    this.file(key);
    const directory = await this.directory();
    const temporary = path.join(this.root, `.tmp-${key}`);
    let created = false;
    try {
      signal?.throwIfAborted();
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
      created = true;
      try {
        let offset = 0;
        while (offset < bytes.byteLength) {
          signal?.throwIfAborted();
          const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, offset);
          if (bytesWritten === 0) throw new Error('Blob write made no progress');
          offset += bytesWritten;
        }
        await file.sync();
      } finally {
        await file.close();
      }
      signal?.throwIfAborted();
      // Hard link publication is atomic and fails if an immutable key already exists.
      await link(temporary, this.file(key));
      await directory.sync();
      return;
    } finally {
      try {
        if (created) await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      } finally {
        await directory.close();
      }
    }
  }

  async deleteTemporary(key: string): Promise<void> {
    this.file(key);
    const directory = await this.directory();
    try {
      const filename = path.join(this.root, `.tmp-${key}`);
      const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (info) {
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Temporary blob is not a regular file');
        await unlink(filename);
      }
      await directory.sync();
    } finally { await directory.close(); }
  }

  async read(key: string, maxBytes = this.maxBytes): Promise<Buffer> {
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > this.maxBytes) throw new Error('Invalid blob read limit');
    const filename = this.file(key);
    const directory = await this.directory();
    try {
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > maxBytes) throw new Error('Blob is not a bounded regular file');
        const data = Buffer.allocUnsafe(maxBytes + 1);
        let offset = 0;
        while (offset < data.byteLength) {
          const { bytesRead } = await file.read(data, offset, data.byteLength - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > maxBytes) throw new Error('Blob exceeds byte limit');
        return data.subarray(0, offset);
      } finally {
        await file.close();
      }
    } finally {
      await directory.close();
    }
  }

  async delete(key: string): Promise<void> {
    const filename = this.file(key);
    const directory = await this.directory();
    try {
      const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (info === null) return;
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Blob is not a regular file');
      try {
        await unlink(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
