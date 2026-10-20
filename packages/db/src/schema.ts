import {
  integer,
  bigint,
  jsonb,
  pgTable,
  text,
  timestamp,
  boolean,
  check,
  uniqueIndex,
  index,
  unique,
  foreignKey,
  primaryKey,
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

// The singleton counter row serializes event IDs through transaction commit.
export const eventClock = pgTable('event_clock', {
  id: integer('id').primaryKey(),
  nextId: bigint('next_id', { mode: 'number' }).notNull().default(0),
}, (t) => [check('event_clock_singleton', sql`${t.id} = 1`)]);

export const syncEvents = pgTable('sync_events', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  kind: text('kind').notNull(),
  accountId: text('account_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('sync_events_kind', sql`${t.kind} in ('sync-progress', 'mail-changed')`)]);

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
  credentialGeneration: integer('credential_generation').notNull().default(0),
  credentialLeaseUntil: timestamp('credential_lease_until', { withTimezone: true }),
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
  reconnectAccountId: text('reconnect_account_id').references(() => accounts.id),
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
  check('audit_log_action', sql`${table.action} in ('connect_account', 'reconnect_account')`),
]);

// Mail keys include the account and provider collection at every relationship boundary.
export const syncStates = pgTable('sync_state', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull().references(() => accounts.id),
  resource: text('resource').notNull(), collectionId: text('collection_id').notNull(),
  cursor: jsonb('cursor'), generation: integer('generation').notNull().default(0),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  status: text('status').notNull().default('idle'), lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastError: text('last_error'), sequence: integer('sequence').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('sync_state_account_collection_unique').on(t.accountId, t.resource, t.collectionId),
  unique('sync_state_id_account_unique').on(t.id, t.accountId),
  check('sync_state_resource_mail', sql`${t.resource} = 'mail'`)]);

export const syncPages = pgTable('sync_pages', {
  id: text('id').primaryKey(), stateId: text('state_id').notNull().references(() => syncStates.id),
  accountId: text('account_id').notNull().references(() => accounts.id),
  pageId: text('page_id').notNull(), pageDigest: text('page_digest').notNull(), sequence: integer('sequence').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('sync_pages_replay_unique').on(t.stateId, t.pageId),
  foreignKey({ columns: [t.stateId, t.accountId], foreignColumns: [syncStates.id, syncStates.accountId] })]);

export const people = pgTable('people', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull().references(() => accounts.id),
  displayName: text('display_name').notNull(), createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('people_id_account_unique').on(t.id, t.accountId)]);

export const identities = pgTable('identities', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull().references(() => accounts.id),
  personId: text('person_id').notNull(), provider: text('provider').notNull(), kind: text('kind').notNull(),
  normalizedValue: text('normalized_value').notNull(), verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [foreignKey({ columns: [t.personId, t.accountId], foreignColumns: [people.id, people.accountId] }),
  uniqueIndex('identities_namespace_unique').on(t.accountId, t.provider, t.kind, t.normalizedValue),
  unique('identities_id_account_unique').on(t.id, t.accountId),
  check('identities_email_only', sql`${t.kind} = 'email'`)]);

export const threads = pgTable('threads', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull().references(() => accounts.id),
  collectionId: text('collection_id').notNull(), externalId: text('external_id').notNull(),
  subject: text('subject'), lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('threads_source_unique').on(t.accountId, t.collectionId, t.externalId),
  unique('threads_id_scope_unique').on(t.id, t.accountId, t.collectionId)]);

export const items = pgTable('items', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull().references(() => accounts.id),
  collectionId: text('collection_id').notNull(), threadId: text('thread_id').notNull(),
  externalId: text('external_id').notNull(), providerRevision: text('provider_revision'),
  appliedSequence: integer('applied_sequence').notNull(), direction: text('direction').notNull(),
  directionProvenance: text('direction_provenance').notNull(), fromPersonId: text('from_person_id'),
  senderIdentitiesComplete: boolean('sender_identities_complete').notNull().default(false),
  sentAt: timestamp('sent_at', { withTimezone: true }), receivedAt: timestamp('received_at', { withTimezone: true }),
  internalAt: timestamp('internal_at', { withTimezone: true }), subject: text('subject'), snippet: text('snippet'),
  bodyText: text('body_text'), bodyHtmlPath: text('body_html_path'), htmlPolicyVersion: integer('html_policy_version'),
  imageMetadata: jsonb('image_metadata'), flags: jsonb('flags').notNull().default({}),
  parseStatus: text('parse_status').notNull(), parseFailureCode: text('parse_failure_code'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('items_source_unique').on(t.accountId, t.collectionId, t.externalId),
  index('items_reader_account_thread_live_idx').on(t.accountId, t.threadId, t.deletedAt, t.internalAt, t.id),
  unique('items_id_account_unique').on(t.id, t.accountId),
  foreignKey({ columns: [t.threadId, t.accountId, t.collectionId], foreignColumns: [threads.id, threads.accountId, threads.collectionId] }),
  foreignKey({ columns: [t.fromPersonId, t.accountId], foreignColumns: [people.id, people.accountId] }),
  foreignKey({ columns: [t.bodyHtmlPath, t.accountId], foreignColumns: [blobIntents.key, blobIntents.accountId] }),
  check('items_direction', sql`${t.direction} in ('in', 'out')`),
  check('items_direction_provenance', sql`${t.directionProvenance} in ('incoming', 'provider_sent_account')`),
  check('items_parse_status', sql`${t.parseStatus} in ('supported', 'unsupported', 'deleted')`),
  check('items_parse_failure_code', sql`${t.parseFailureCode} is null or ${t.parseFailureCode} in ('input_too_large', 'limit_exceeded', 'malformed')`)]);

