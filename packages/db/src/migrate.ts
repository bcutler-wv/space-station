import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { fileURLToPath } from 'node:url';

const migrationsFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));

export async function migrateDatabase(connectionString: string, migrateQueue: () => Promise<void>): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    // One session owns the Drizzle and pg-boss migration phase.
    await client.query('SELECT pg_advisory_lock(81923041)');
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await migrate(drizzle(client), { migrationsFolder });
      await migrateQueue();
    } finally {
      await client.query('SELECT pg_advisory_unlock(81923041)');
    }
  } finally {
    await client.end();
  }
}
