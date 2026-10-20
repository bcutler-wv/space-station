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

export const oauthApps = pgTable('oauth_apps', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  clientId: text('client_id').notNull(),
  encryptedClientSecret: text('encrypted_client_secret').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [check('oauth_apps_provider', sql`${table.provider} in ('google')`)]);

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  appId: text('app_id').notNull().references(() => oauthApps.id),
  orbitId: text('orbit_id').notNull().references(() => orbits.id),
  email: text('email').notNull(),
  encryptedRefreshToken: text('encrypted_refresh_token').notNull(),
  encryptedAccessToken: text('encrypted_access_token').notNull(),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  grantedScopes: text('granted_scopes').array().notNull(),
  backfill: text('backfill'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('accounts_provider_email_unique').on(table.provider, sql`lower(${table.email})`),
  check('accounts_provider', sql`${table.provider} in ('google')`),
  check('accounts_backfill_choice', sql`${table.backfill} is null or ${table.backfill} in ('30_days', '1_year', 'all')`),
]);

export const oauthAttempts = pgTable('oauth_attempts', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  appId: text('app_id').notNull().references(() => oauthApps.id),
  stateHash: text('state_hash').notNull(),
  sessionHash: text('session_hash').notNull(),
  authGeneration: integer('auth_generation').notNull(),
  encryptedVerifier: text('encrypted_verifier').notNull(),
  encryptedCode: text('encrypted_code'),
  status: text('status').notNull().default('started'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('oauth_attempt_state_unique').on(table.stateHash),
  check('oauth_attempt_provider', sql`${table.provider} in ('google')`),
  check('oauth_attempt_status', sql`${table.status} in ('started', 'returned', 'claimed', 'completed', 'failed')`),
]);

export const auditLog = pgTable('audit_log', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').notNull().references(() => users.id),
  action: text('action').notNull(),
  targetId: text('target_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('audit_log_action', sql`${table.action} in ('connect_account')`),
]);