export const itemRecipients = pgTable('item_recipients', {
  itemId: text('item_id').notNull(), accountId: text('account_id').notNull(),
  identityId: text('identity_id').notNull(), role: text('role').notNull(),
}, (t) => [primaryKey({ columns: [t.itemId, t.identityId, t.role] }),
  foreignKey({ columns: [t.itemId, t.accountId], foreignColumns: [items.id, items.accountId] }),
  foreignKey({ columns: [t.identityId, t.accountId], foreignColumns: [identities.id, identities.accountId] }),
  check('item_recipients_role', sql`${t.role} in ('sender', 'reply_to', 'to', 'cc', 'bcc')`)]);

export const labels = pgTable('labels', {
  id: text('id').primaryKey(), accountId: text('account_id').notNull().references(() => accounts.id),
  providerRef: text('provider_ref').notNull(), name: text('name').notNull(), color: text('color'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('labels_provider_unique').on(t.accountId, t.providerRef),
  unique('labels_id_account_unique').on(t.id, t.accountId)]);

export const itemLabels = pgTable('item_labels', {
  itemId: text('item_id').notNull(), accountId: text('account_id').notNull(),
  labelId: text('label_id').notNull(), source: text('source').notNull(),
}, (t) => [primaryKey({ columns: [t.itemId, t.labelId, t.source] }),
  index('item_labels_reader_label_item_idx').on(t.labelId, t.itemId),
  foreignKey({ columns: [t.itemId, t.accountId], foreignColumns: [items.id, items.accountId] }),
  foreignKey({ columns: [t.labelId, t.accountId], foreignColumns: [labels.id, labels.accountId] }),
  check('item_labels_source', sql`${t.source} in ('provider', 'rule', 'ai', 'user')`)]);

export const itemOrbits = pgTable('item_orbits', {
  itemId: text('item_id').notNull().references(() => items.id),
  orbitId: text('orbit_id').notNull().references(() => orbits.id), reason: text('reason').notNull(),
}, (t) => [primaryKey({ columns: [t.itemId, t.orbitId, t.reason] }),
  index('item_orbits_reader_orbit_item_idx').on(t.orbitId, t.itemId),
  check('item_orbits_reason', sql`${t.reason} in ('account', 'rule', 'person', 'org')`)]);

export const blobIntents = pgTable('blob_intents', {
  key: text('key').primaryKey(), accountId: text('account_id').notNull().references(() => accounts.id),
  stateId: text('state_id').notNull().references(() => syncStates.id),
  pageId: text('page_id').notNull(), leaseGeneration: integer('lease_generation').notNull(),
  credentialGeneration: integer('credential_generation').notNull(), expectedSequence: integer('expected_sequence').notNull(),
  state: text('state').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  committedAt: timestamp('committed_at', { withTimezone: true }),
}, (t) => [check('blob_intents_state', sql`${t.state} in ('pending', 'referenced', 'delete_pending')`),
  foreignKey({ columns: [t.stateId, t.accountId], foreignColumns: [syncStates.id, syncStates.accountId] }),
  unique('blob_intents_key_account_unique').on(t.key, t.accountId)]);

export const attachments = pgTable('attachments', {
  id: text('id').primaryKey(), itemId: text('item_id').notNull(), accountId: text('account_id').notNull(),
  ordinal: integer('ordinal').notNull(), filename: text('filename'), mimeType: text('mime_type').notNull(),
  disposition: text('disposition'), contentId: text('content_id'), related: boolean('related').notNull().default(false),
  size: integer('size').notNull(), storagePath: text('storage_path').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('attachments_item_ordinal_unique').on(t.itemId, t.ordinal),
  foreignKey({ columns: [t.itemId, t.accountId], foreignColumns: [items.id, items.accountId] }),
  foreignKey({ columns: [t.storagePath, t.accountId], foreignColumns: [blobIntents.key, blobIntents.accountId] })]);
