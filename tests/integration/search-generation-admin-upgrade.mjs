import assert from 'node:assert/strict';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import process from 'node:process';
import { URL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { databaseUrl, loadRuntimeConfig } from '../../packages/db/dist/index.js';

const { Client } = createRequire(new URL('../../packages/db/package.json', import.meta.url))('pg');
const folder = process.env.SEARCH_GENERATION_ADMIN_UPGRADE_FOLDER;
const invalid = process.env.SEARCH_GENERATION_ADMIN_UPGRADE_INVALID === '1';
if (folder !== `${process.cwd()}/.cache/results/search-generation-admin-upgrade`)
  throw new Error('P2a upgrade fixture requires private repo-local results folder');
const source = new URL('../../packages/db/drizzle/', import.meta.url);
const journal = JSON.parse(await readFile(new URL('meta/_journal.json', source), 'utf8'));
const prior = journal.entries.filter((entry) => entry.idx <= 17);
assert.equal(prior.length, 18);
await mkdir(`${folder}/meta`, { recursive: true });
await writeFile(`${folder}/meta/_journal.json`, JSON.stringify({ ...journal, entries: prior }));
for (const entry of prior) await copyFile(new URL(`${entry.tag}.sql`, source), `${folder}/${entry.tag}.sql`);

const client = new Client({ connectionString: databaseUrl(loadRuntimeConfig(process.env)),
  connectionTimeoutMillis: 3_000, query_timeout: 35_000 });
await client.connect();
try {
  await client.query("set statement_timeout = '30s'");
  await client.query("set lock_timeout = '3s'");
  await migrate(drizzle(client), { migrationsFolder: folder });
  const token = invalid ? 'bad-token' : randomUUID().toUpperCase();
  const name = `station-mail-v2-g${randomUUID().replaceAll('-', '')}`;
  await client.query('insert into search_generation_history(generation_token,physical_index,profile_id) values($1,$2,$3)',
    [token, name, 'station-mail-v2']);
  await client.query(`update search_generation_control set revision=2,stage='disabled_intent',transition_token=$1,
    generation_token=$2,physical_index=$3,profile_id='station-mail-v2'`, [randomUUID(), token, name]);
  const account = randomUUID(), item = randomUUID();
  await client.query(`insert into search_documents(account_id,item_id,document_id,desired_revision,desired_state,
    acknowledged_revision,acknowledged_global_epoch,acknowledged_account_epoch,
    acknowledged_generation_token,acknowledged_disposition)
    values($1,$2,$3,3,'purge',2,1,1,$4,'fence')`, [account, item, `mail:${account}:${item}`, token]);
  if (invalid) {
    await assert.rejects(migrate(drizzle(client), { migrationsFolder: new URL('../../packages/db/drizzle/', import.meta.url).pathname }),
      (error) => (error.cause?.code ?? error.code) === '23514', 'invalid P1 reservation fails atomically');
    const { rows } = await client.query("select to_regclass('public.search_generation_dispatch') as dispatch");
    assert.equal(rows[0].dispatch, null, 'failed migration leaves no P2a table');
    const retained = await client.query('select desired_revision from search_documents where item_id=$1', [item]);
    assert.equal(retained.rows[0].desired_revision, 3);
    console.info('P2a invalid P1 reservation upgrade rolled back atomically.');
  } else {
    await migrate(drizzle(client), { migrationsFolder: new URL('../../packages/db/drizzle/', import.meta.url).pathname });
    const history = await client.query('select * from search_generation_history where generation_token=$1', [token]);
    assert.equal(history.rows[0].physical_index, name);
    assert.equal(history.rows[0].lifecycle, 'reserved');
    assert.equal(history.rows[0].index_uuid, null);
    assert.equal(history.rows[0].writer_cert_fingerprint, null);
    assert.equal(history.rows[0].writer_role, `station_indexer_${token.replaceAll('-', '').toLowerCase()}`);
    const control = await client.query('select * from search_generation_control');
    assert.equal(control.rows[0].stage, 'disabled_intent');
    assert.equal(control.rows[0].source_generation_token, null);
    assert.equal(control.rows[0].publication_enabled, false);
    const doc = await client.query('select * from search_documents where item_id=$1', [item]);
    assert.equal(doc.rows[0].acknowledged_revision, 2);
    assert.equal(doc.rows[0].acknowledged_generation_token, token);
    console.info('P2a P1-to-P2a upgrade preserved reservation, acknowledgement and nullable evidence.');
  }
} finally { await client.end(); }
