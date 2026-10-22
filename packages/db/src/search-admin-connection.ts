import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { clearTimeout, setTimeout } from 'node:timers';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import process from 'node:process';
import { buildSearchGenerationManifest } from './search-generation-manifest.js';
import { searchGenerationControl, searchGenerationDispatch, searchGenerationHistory } from './schema.js';

export type SearchAdminRole = 'station_search_verifier' | 'station_search_transition';
export type SearchAdminConnection = Readonly<{
  role: SearchAdminRole; host: 'postgres' | '127.0.0.1'; port: number;
  database: 'station'; passwordFile: string;
}>;
const MAX_SECRET_BYTES = 4096;
const MAX_HISTORY = 512;
const MAX_DISPATCH = MAX_HISTORY * 5;
const MAX_SNAPSHOT_BYTES = 256 * 1024;

export class SearchAdminDatabaseError extends Error {
  constructor(readonly kind: 'configuration' | 'secret' | 'connect' | 'query' | 'snapshot') {
    super(`Search admin database ${kind}.`);
  }
}

export async function readSearchAdminPassword(file: string): Promise<string> {
  if (typeof file !== 'string' || !file.startsWith('/') || file.includes('\0'))
    throw new SearchAdminDatabaseError('configuration');
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || typeof process.getuid !== 'function' ||
        stat.uid !== process.getuid() ||
        ![0o400, 0o600].includes(stat.mode & 0o777) || stat.size < 1 || stat.size > MAX_SECRET_BYTES)
      throw new SearchAdminDatabaseError('secret');
    const buffer = Buffer.alloc(MAX_SECRET_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const value = buffer.subarray(0, bytesRead).toString('utf8');
    if (bytesRead !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(value) ||
        Buffer.from(value, 'base64url').length !== 32) throw new SearchAdminDatabaseError('secret');
    await handle.close();
    handle = undefined;
    return value;
  } catch (error) {
    if (error instanceof SearchAdminDatabaseError) throw error;
    throw new SearchAdminDatabaseError('secret');
  } finally { await handle?.close().catch(() => {}); }
}

function validated(config: SearchAdminConnection): void {
  if (!config || !['station_search_verifier', 'station_search_transition'].includes(config.role) ||
      !['postgres', '127.0.0.1'].includes(config.host) ||
      !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
      config.database !== 'station') throw new SearchAdminDatabaseError('configuration');
}

export async function withSearchAdminDatabase<T>(config: SearchAdminConnection,
  work: (db: NodePgDatabase) => Promise<T>): Promise<T> {
  validated(config);
  const password = await readSearchAdminPassword(config.passwordFile);
  const pool = new Pool({ user: config.role, password, host: config.host, port: config.port,
    database: config.database, ssl: false, application_name: config.role,
    max: 1, connectionTimeoutMillis: 3_000, idleTimeoutMillis: 1_000,
    query_timeout: 5_000, statement_timeout: 3_000, lock_timeout: 750,
    idle_in_transaction_session_timeout: 3_000 });
  // pg can emit errors outside a query, including when an idle connection dies.
  let onFailure: (() => void) | undefined;
  const onPoolError = () => onFailure?.();
  pool.on('error', onPoolError);
  let result: T | undefined;
  let failure: SearchAdminDatabaseError | undefined;
  try {
    const client = await pool.connect();
    let uncertain = false;
    const disconnected = new Promise<never>((_, reject) => {
      onFailure = () => reject(new SearchAdminDatabaseError('query'));
    });
    const onClientError = () => onFailure?.();
    client.on('error', onClientError);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SearchAdminDatabaseError('query')), 20_000);
    });
    try { result = await Promise.race([work(drizzle(client)), disconnected, deadline]); }
    catch (error) {
      uncertain = true;
      failure = error instanceof SearchAdminDatabaseError ? error : new SearchAdminDatabaseError('query');
    } finally {
      clearTimeout(timer);
      client.off('error', onClientError);
      client.release(uncertain);
    }
  } catch { failure ??= new SearchAdminDatabaseError('connect'); }
  try { await pool.end(); }
  catch { failure ??= new SearchAdminDatabaseError('connect'); }
  pool.off('error', onPoolError);
  if (failure) throw failure;
  return result as T;
}

type AdminDb = NodePgDatabase;

/** No row locks; a later engine attestation must recheck this snapshot. */
export async function readSearchAdminSnapshot(db: AdminDb) {
  try {
    return await db.transaction(async tx => {
      await tx.execute('set transaction isolation level repeatable read, read only');
      const control = await tx.select().from(searchGenerationControl).limit(2);
      const history = await tx.select().from(searchGenerationHistory).limit(MAX_HISTORY + 1);
      const dispatch = await tx.select().from(searchGenerationDispatch)
        .orderBy(searchGenerationDispatch.generationToken, searchGenerationDispatch.operation)
        .limit(MAX_DISPATCH + 1);
      if (control.length !== 1 || history.length > MAX_HISTORY || dispatch.length > MAX_DISPATCH)
        throw new SearchAdminDatabaseError('snapshot');
      const manifest = buildSearchGenerationManifest(history);
      const result = { control: control[0], manifest, dispatch };
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_SNAPSHOT_BYTES)
        throw new SearchAdminDatabaseError('snapshot');
      return result;
    });
  } catch { throw new SearchAdminDatabaseError('snapshot'); }
}

export async function recheckSearchAdminSnapshot(db: AdminDb,
  expected: Awaited<ReturnType<typeof readSearchAdminSnapshot>>): Promise<boolean> {
  const actual = await readSearchAdminSnapshot(db);
  return JSON.stringify(actual) === JSON.stringify(expected);
}
