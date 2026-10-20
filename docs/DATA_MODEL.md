# Data model

PostgreSQL with Drizzle. This lists the tables and the fields that matter. Future mutable domain tables use `created_at` and `updated_at`. M0.4 authentication records instead carry purpose-specific timestamps: owner and credentials have `created_at`; bootstrap tokens and challenges have `expires_at` and `consumed_at`; recovery codes have `used_at`; sessions have `created_at`, `last_seen_at`, and `revoked_at`. These timestamps record security events and expiry without an ambiguous blanket `updated_at`. M1.2a adds Google authorization records. M1.3 persistence adds normalized mail tables and a worker page transaction; provider sync and reading are separate tasks.

## Identity and settings

| Table | Key fields |
|---|---|
| `users` | id, display_name, auth_generation, created_at. v1 has exactly one row. Credential replacement atomically increments `auth_generation`; any session or pending login from an older generation is invalid. |
| `auth_credentials` | id, user_id, kind (passkey, password, totp), password_hash (Argon2id only for password), encrypted_secret (TOTP only), passkey_public_key and counter (passkey only), created_at |
| `recovery_codes` | user_id, code_hash, used_at. Show once during enrollment; never store plaintext. |
| `sessions` | token_hash, data (server-side session payload), created_at, last_seen_at, revoked_at. The opaque cookie token is never stored. The adapter enforces 30-minute idle and seven-day absolute expiry using these timestamps; session payloads bind the current owner auth generation and distinguish restricted recovery from full login. Rotate after login and privilege changes. |
| `bootstrap_tokens` | token_hash, expires_at, consumed_at. Local CLI issues one short-lived token; owner creation consumes it in the same transaction. |
| `auth_challenges` | id, challenge_hash, kind, expires_at, consumed_at. WebAuthn challenges expire after five minutes and can be consumed once. |
| `settings` | key, value (jsonb). Theme mode, seed color, confidence thresholds, AI budgets. M0.3 stores a bounded normalized WebP wallpaper in the `appearance` value; a later private file store may replace the embedded image. |
| `first_orbit_setup_v1` settings row | Versioned completion marker, first Orbit ID, configured origin confirmation and global indexing/AI defaults. Written in the same transaction as the first Orbit and exclusions. Later account connection and sync require this marker. |

## Orbits and accounts

| Table | Key fields |
|---|---|
| `orbits` | M1.1: id, name, unique slug, color_slot, context, privacy_defaults (jsonb), created_at, updated_at. Later Orbit management adds icon, shortcut_key and sort_order. |
| `accounts` | id, provider (`google`), app_id, orbit_id, normalized email, encrypted_refresh_token, encrypted_access_token, access_token_expires_at, granted_scopes (text[]), nullable backfill (`30_days`, `1_year`, `all`), revoked_at, credential_generation, credential_lease_until, created_at, updated_at. Unique by provider and case-insensitive email. A confirmed reconnection replaces encrypted credentials on the same row, increments the generation, and preserves the Orbit and backfill choice. `revoked_at` records a permanent refresh or scope failure that needs reconnection. Future provider/kind, display, status and Slack fields remain planned. |
| `oauth_apps` | M1.2a: id, provider (`google`), owner_id, client_id, encrypted_client_secret, exact redirect_uri, created_at, updated_at. Future Microsoft/Slack providers and client-secret expiry fields remain planned. |
| `oauth_attempts` | id, provider (`google`), app_id, unique SHA-256 state_hash, initiating session_hash, auth_generation, encrypted_verifier, nullable encrypted_code, nullable reconnect_account_id, status (`started`, `returned`, `claimed`, `completed`, `failed`), expires_at, created_at, updated_at. The ten-minute callback/confirmation window is single-use. A reconnect target is fixed before redirect and cannot be changed at confirmation. Three active attempts per owner session are allowed. Terminal failures clear temporary ciphertext; periodic/start cleanup deletes expired attempts and app rows without a linked account. |
| `sync_state` | id, account_id, resource, collection_id, cursor, generation, lease_until, sequence, status, last_success_at, last_error. Unique per source collection. |
| `sync_pages` | state_id, account_id, stable page_id, content digest, sequence, applied_at. Unique by state/page ID for replay. |
| `sync_runs` | id, sync_state_id, started_at, finished_at, status, retry_count, error_class, cursor_before, cursor_after |
| `routing_rules` | id, orbit_id, match (jsonb: person, org, domain, label, keyword) |
| `exclusion_rules` | M1.1: id, nullable orbit_id (null means global), kind (account, sender, label), normalized exact value, effect (no_ai, no_index, no_ai_and_no_index), created_at, updated_at. |

