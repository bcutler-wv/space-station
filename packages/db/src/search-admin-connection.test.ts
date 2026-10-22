import { describe, expect, it } from 'vitest';
import { searchGenerationControl, searchGenerationDispatch, searchGenerationHistory } from './schema.js';
import { readSearchAdminRegistrySnapshot, readSearchAdminSnapshot } from './search-admin-connection.js';

const identity = { sessionUser: 'station_search_verifier', currentUser: 'station_search_verifier',
  database: 'station', databaseOid: 16384, databaseOwner: 'station' };

function fixture(input: { control?: readonly unknown[]; history?: readonly unknown[]; dispatch?: readonly unknown[];
  identity?: Record<string, unknown> } = {}) {
  const rows = new Map<unknown, readonly unknown[]>([
    [searchGenerationControl, input.control ?? [{ singleton: 1, stage: 'disabled' }]],
    [searchGenerationHistory, input.history ?? []],
    [searchGenerationDispatch, input.dispatch ?? []],
  ]);
  const selected = (table: unknown, fields?: Record<string, unknown>) => {
    const source = rows.get(table) ?? [];
    if (!fields) return source;
    return source.map((value) => {
      const row = value as Record<string, unknown>;
      if (table === searchGenerationControl) return { singleton: row.singleton,
        updatedAt: '2026-10-22T18:00:00.000001Z' };
      if (table === searchGenerationHistory) return { generationToken: row.generationToken,
        createdAt: '2026-10-22T18:00:00.000001Z' };
      return { generationToken: row.generationToken, operation: row.operation,
        dispatchId: row.dispatchId, createdAt: '2026-10-22T18:00:00.000001Z' };
    });
  };
  const tx = {
    execute: async (statement: unknown) => typeof statement === 'string' ? undefined :
      { rows: [input.identity ?? identity] },
    select: (fields?: Record<string, unknown>) => ({ from: (table: unknown) => ({
      orderBy: () => ({ limit: async (count: number) => selected(table, fields).slice(0, count) }),
      limit: async (count: number) => selected(table, fields).slice(0, count),
    }) }),
  };
  return { transaction: async (work: (db: typeof tx) => Promise<unknown>) => work(tx) } as unknown as
    Parameters<typeof readSearchAdminRegistrySnapshot>[0];
}

describe('bounded search admin registry reader', () => {
  it('keeps typed rows separate from exact SQL timestamp evidence', async () => {
    const actual = await readSearchAdminRegistrySnapshot(fixture(), 'station_search_verifier');
    expect(actual.exactTimestamps.control.updatedAt).toBe('2026-10-22T18:00:00.000001Z');
    expect(actual.history).toEqual([]);
  });
  it('rejects excess rows without truncating', async () => {
    for (const input of [
      { control: [] }, { control: [{}, {}] },
      { history: Array(513).fill({}) }, { dispatch: Array(2561).fill({}) },
    ]) {
      await expect(readSearchAdminRegistrySnapshot(fixture(input))).rejects.toMatchObject({ kind: 'snapshot' });
      await expect(readSearchAdminSnapshot(fixture(input))).rejects.toMatchObject({ kind: 'snapshot' });
    }
  });

  it('bounds complete raw and projected results separately', async () => {
    const db = fixture({ control: [{ singleton: 1, stage: 'x'.repeat(262_144) }] });
    await expect(readSearchAdminRegistrySnapshot(db)).rejects.toMatchObject({ kind: 'snapshot' });
    await expect(readSearchAdminSnapshot(db)).rejects.toMatchObject({ kind: 'snapshot' });
  });

  it('counts exact timestamp evidence in the raw byte cap', async () => {
    const history = Array.from({ length: 512 }, (_, i) => ({ generationToken: `g${i}` }));
    const db = fixture({ control: [{ singleton: 1, stage: 'x'.repeat(230_000) }], history });
    await expect(readSearchAdminRegistrySnapshot(db)).rejects.toMatchObject({ kind: 'snapshot' });
  });

  it('rejects unexpected session and database identity', async () => {
    for (const bad of [
      { currentUser: 'station' }, { sessionUser: 'station' },
      { database: 'other' }, { databaseOid: 0 }, { databaseOwner: 'other' },
    ]) await expect(readSearchAdminRegistrySnapshot(fixture({ identity: { ...identity, ...bad } })))
      .rejects.toMatchObject({ kind: 'snapshot' });
    await expect(readSearchAdminRegistrySnapshot(fixture(), 'station_search_transition'))
      .rejects.toMatchObject({ kind: 'snapshot' });
  });
});
