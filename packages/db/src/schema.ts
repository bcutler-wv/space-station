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

// M2 search desired-state ledger. Operational rows deliberately outlive source rows.
export const searchEpochs = pgTable('search_epochs', {
  scope: text('scope').primaryKey(),
  epoch: integer('epoch').notNull().default(1),
  sweepTarget: integer('sweep_target').notNull().default(1),
  sweepTargetGlobal: integer('sweep_target_global').notNull().default(1),
  sweepCursorAccount: text('sweep_cursor_account'),
  sweepCursorItem: text('sweep_cursor_item'),
  sweepFinishedEpoch: integer('sweep_finished_epoch').notNull().default(0),
  sweepFinishedGlobal: integer('sweep_finished_global').notNull().default(0),
  physicalProfile: text('physical_profile'),
}, (t) => [
  check('search_epochs_positive', sql`${t.epoch} > 0 and ${t.sweepTarget} > 0 and ${t.sweepTargetGlobal} > 0 and ${t.sweepFinishedEpoch} >= 0 and ${t.sweepFinishedGlobal} >= 0`),
  check('search_epochs_cursor_pair', sql`(${t.sweepCursorAccount} is null) = (${t.sweepCursorItem} is null)`),
  check('search_epochs_scope_bound', sql`length(${t.scope}) <= 64`),
]);

// Permanent disabled gate. Future publisher phases lock this row before epochs.
export const searchGenerationControl = pgTable('search_generation_control', {
  singleton: integer('singleton').primaryKey().default(1),
  revision: integer('revision').notNull().default(1),
  stage: text('stage').notNull().default('disabled'),
  transitionToken: text('transition_token'),
  sourceGenerationToken: text('source_generation_token').references(() => searchGenerationHistory.generationToken),
  generationToken: text('generation_token'),
  physicalIndex: text('physical_index'),
  indexUuid: text('index_uuid'),
  profileId: text('profile_id'),
  publicationEnabled: boolean('publication_enabled').notNull().default(false),
  servingReady: boolean('serving_ready').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('search_generation_singleton', sql`${t.singleton} = 1`),
  check('search_generation_revision_positive', sql`${t.revision} > 0`),
  check('search_generation_disabled_p1', sql`${t.publicationEnabled} = false and ${t.servingReady} = false`),
  check('search_generation_stage', sql`${t.stage} in ('disabled', 'disabled_intent', 'create_requested', 'uuid_bound', 'writer_role_requested', 'writer_role_attested', 'writer_mapping_requested', 'writer_attested', 'query_role_requested', 'query_role_attested', 'query_mapping_requested', 'roles_attested', 'unavailable')`),
  check('search_generation_identity_pair', sql`(${t.generationToken} is null and ${t.physicalIndex} is null and ${t.profileId} is null and ${t.indexUuid} is null) or
    (${t.generationToken} is not null and ${t.physicalIndex} is not null and ${t.profileId} is not null and ${t.profileId} = 'station-mail-v2')`),
  check('search_generation_intent_bound', sql`${t.stage} <> 'disabled_intent' or
    (${t.transitionToken} is not null and ${t.generationToken} is not null and ${t.physicalIndex} is not null)`),
  check('search_generation_identity_bounds', sql`(${t.transitionToken} is null or length(${t.transitionToken}) between 1 and 128) and
    (${t.generationToken} is null or length(${t.generationToken}) between 1 and 128) and
    (${t.physicalIndex} is null or length(${t.physicalIndex}) between 1 and 128) and
    (${t.indexUuid} is null or length(${t.indexUuid}) between 1 and 128)`),
]);

