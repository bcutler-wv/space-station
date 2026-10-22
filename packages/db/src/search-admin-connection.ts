import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { clearTimeout, setTimeout } from 'node:timers';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
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
type SearchAdminIdentity = Readonly<{
  sessionUser: SearchAdminRole; currentUser: SearchAdminRole;
  database: 'station'; databaseOid: number; databaseOwner: 'station';
}>;

function bounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SNAPSHOT_BYTES)
    throw new SearchAdminDatabaseError('snapshot');
}

async function readRows(db: AdminDb, expectedRole?: SearchAdminRole) {
  return db.transaction(async tx => {
    await tx.execute('set transaction isolation level repeatable read, read only');
    const identityRows = await tx.execute(sql<{
      sessionUser: string; currentUser: string; database: string;
      databaseOid: number; databaseOwner: string;
    }>`select session_user as "sessionUser", current_user as "currentUser",
      current_database() as "database", d.oid::integer as "databaseOid",
      pg_get_userbyid(d.datdba) as "databaseOwner"
      from pg_catalog.pg_database d where d.datname = current_database()`);
    const identity = identityRows.rows[0];
    if (identityRows.rows.length !== 1 || !identity ||
        typeof identity.sessionUser !== 'string' ||
        !['station_search_verifier', 'station_search_transition'].includes(identity.sessionUser) ||
        identity.currentUser !== identity.sessionUser ||
        (expectedRole && identity.sessionUser !== expectedRole) ||
        identity.database !== 'station' || identity.databaseOwner !== 'station' ||
        typeof identity.databaseOid !== 'number' ||
        !Number.isInteger(identity.databaseOid) || identity.databaseOid < 1)
      throw new SearchAdminDatabaseError('snapshot');
    const control = await tx.select().from(searchGenerationControl).limit(2);
    const history = await tx.select().from(searchGenerationHistory)
      .orderBy(searchGenerationHistory.generationToken).limit(MAX_HISTORY + 1);
    const dispatch = await tx.select().from(searchGenerationDispatch)
      .orderBy(searchGenerationDispatch.generationToken, searchGenerationDispatch.operation,
        searchGenerationDispatch.dispatchId).limit(MAX_DISPATCH + 1);
    if (control.length !== 1 || history.length > MAX_HISTORY || dispatch.length > MAX_DISPATCH)
      throw new SearchAdminDatabaseError('snapshot');
    // pg/Drizzle Date values discard PostgreSQL's sub-millisecond precision.
    // Keep exact SQL text alongside the Date-shaped rows used by E0a.
    const exactControl = await tx.select({ singleton: searchGenerationControl.singleton,
      updatedAt: sql<string>`to_char(${searchGenerationControl.updatedAt} at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z'` })
      .from(searchGenerationControl).limit(2);
    const exactHistory = await tx.select({ generationToken: searchGenerationHistory.generationToken,
      createdAt: sql<string>`to_char(${searchGenerationHistory.createdAt} at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z'` })
      .from(searchGenerationHistory).orderBy(searchGenerationHistory.generationToken)
      .limit(MAX_HISTORY + 1);
    const exactDispatch = await tx.select({ generationToken: searchGenerationDispatch.generationToken,
      operation: searchGenerationDispatch.operation, dispatchId: searchGenerationDispatch.dispatchId,
      createdAt: sql<string>`to_char(${searchGenerationDispatch.createdAt} at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z'` })
      .from(searchGenerationDispatch)
      .orderBy(searchGenerationDispatch.generationToken, searchGenerationDispatch.operation,
        searchGenerationDispatch.dispatchId).limit(MAX_DISPATCH + 1);
    const timestamp = (value: unknown) => typeof value === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value);
    if (exactControl.length !== 1 || exactControl[0]?.singleton !== control[0]?.singleton ||
        !timestamp(exactControl[0]?.updatedAt) || exactHistory.length !== history.length ||
        exactDispatch.length !== dispatch.length ||
        exactHistory.some((item, i) => item.generationToken !== history[i]?.generationToken ||
          !timestamp(item.createdAt)) ||
        exactDispatch.some((item, i) => item.generationToken !== dispatch[i]?.generationToken ||
          item.operation !== dispatch[i]?.operation || item.dispatchId !== dispatch[i]?.dispatchId ||
          !timestamp(item.createdAt))) throw new SearchAdminDatabaseError('snapshot');
    return { control: control[0], history, dispatch, identity: identity as SearchAdminIdentity,
      exactTimestamps: { control: exactControl[0]!, history: exactHistory, dispatch: exactDispatch } };
  });
}

/** No row locks; a later engine attestation must recheck this snapshot. */
export async function readSearchAdminSnapshot(db: AdminDb) {
  try {
    const { control, history, dispatch } = await readRows(db);
    const result = { control, manifest: buildSearchGenerationManifest(history), dispatch };
    bounded(result);
    return result;
  } catch { throw new SearchAdminDatabaseError('snapshot'); }
}

/** Complete registry evidence plus unprivileged identity of the configured endpoint. */
export async function readSearchAdminRegistrySnapshot(db: AdminDb, expectedRole?: SearchAdminRole) {
  try {
    const result = await readRows(db, expectedRole);
    bounded({ control: result.control, history: result.history, dispatch: result.dispatch,
      exactTimestamps: result.exactTimestamps });
    return result;
  } catch { throw new SearchAdminDatabaseError('snapshot'); }
}

export async function recheckSearchAdminRegistrySnapshot(db: AdminDb,
  expected: Awaited<ReturnType<typeof readSearchAdminRegistrySnapshot>>,
  expectedRole?: SearchAdminRole): Promise<boolean> {
  const actual = await readSearchAdminRegistrySnapshot(db, expectedRole);
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export async function recheckSearchAdminSnapshot(db: AdminDb,
  expected: Awaited<ReturnType<typeof readSearchAdminSnapshot>>): Promise<boolean> {
  const actual = await readSearchAdminSnapshot(db);
  return JSON.stringify(actual) === JSON.stringify(expected);
}
