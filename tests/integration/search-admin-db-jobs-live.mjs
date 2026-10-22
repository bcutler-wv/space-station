import assert from 'node:assert/strict';
import console from 'node:console';
import { createRequire } from 'node:module';
import process from 'node:process';
import { URL } from 'node:url';
import { readSearchAdminPassword, readSearchAdminSnapshot, withSearchAdminDatabase } from '../../packages/db/dist/search-admin-connection.js';

const role = process.argv[2];
if (process.argv.length !== 3 || !['verifier', 'transition'].includes(role)) process.exit(2);
const name = `station_search_${role}`;
const passwordFile = '/run/search-db/password';
const config = { role: name, host: 'postgres', port: 5432, database: 'station', passwordFile };
const { Client } = createRequire(new URL('../../packages/db/package.json', import.meta.url))('pg');
let client;
try {
  const snapshot = await withSearchAdminDatabase(config, readSearchAdminSnapshot);
  assert.equal(snapshot.control.publicationEnabled, false);
  assert.equal(snapshot.control.servingReady, false);
  client = new Client({ user: name, password: await readSearchAdminPassword(passwordFile),
    host: 'postgres', port: 5432, database: 'station', connectionTimeoutMillis: 3000,
    query_timeout: 5000, statement_timeout: 3000, lock_timeout: 750 });
  await client.connect();
  const identity = await client.query('select session_user, current_user');
  assert.deepEqual(identity.rows[0], { session_user: name, current_user: name });
  const denied = async (statement, label) => {
    await assert.rejects(client.query(statement), error => error.code === '42501', label);
  };
  await denied('select id from items limit 1', 'source read');
  await denied('select rolpassword from pg_authid limit 1', 'credential catalog read');
  await denied('create temporary table inspector_probe (id integer)', 'temporary table');
  await denied('create table inspector_probe (id integer)', 'schema create');
  await denied('update search_generation_control set publication_enabled=true', 'publication gate');
  await denied('update search_generation_control set serving_ready=true', 'serving gate');
  if (role === 'verifier')
    await denied("update search_generation_control set stage='disabled_intent' where false", 'verifier write');
  console.log(`PASS: ${role} fixed identity, bounded snapshot and authorization denials.`);
} catch {
  console.error(`FAIL: ${role} fixed identity or authorization boundary.`);
  process.exitCode = 1;
} finally { await client?.end().catch(() => {}); }