// Names and tokens remain reserved after abort or retirement.
export const searchGenerationHistory = pgTable('search_generation_history', {
  generationToken: text('generation_token').primaryKey(),
  physicalIndex: text('physical_index').notNull().unique(),
  profileId: text('profile_id').notNull(),
  indexUuid: text('index_uuid').unique(),
  lifecycle: text('lifecycle').notNull().default('reserved'),
  writerRole: text('writer_role').unique(),
  queryRole: text('query_role').unique(),
  writerPrincipal: text('writer_principal').unique(),
  queryPrincipal: text('query_principal').unique(),
  writerCertFingerprint: text('writer_cert_fingerprint'),
  queryCertFingerprint: text('query_cert_fingerprint'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('search_generation_history_profile', sql`(${t.generationToken} = 'legacy-v1' and ${t.physicalIndex} = 'station-mail-v1' and ${t.profileId} = 'station-mail-v1') or (${t.generationToken} <> 'legacy-v1' and ${t.profileId} = 'station-mail-v2' and ${t.physicalIndex} ~ '^station-mail-v2-g[a-z0-9]{16,64}$')`),
  check('search_generation_history_lifecycle', sql`${t.lifecycle} in ('reserved', 'bound', 'roles_attested', 'retired_retained', 'abandoned', 'unavailable')`),
  check('search_generation_history_uuid', sql`(${t.lifecycle} = 'reserved' and ${t.indexUuid} is null) or (${t.lifecycle} in ('bound', 'roles_attested', 'retired_retained') and ${t.indexUuid} is not null) or ${t.lifecycle} in ('abandoned', 'unavailable')`),
  check('search_generation_history_identity', sql`(${t.generationToken} = 'legacy-v1' and ${t.writerRole} is null and ${t.queryRole} is null and ${t.writerPrincipal} is null and ${t.queryPrincipal} is null) or (${t.generationToken} <> 'legacy-v1' and ${t.writerRole} is not null and ${t.queryRole} is not null and ${t.writerPrincipal} is not null and ${t.queryPrincipal} is not null)`),
  check('search_generation_history_v2_token', sql`${t.generationToken} = 'legacy-v1' or ${t.generationToken} ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`),
  check('search_generation_history_names', sql`${t.generationToken} = 'legacy-v1' or (${t.writerRole} = 'station_indexer_' || lower(replace(${t.generationToken}, '-', '')) and ${t.queryRole} = 'station_query_' || lower(replace(${t.generationToken}, '-', '')) and ${t.writerPrincipal} = 'station-search-indexer-' || lower(replace(${t.generationToken}, '-', '')) and ${t.queryPrincipal} = 'station-search-query-' || lower(replace(${t.generationToken}, '-', '')))`),
  check('search_generation_history_fingerprints', sql`(${t.writerCertFingerprint} is null or ${t.writerCertFingerprint} ~ '^[0-9a-f]{64}$') and (${t.queryCertFingerprint} is null or ${t.queryCertFingerprint} ~ '^[0-9a-f]{64}$')`),
  check('search_generation_history_index_uuid_bound', sql`${t.indexUuid} is null or ${t.indexUuid} ~ '^[A-Za-z0-9_-]{1,128}$'`),
  check('search_generation_history_attestation', sql`${t.generationToken} = 'legacy-v1' or ${t.lifecycle} not in ('roles_attested', 'retired_retained') or (${t.writerCertFingerprint} is not null and ${t.queryCertFingerprint} is not null)`),
  check('search_generation_history_bounds', sql`length(${t.generationToken}) between 1 and 128 and length(${t.physicalIndex}) between 1 and 128`),
]);

export const searchGenerationDispatch = pgTable('search_generation_dispatch', {
  generationToken: text('generation_token').notNull().references(() => searchGenerationHistory.generationToken),
  operation: text('operation').notNull(),
  dispatchId: text('dispatch_id').notNull().unique(),
  ownerId: text('owner_id').notNull(),
  target: text('target').notNull(),
  bodyIdentity: text('body_identity').notNull(),
  state: text('state').notNull().default('armed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.generationToken, t.operation] }),
  check('search_generation_dispatch_operation', sql`${t.operation} in ('create_index', 'writer_role', 'writer_mapping', 'query_role', 'query_mapping')`),
  check('search_generation_dispatch_state', sql`${t.state} in ('armed', 'sent_unknown', 'response_confirmed', 'quiesced')`),
  check('search_generation_dispatch_bounds', sql`length(${t.dispatchId}) between 1 and 128 and length(${t.ownerId}) between 1 and 128 and length(${t.target}) between 1 and 128 and length(${t.bodyIdentity}) between 1 and 128`),
]);

export const searchDocuments = pgTable('search_documents', {
  accountId: text('account_id').notNull(),
  itemId: text('item_id').notNull(),
  documentId: text('document_id').notNull(),
  desiredRevision: integer('desired_revision').notNull().default(1),
  desiredState: text('desired_state').notNull().default('dirty'),
  globalEpoch: integer('global_epoch').notNull().default(0),
  accountEpoch: integer('account_epoch').notNull().default(0),
  sourceSequence: integer('source_sequence'),
  actionEpoch: integer('action_epoch'),
  observedActionEpoch: integer('observed_action_epoch'),
  observedAuthorizationGeneration: integer('observed_authorization_generation'),
  authorizationGeneration: integer('authorization_generation'),
  sourceParseStatus: text('source_parse_status'),
  sourceDeleted: boolean('source_deleted'),
  acknowledgedRevision: integer('acknowledged_revision'),
  acknowledgedGlobalEpoch: integer('acknowledged_global_epoch'),
  acknowledgedAccountEpoch: integer('acknowledged_account_epoch'),
  acknowledgedGenerationToken: text('acknowledged_generation_token'),
  acknowledgedDisposition: text('acknowledged_disposition'),
  claimToken: text('claim_token'),
  claimUntil: timestamp('claim_until', { withTimezone: true }),
  retryCount: integer('retry_count').notNull().default(0),
  retryAt: timestamp('retry_at', { withTimezone: true }),
  errorCode: text('error_code'),
}, (t) => [
  primaryKey({ columns: [t.accountId, t.itemId] }),
  uniqueIndex('search_documents_document_id_unique').on(t.documentId),
  index('search_documents_dirty_idx').on(t.desiredState, t.accountId, t.itemId),
  check('search_documents_revision_positive', sql`${t.desiredRevision} > 0 and (${t.acknowledgedRevision} is null or ${t.acknowledgedRevision} > 0 and ${t.acknowledgedRevision} <= ${t.desiredRevision})`),
  check('search_documents_ack_complete', sql`(${t.acknowledgedRevision} is null and ${t.acknowledgedGlobalEpoch} is null and ${t.acknowledgedAccountEpoch} is null and ${t.acknowledgedGenerationToken} is null and ${t.acknowledgedDisposition} is null) or
    (${t.acknowledgedRevision} is not null and ${t.acknowledgedGlobalEpoch} is not null and ${t.acknowledgedGlobalEpoch} > 0 and
      ${t.acknowledgedAccountEpoch} is not null and ${t.acknowledgedAccountEpoch} > 0 and ${t.acknowledgedGenerationToken} is not null and
      ${t.acknowledgedDisposition} is not null and ${t.acknowledgedDisposition} in ('live', 'fence'))`),
  check('search_documents_ack_token_bound', sql`${t.acknowledgedGenerationToken} is null or length(${t.acknowledgedGenerationToken}) between 1 and 128`),
  check('search_documents_state', sql`${t.desiredState} in ('dirty', 'eligible', 'purge')`),
  check('search_documents_retry_nonnegative', sql`${t.retryCount} >= 0`),
  check('search_documents_operational_bounds', sql`length(${t.accountId}) <= 64 and length(${t.itemId}) <= 64 and length(${t.documentId}) <= 128 and (${t.errorCode} is null or length(${t.errorCode}) <= 32) and (${t.claimToken} is null or length(${t.claimToken}) <= 128)`),
]);

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
  authorizationGeneration: integer('authorization_generation').notNull().default(1),
  credentialLeaseUntil: timestamp('credential_lease_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('accounts_provider_email_unique').on(table.provider, sql`lower(${table.email})`),
  check('accounts_provider', sql`${table.provider} in ('google')`),
  check('accounts_authorization_generation_positive', sql`${table.authorizationGeneration} > 0`),
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
  check('audit_log_action', sql`${table.action} in ('connect_account', 'reconnect_account', 'send_requested', 'send_succeeded', 'send_unknown', 'send_failed', 'send_reconciled', 'mail_change_requested', 'mail_change_confirmed', 'mail_change_observed', 'mail_change_unknown', 'mail_change_failed')`),
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
  actionEpoch: integer('action_epoch').notNull().default(0),
  observedActionEpoch: integer('observed_action_epoch'),
  observedCredentialGeneration: integer('observed_credential_generation'),
  observedAuthorizationGeneration: integer('observed_authorization_generation'),
  directionProvenance: text('direction_provenance').notNull(), fromPersonId: text('from_person_id'),
  senderIdentitiesComplete: boolean('sender_identities_complete').notNull().default(false),
  senderHeaderCount: integer('sender_header_count').notNull().default(0),
  replyToHeaderCount: integer('reply_to_header_count').notNull().default(0),
  replyToIdentitiesComplete: boolean('reply_to_identities_complete').notNull().default(false),
  sentAt: timestamp('sent_at', { withTimezone: true }), receivedAt: timestamp('received_at', { withTimezone: true }),
  internalAt: timestamp('internal_at', { withTimezone: true }), subject: text('subject'), snippet: text('snippet'),
  messageId: text('message_id'), inReplyTo: text('in_reply_to'), referencesHeader: text('references_header'),
  replyMetadata: jsonb('reply_metadata'),
  bodyText: text('body_text'), bodyHtmlPath: text('body_html_path'), htmlPolicyVersion: integer('html_policy_version'),
  imageMetadata: jsonb('image_metadata'), flags: jsonb('flags').notNull().default({}),
  parseStatus: text('parse_status').notNull(), parseFailureCode: text('parse_failure_code'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('items_source_unique').on(t.accountId, t.collectionId, t.externalId),
  index('items_reader_account_thread_live_idx').on(t.accountId, t.threadId, t.deletedAt, t.internalAt, t.id),
  index('items_observation_refresh_idx').on(t.accountId, t.collectionId, t.id)
    .where(sql`${t.deletedAt} is null and ${t.parseStatus} = 'supported'`),
  index('items_search_reconcile_idx').on(t.accountId, t.id),
  unique('items_id_account_unique').on(t.id, t.accountId),
  foreignKey({ columns: [t.threadId, t.accountId, t.collectionId], foreignColumns: [threads.id, threads.accountId, threads.collectionId] }),
  foreignKey({ columns: [t.fromPersonId, t.accountId], foreignColumns: [people.id, people.accountId] }),
  foreignKey({ columns: [t.bodyHtmlPath, t.accountId], foreignColumns: [blobIntents.key, blobIntents.accountId] }),
  check('items_direction', sql`${t.direction} in ('in', 'out')`),
  check('items_direction_provenance', sql`${t.directionProvenance} in ('incoming', 'provider_sent_account')`),
  check('items_action_epoch', sql`${t.actionEpoch} >= 0 and (${t.observedActionEpoch} is null or (${t.observedActionEpoch} >= 0 and ${t.observedActionEpoch} <= ${t.actionEpoch}))`),
  check('items_observation_pair', sql`(${t.observedActionEpoch} is null) = (${t.observedCredentialGeneration} is null)`),
  // Historical observations remain NULL after migration; no old grant is inferred.
  check('items_authorization_observation', sql`${t.observedAuthorizationGeneration} is null or
    (${t.observedActionEpoch} is not null and ${t.observedCredentialGeneration} is not null)`),
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

export const mailImageConsent = pgTable('mail_image_consent', {
  itemId: text('item_id').primaryKey(), accountId: text('account_id').notNull(),
  sourceDigest: text('source_digest').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [foreignKey({ columns: [t.itemId, t.accountId], foreignColumns: [items.id, items.accountId] })]);

export const mailSenderImagePreferences = pgTable('mail_sender_image_preferences', {
  accountId: text('account_id').notNull().references(() => accounts.id),
  senderAddress: text('sender_address').notNull(), enabled: boolean('enabled').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.accountId, t.senderAddress] })]);

export const drafts = pgTable('drafts', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => users.id),
  accountId: text('account_id').notNull().references(() => accounts.id),
  orbitId: text('orbit_id').references(() => orbits.id),
  threadId: text('thread_id'), threadCollectionId: text('thread_collection_id'), parentItemId: text('parent_item_id'),
  creationKey: text('creation_key').notNull(),
  creationDigest: text('creation_digest').notNull(),
  to: jsonb('to').notNull().default([]), cc: jsonb('cc').notNull().default([]), bcc: jsonb('bcc').notNull().default([]),
  subject: text('subject').notNull().default(''), bodyText: text('body_text').notNull().default(''),
  attachmentRefs: jsonb('attachment_refs').notNull().default([]),
  revision: integer('revision').notNull().default(1), state: text('state').notNull().default('editing'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('drafts_creation_unique').on(t.ownerId, t.creationKey),
  index('drafts_list_idx').on(t.ownerId, t.accountId, t.updatedAt, t.id),
  foreignKey({ columns: [t.threadId, t.accountId, t.threadCollectionId], foreignColumns: [threads.id, threads.accountId, threads.collectionId] }),
  foreignKey({ columns: [t.parentItemId, t.accountId], foreignColumns: [items.id, items.accountId] }),
  check('drafts_revision_positive', sql`${t.revision} > 0`),
  check('drafts_state', sql`${t.state} in ('editing', 'discarded', 'sending', 'sent')`),
]);

// A committed row reserves the private MIME key before publication. Only a
// ready, pending row may be claimed for the one provider call.
export const outboundOperations = pgTable('outbound_operations', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => users.id),
  draftId: text('draft_id').notNull().references(() => drafts.id),
  accountId: text('account_id').notNull().references(() => accounts.id),
  orbitId: text('orbit_id').references(() => orbits.id),
  idempotencyKey: text('idempotency_key').notNull(), requestDigest: text('request_digest').notNull(),
  draftRevision: integer('draft_revision').notNull(), state: text('state').notNull().default('pending'),
  blobKey: text('blob_key').notNull().unique(), blobReady: boolean('blob_ready').notNull().default(false),
  attachmentRefs: jsonb('attachment_refs').notNull().default([]),
  blobCollectedAt: timestamp('blob_collected_at', { withTimezone: true }),
  mimeDigest: text('mime_digest'), mimeBytes: integer('mime_bytes'),
  messageId: text('message_id').notNull(), fromAddress: text('from_address').notNull(),
  recipientAddresses: jsonb('recipient_addresses').notNull(),
  providerThreadId: text('provider_thread_id'), providerResultId: text('provider_result_id'),
  credentialGeneration: integer('credential_generation'),
  attemptCount: integer('attempt_count').notNull().default(0), lastError: text('last_error'),
  userActionAt: timestamp('user_action_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('outbound_operations_key_unique').on(t.ownerId, t.idempotencyKey),
  index('outbound_operations_state_idx').on(t.state, t.updatedAt),
  check('outbound_operations_state', sql`${t.state} in ('pending', 'in_flight', 'succeeded', 'failed', 'outcome_unknown')`),
  check('outbound_operations_attempt', sql`${t.attemptCount} >= 0 and ${t.attemptCount} <= 1`),
  check('outbound_operations_mime_size', sql`${t.mimeBytes} is null or (${t.mimeBytes} >= 0 and ${t.mimeBytes} <= 12582912)`),
]);

