import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  boolean,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from 'drizzle-orm';

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  authGeneration: integer("auth_generation").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const bootstrapTokens = pgTable("bootstrap_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export const authCredentials = pgTable("auth_credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  kind: text("kind").notNull(),
  passwordHash: text("password_hash"),
  encryptedSecret: text("encrypted_secret"),
  passkeyPublicKey: text("passkey_public_key"),
  passkeyCounter: integer("passkey_counter"),
  passkeyTransports: jsonb("passkey_transports"),
  confirmed: boolean("confirmed").notNull().default(false),
  lastTotpStep: integer("last_totp_step"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const recoveryCodes = pgTable("recovery_codes", {
  codeHash: text("code_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const authChallenges = pgTable("auth_challenges", {
  id: text("id").primaryKey(),
  challengeHash: text("challenge_hash").notNull(),
  kind: text("kind").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export const orbits = pgTable('orbits', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  colorSlot: integer('color_slot').notNull(),
  context: text('context').notNull(),
  privacyDefaults: jsonb('privacy_defaults').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('orbits_slug_unique').on(table.slug),
  check('orbits_color_slot_range', sql`${table.colorSlot} between 1 and 4`),
]);

export const exclusionRules = pgTable('exclusion_rules', {
  id: text('id').primaryKey(),
  orbitId: text('orbit_id').references(() => orbits.id),
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  effect: text('effect').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('exclusion_rules_kind', sql`${table.kind} in ('account', 'sender', 'label')`),
  check('exclusion_rules_effect', sql`${table.effect} in ('no_ai', 'no_index', 'no_ai_and_no_index')`),
  uniqueIndex('exclusion_rules_unique').on(sql`coalesce(${table.orbitId}, '')`, table.kind, table.value, table.effect),
]);