M1.1 implements `orbits` with name, unique slug, color slot, context and privacy defaults, and `exclusion_rules` with nullable Orbit FK for global scope, exact match kind/value, effect, timestamps and a uniqueness constraint. Exact account and sender values are full email addresses; labels use their whole provider label name. Matching is case-insensitive after normalization. The account Orbit and every routed Orbit must be present in policy evaluation; an item with no Orbit membership or missing Orbit policy is denied indexing and AI. M1.2a adds the Google account authorization backend and persists a backfill choice without starting a sync job. The owner-facing connection and backfill UI follows in M1.2b; actual content sync follows in M1.3. No derived data exists yet, so deletion/invalidation jobs are not claimed here.

Every M1.2a reversible secret field uses a versioned AES-256-GCM envelope. A random per-value data key encrypts the value and is wrapped by the station master key. Both layers authenticate version and table/record/field context, so a ciphertext cannot be moved to a different row or purpose. Client IDs, email addresses, granted scope names and audit targets are metadata, not reversible credentials. Losing the master key makes encrypted Google grants unreadable and requires account reconnection.

An account belongs to exactly one Orbit. An item can appear in several Orbits through `item_orbits`, which combines the account's Orbit with routing rules and people or org assignments.

Global exclusions and every matching Orbit's AI/index policy compose by **most restrictive effect**. Routing changes and tightened policy enqueue invalidation of affected search documents, embeddings, extracted attachment text, AI outputs, summaries, briefings, and citation caches before new retrieval. Keep source records if permitted for ordinary mail/calendar use; erase prohibited derived records and rebuild only when policy allows. See SECURITY.md.

## People and organizations

| Table | Key fields |
|---|---|
| `people` | M1.3: id, account_id, display_name, timestamps. Organization and manual merging follow in M3. |
| `identities` | M1.3: id, account_id, person_id, provider, kind (`email`), normalized_value, verified_at. Unique within provider/account. Different accounts never merge automatically. |
| `orgs` | id, name, domains (text[]), primary_orbit_id |
| `aliases` | entity_kind, entity_id, alias. "the sand supplier" points at an org. |

Identity resolution matches by email address automatically. Anything else is merged by the user, or proposed by extraction and approved in the review tray.

## Messages

| Table | Key fields |
|---|---|
| `threads` | M1.3: id, account_id, collection_id, external_id, subject, last_activity_at. Unique by account, collection, external ID. Other kinds follow their connector milestones. |
| `items` | M1.3: id, account_id, collection_id, thread_id, external_id, opaque text provider_revision, applied_sequence, direction/provenance, from_person_id, untrusted header sent_at, provider internal_at, received_at, subject, snippet, body_text, body_html_path, HTML policy version and image metadata, sender-identity completeness, flags, parse status/failure code, deleted_at. Unique by account, collection, external ID. Bulk and extraction follow later. |
| `item_recipients` | M1.3: item_id, account_id, identity_id, role (sender, reply_to, to, cc, bcc). Every parsed sender identity is retained. Composite foreign keys enforce the same account. |
| `item_orbits` | item_id, orbit_id, reason (account, rule, person, org) |
| `labels` | id, account_id, name, color, provider_ref |
| `item_labels` | item_id, label_id, source (provider, rule, ai, user) |
| `attachments` | M1.3: id, item_id, account_id, ordinal, safe display filename, mime_type, disposition, content_id, related flag, size, storage_path. Extraction and OCR follow later. |
| `blob_intents` | M1.3: generated key, account and page owner/fence, pending/referenced/delete_pending state, timestamps. Durable ownership exists before immutable publication. |
| `item_chunks` | item_id, chunk_index, text, embedding (vector) |
| `drafts` | id, account_id, thread_id, provider_draft_id, to/cc/bcc, subject, body, attachment_refs, revision, state (editing, queued, sent, discarded), updated_at |
| `outbound_operations` | id, draft_id, account_id, kind, idempotency_key, state (pending, in_flight, succeeded, failed, outcome_unknown), provider_request_id, provider_result_id, attempt_count, last_error, user_action_at, completed_at. Unique idempotency key. |