// Message changes have no draft or MIME. A claimed operation is never replayed.
export const mailChangeOperations = pgTable('mail_change_operations', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => users.id),
  accountId: text('account_id').notNull().references(() => accounts.id),
  orbitId: text('orbit_id').references(() => orbits.id),
  itemId: text('item_id').notNull(), externalId: text('external_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(), requestDigest: text('request_digest').notNull(),
  action: text('action').notNull(), addLabels: text('add_labels').array().notNull().default([]),
  removeLabels: text('remove_labels').array().notNull().default([]),
  itemRevision: text('item_revision'), itemSequence: integer('item_sequence').notNull(),
  credentialGeneration: integer('credential_generation'),
  state: text('state').notNull().default('pending'),
  confirmation: text('confirmation'), attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'), userActionAt: timestamp('user_action_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ columns: [t.itemId, t.accountId], foreignColumns: [items.id, items.accountId] }),
  uniqueIndex('mail_change_operations_key_unique').on(t.ownerId, t.idempotencyKey),
  index('mail_change_operations_discovery_idx').on(t.ownerId, t.accountId, t.userActionAt, t.id),
  index('mail_change_operations_item_idx').on(t.itemId, t.itemSequence),
  check('mail_change_operations_action', sql`${t.action} in ('archive', 'mark_read', 'mark_unread', 'add_label', 'remove_label')`),
  check('mail_change_operations_state', sql`${t.state} in ('pending', 'in_flight', 'outcome_unknown', 'succeeded', 'failed')`),
  check('mail_change_operations_confirmation', sql`${t.confirmation} is null or ${t.confirmation} in ('provider', 'observed')`),
  check('mail_change_operations_attempt', sql`${t.attemptCount} >= 0 and ${t.attemptCount} <= 1`),
]);

// Draft-owned blobs have no sync page or provider lease. A pending row is a
// durable reservation; publication and collection serialize on this row.
export const draftAttachments = pgTable('draft_attachments', {
  id: text('id').primaryKey(),
  draftId: text('draft_id').notNull().references(() => drafts.id),
  accountId: text('account_id').notNull().references(() => accounts.id),
  blobKey: text('blob_key').notNull().unique(),
  uploadKey: text('upload_key').notNull(),
  digest: text('digest').notNull(),
  filename: text('filename').notNull(),
  byteSize: integer('byte_size').notNull(),
  state: text('state').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('draft_attachments_upload_unique').on(t.draftId, t.uploadKey),
  index('draft_attachments_collect_idx').on(t.state, t.updatedAt),
  check('draft_attachments_state', sql`${t.state} in ('pending', 'ready', 'delete_pending')`),
  check('draft_attachments_size', sql`${t.byteSize} >= 0 and ${t.byteSize} <= 8388608`),
]);
