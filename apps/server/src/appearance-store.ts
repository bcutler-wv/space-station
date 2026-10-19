import { settings, type openDatabase } from "@station/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { appearanceResponseSchema } from "@station/shared";
import {
  defaultAppearance,
  type AppearanceStore,
  type StoredAppearance,
} from "./appearance.js";

const storedSchema = appearanceResponseSchema.extend({
  wallpaper: z.string().max(1_000_000).nullable(),
});
type Database = ReturnType<typeof openDatabase>["db"];

export function databaseAppearanceStore(db: Database): AppearanceStore {
  return {
    async get() {
      const [row] = await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "appearance"))
        .limit(1);
      return row ? storedSchema.parse(row.value) : defaultAppearance;
    },
    async patch(value: Partial<StoredAppearance>) {
      await db
        .insert(settings)
        .values({ key: "appearance", value: defaultAppearance })
        .onConflictDoNothing();
      const [row] = await db
        .update(settings)
        .set({
          value: sql`${settings.value} || ${JSON.stringify(value)}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(settings.key, "appearance"))
        .returning({ value: settings.value });
      return storedSchema.parse(row?.value);
    },
  };
}