HTML bodies are stored as files, not in the database, and are always sanitized again at render time.
The M1 reader uses account-scoped item IDs and account/Orbit membership, not provider IDs, for browser lookups. Its conversation subject, snippet, activity and count come from visible, nondeleted items in the requested scope. A label filter narrows the list and its summaries to matching items; opening a conversation shows all live messages in its account/Orbit scope. Account label lists include empty provider labels. Orbit label lists include labels on live items routed into that Orbit, including labels owned by another account. Read indexes on live account/thread items, label membership and Orbit membership support these lookups. The browser receives no blob key or source image URL.
The private file store uses random immutable keys (`b_` followed by 64 lowercase hex characters) for `body_html_path` and `storage_path`; filenames and provider IDs never become paths. M1.3 page application commits each blob intent before writing, holds its row lock while publishing, then locks and checks the intent and file inside the page transaction before referencing it. Temporary names include the intent key. The bounded collector skips pending intents while their owning lease and fences remain live, locks stale intents, checks item and attachment references, then deletes the published and temporary files. Tombstones remove read eligibility and references in the page transaction; physical deletion is retryable later. Collector scheduling belongs to the later sync runner task.

The page application caps an entire prepared page at 24 MiB and 100,000 structural nodes before schema cloning, hashing, database access, or staging. Cursor JSON is limited to 16 KiB, 256 nodes, and depth eight; each item has at most 32 flags. A page ID binds the cursor and source changes through a digest. Random HTML image reference IDs are canonicalized by image order while the safe image destinations and attachment bytes remain bound. `received_at` records local observation time and is excluded from replay identity; `internal_at` is stable provider metadata and participates. An unresolved label name clears the shared label resolution and denies indexing and AI until a later resolved update. Crashed temporary files use one deterministic name per intent key, so cleanup addresses that file directly without a directory scan.

## Calendar

| Table | Key fields |
|---|---|
| `calendars` | id, account_id, external_id, name, timezone, color_slot, selected, sync_enabled. Unique by account and external ID. |
| `events` | id, calendar_id, external_id, provider_revision, title, starts_at, ends_at, start_timezone, end_timezone, all_day, all_day_end_exclusive, location, conference_url, organizer_person_id, status, recurrence_rule, recurrence_master_id, original_occurrence_start, deleted_at. Unique by calendar and external ID. Store UTC instants plus IANA time zones; preserve local dates for all-day events. |
| `event_exceptions` | id, master_event_id, original_occurrence_start, replacement_event_id, cancelled. Unique by master and original occurrence. |
| `event_attendees` | event_id, person_id, response |
| `calendar_actions` | id, event_id, account_id, outbound_operation_id, action (create, update, delete), actor_kind (user, provider, external), provider_actor_id, observed_at, provenance (jsonb), verified_user_action. Invitation sync is never verified_user_action. |
| `meeting_briefs` | event_id, content (jsonb, see AI.md), generated_at, model, prompt_version |

## AI outputs

| Table | Key fields |
|---|---|
| `extractions` | item_id, model, prompt_version, output (jsonb), created_at |
| `proposals` | id, kind (task_create, task_change, new_tag, entity_merge, event, reply_draft), payload (jsonb), source_item_ids, confidence, status (pending, approved, dismissed), decided_at |
| `promises` | id, kind (mine, theirs), text, person_ids, due_at, evidence (jsonb span), status (open, kept, late, cancelled), task_id |
| `briefings` | date, content (jsonb), model, prompt_version |
| `ai_usage` | day, feature, provider, model, input_tokens, output_tokens, estimated_cost |

## Tasks

See [TASKS.md](TASKS.md) for behavior.

| Table | Key fields |
|---|---|
| `tasks` | id, title, notes, status (todo, doing, done, canceled), scheduled_on, due_on, priority, origin_orbit_id, estimate_minutes, created_by (user, ai, recurrence), recurrence_rule, recurrence_mode (fixed, after_completion), completion (jsonb CompletionCondition), completion_mode (suggest, auto, off; default suggest), completion_evidence_item_id, completion_evidence_calendar_action_id, auto_completed, completed_at |
| `task_sources` | task_id, item_id |
| `tags` | id, name, parent_id, color_slot |
| `task_tags` | task_id, tag_id, source (orbit, ai, user) |
| `task_events` | id, task_id, kind, payload (jsonb, including prior state and evidence), reason, actor (user, system), created_at, undone_event_id |

## Audit

| Table | Key fields |
|---|---|
| `audit_log` | id, actor_id, action (`connect_account`, `reconnect_account`), target_id (account ID), created_at. No secret or provider content. Future send/archive/label/delete/settings actions remain planned. |

M1.2a records every successful account link in `audit_log` in the same transaction as the account. Future outbound actions will be logged; AI proposals and their decisions will use `proposals` and `task_events`. `outbound_operations` is planned as the durable execution record, while `audit_log` is the human-readable trail.
