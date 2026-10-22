import { randomUUID } from 'node:crypto';
import { eq, isNull, or, sql } from 'drizzle-orm';
import { bumpSearchGlobalEpoch, exclusionRules, orbits, settings, type openDatabase } from '@station/db';
import { privacyDefaultsSchema, setupStatusSchema, type SetupStatus, type SetupSubmit } from '@station/shared';

type Database = ReturnType<typeof openDatabase>['db'];
export interface SetupStore {
  get(origin: string): Promise<SetupStatus>;
  complete(value: SetupSubmit, origin: string): Promise<SetupStatus | null>;
  isReady(origin: string): Promise<boolean>;
  reconfirmOrigin(origin: string): Promise<SetupStatus | null>;
}

export function databaseSetupStore(db: Database): SetupStore {
  const get = async (origin: string): Promise<SetupStatus> => {
    const [state] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'first_orbit_setup_v1')).limit(1);
    if (!state) return { version: 1, configuredOrigin: origin, confirmedOrigin: null, completed: false, orbit: null, globalDefaults: null, orbitDefaults: null, exclusions: [] };
    const stored = state.value as { orbitId: string; globalDefaults: unknown; confirmedOrigin: string };
    const [orbit] = await db.select().from(orbits).where(eq(orbits.id, stored.orbitId)).limit(1);
    if (!orbit) throw new Error('First Orbit setup is inconsistent.');
    const rows = await db.select().from(exclusionRules).where(or(isNull(exclusionRules.orbitId), eq(exclusionRules.orbitId, stored.orbitId)));
    return setupStatusSchema.parse({
      version: 1, configuredOrigin: origin, confirmedOrigin: stored.confirmedOrigin, completed: true,
      orbit: { id: orbit.id, name: orbit.name, colorSlot: orbit.colorSlot, context: orbit.context },
      globalDefaults: privacyDefaultsSchema.parse(stored.globalDefaults),
      orbitDefaults: privacyDefaultsSchema.parse(orbit.privacyDefaults),
      exclusions: rows.map((row) => ({ scope: row.orbitId ? 'orbit' : 'global', kind: row.kind, value: row.value, effect: row.effect })),
    });
  };
  return {
    get,
    async isReady(origin) {
      const state = await get(origin);
      return state.completed && state.confirmedOrigin === origin;
    },
    async reconfirmOrigin(origin) {
      const exists = await db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '3000ms'`);
        await tx.execute(sql`set local lock_timeout = '750ms'`);
        const [marker] = await tx.select({ value: settings.value }).from(settings)
          .where(eq(settings.key, 'first_orbit_setup_v1')).for('update');
        if (!marker) return false;
        if ((marker.value as { confirmedOrigin?: string }).confirmedOrigin === origin) return true;
        await tx.update(settings).set({ value: sql`jsonb_set(${settings.value}, '{confirmedOrigin}', ${JSON.stringify(origin)}::jsonb)`, updatedAt: new Date() })
          .where(eq(settings.key, 'first_orbit_setup_v1'));
        await bumpSearchGlobalEpoch(tx);
        return true;
      });
      return exists ? get(origin) : null;
    },
    async complete(value, origin) {
      const created = await db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '3000ms'`);
        await tx.execute(sql`set local lock_timeout = '750ms'`);
        await tx.execute(sql`select pg_advisory_xact_lock(81923042)`);
        const [existing] = await tx.select({ key: settings.key }).from(settings).where(eq(settings.key, 'first_orbit_setup_v1')).limit(1);
        if (existing) return false;
        const id = randomUUID();
        await tx.insert(orbits).values({ id, name: value.orbit.name, slug: 'first-orbit', colorSlot: value.orbit.colorSlot, context: value.orbit.context, privacyDefaults: value.orbitDefaults });
        if (value.exclusions.length) await tx.insert(exclusionRules).values(value.exclusions.map((rule) => ({ id: randomUUID(), orbitId: rule.scope === 'orbit' ? id : null, kind: rule.kind, value: rule.value.trim().toLowerCase(), effect: rule.effect })));
        await tx.insert(settings).values({ key: 'first_orbit_setup_v1', value: { version: 1, orbitId: id, globalDefaults: value.globalDefaults, confirmedOrigin: origin } });
        await bumpSearchGlobalEpoch(tx);
        return true;
      });
      return created ? get(origin) : null;
    },
  };
}
