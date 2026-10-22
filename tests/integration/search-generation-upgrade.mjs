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
const folder = process.env.SEARCH_GENERATION_UPGRADE_FOLDER;
const invalidAck = process.env.SEARCH_GENERATION_UPGRADE_INVALID_ACK === '1';
if (folder !== `${process.cwd()}/.cache/results/search-generation-upgrade`)
  throw new Error('Upgrade fixture needs a private repo-local results folder');
const source = new URL('../../packages/db/drizzle/', import.meta.url);
const journal = JSON.parse(await readFile(new URL('meta/_journal.json', source), 'utf8'));
const prior = journal.entries.filter((entry) => entry.idx <= 16);
assert.equal(prior.length, 17);
await mkdir(`${folder}/meta`, { recursive: true });
await writeFile(`${folder}/meta/_journal.json`, JSON.stringify({ ...journal, entries: prior }));
for (const entry of prior) await copyFile(new URL(`${entry.tag}.sql`, source), `${folder}/${entry.tag}.sql`);

const client = new Client({ connectionString: databaseUrl(loadRuntimeConfig(process.env)),
  connectionTimeoutMillis: 3_000, query_timeout: 35_000 });
await client.connect();
try {
  // Each statement is bounded without imposing one tiny limit on the full
  // historical migration sequence. A contended lock fails much sooner.
  await client.query("set statement_timeout = '30s'");
  await client.query("set lock_timeout = '3s'");
  await migrate(drizzle(client), { migrationsFolder: folder });
  const account = randomUUID(), item = randomUUID();
  await client.query(`insert into search_documents(account_id,item_id,document_id,desired_revision,desired_state,
    acknowledged_revision,acknowledged_global_epoch,acknowledged_account_epoch)
    values ($1,$2,$3,3,'purge',$4,$5,$6)`, [account, item, `mail:${account}:${item}`,
    invalidAck ? 2 : null, invalidAck ? 1 : null, invalidAck ? 1 : null]);
  const fullFolder = new URL('../../packages/db/drizzle/', import.meta.url).pathname;
  if (invalidAck) {
    await assert.rejects(migrate(drizzle(client), { migrationsFolder: fullFolder }),
      (error) => (error.cause?.code ?? error.code) === '23514',
      'an unqualified legacy acknowledgement fails the upgrade');
    const { rows } = await client.query('select to_regclass($1) as control', ['public.search_generation_control']);
    assert.equal(rows[0].control, null, 'failed migration is atomic');
    const retained = await client.query('select acknowledged_revision from search_documents where item_id=$1', [item]);
    assert.equal(retained.rows[0].acknowledged_revision, 2, 'failed upgrade retains old row');
    console.info('Unqualified legacy acknowledgement blocked 0017 atomically.');
  } else {
    await migrate(drizzle(client), { migrationsFolder: fullFolder });
    const { rows } = await client.query('select * from search_documents where account_id=$1 and item_id=$2', [account, item]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].desired_revision, 3);
    assert.equal(rows[0].desired_state, 'purge');
    assert.equal(rows[0].acknowledged_revision, null);
    assert.equal(rows[0].acknowledged_generation_token, null);
    assert.equal(rows[0].acknowledged_disposition, null);
    const control = await client.query('select * from search_generation_control');
    assert.equal(control.rows.length, 1);
    assert.equal(control.rows[0].publication_enabled, false);
    assert.equal(control.rows[0].serving_ready, false);
    console.info('Search generation 0016-to-0017 upgrade retained the content-free ledger and disabled control.');
  }
} finally { await client.end(); }
