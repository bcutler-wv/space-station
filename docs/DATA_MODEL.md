# Data model

PostgreSQL with Drizzle. This lists the tables and the fields that matter. Claude Code fills in indexes, timestamps (`created_at`, `updated_at` on every table), and foreign key details.

## Identity and settings

| Table | Key fields |
|---|---|
| `users` | id, display_name. v1 has exactly one row. |
| `auth_credentials` | id, user_id, kind (passkey, password, totp), password_hash (Argon2id only for password), encrypted_secret (TOTP only), passkey_public_key and counter (passkey only), created_at |
| `recovery_codes` | user_id, code_hash, used_at. Show once during enrollment; never store plaintext. |
| `sessions` | id, user_id, token_hash, created_at, expires_at, revoked_at. Rotate after login and privilege changes. |
| `settings` | key, value (jsonb). Theme mode, seed color, confidence thresholds, AI budgets. M0.3 stores a bounded normalized WebP wallpaper in the `appearance` value; a later private file store may replace the embedded image. |

## Orbits and accounts

| Table | Key fields |
|---|---|
| `orbits` | id, name, slug, color_slot, icon, context (text written by the user), shortcut_key, sort_order, ai_policy (jsonb) |
| `accounts` | id, orbit_id, kind (gmail, graph, imap, caldav, slack, teams), address, display_name, auth_kind, credentials (encrypted), status, slack_mode (indexed or live) |
| `oauth_apps` | id, provider (google, microsoft, slack), client_id, client_secret (encrypted), secret_expires_at |
| `sync_state` | account_id, resource and provider collection ID, cursor (jsonb), generation, status, last_success_at, last_error. Unique per source collection. |
| `sync_runs` | id, sync_state_id, started_at, finished_at, status, retry_count, error_class, cursor_before, cursor_after |
| `routing_rules` | id, orbit_id, match (jsonb: person, org, domain, label, keyword) |
| `exclusion_rules` | id, scope (global or orbit_id), match (jsonb), effect (no_ai, no_index, no_ai_and_no_index) |

An account belongs to exactly one Orbit. An item can appear in several Orbits through `item_orbits`, which combines the account's Orbit with routing rules and people or org assignments.

Global exclusions and every matching Orbit's AI/index policy compose by **most restrictive effect**. Routing changes and tightened policy enqueue invalidation of affected search documents, embeddings, extracted attachment text, AI outputs, summaries, briefings, and citation caches before new retrieval. Keep source records if permitted for ordinary mail/calendar use; erase prohibited derived records and rebuild only when policy allows. See SECURITY.md.

## People and organizations

| Table | Key fields |
|---|---|
| `people` | id, display_name, org_id, primary_orbit_id, notes |
| `identities` | id, person_id, provider, kind (email, slack_user, teams_user), normalized_value, account_id or workspace/tenant ID, verified_at. Unique within the provider namespace and account/workspace/tenant; the same opaque ID may exist elsewhere. |
| `orgs` | id, name, domains (text[]), primary_orbit_id |
| `aliases` | entity_kind, entity_id, alias. "the sand supplier" points at an org. |

Identity resolution matches by email address automatically. Anything else is merged by the user, or proposed by extraction and approved in the review tray.

## Messages

| Table | Key fields |
|---|---|
| `threads` | id, account_id, provider_collection_id, external_id, kind (email, slack_thread, teams_chat, channel), subject, last_activity_at. Unique by account, collection, external ID. |
| `items` | id, account_id, provider_collection_id, thread_id, external_id, provider_revision, kind (email, chat), direction (in, out), from_person_id, sent_at, subject, snippet, body_text, body_html_path, is_bulk, flags (jsonb: read, starred, archived), extraction_status, deleted_at. Unique by account, collection, external ID. |
| `item_recipients` | item_id, person_id, role (to, cc, bcc, mention) |
| `item_orbits` | item_id, orbit_id, reason (account, rule, person, org) |
| `labels` | id, account_id, name, color, provider_ref |
| `item_labels` | item_id, label_id, source (provider, rule, ai, user) |
| `attachments` | id, item_id, filename, mime_type, size, storage_path, extracted_text, ocr_used |
| `item_chunks` | item_id, chunk_index, text, embedding (vector) |
| `drafts` | id, account_id, thread_id, provider_draft_id, to/cc/bcc, subject, body, attachment_refs, revision, state (editing, queued, sent, discarded), updated_at |
| `outbound_operations` | id, draft_id, account_id, kind, idempotency_key, state (pending, in_flight, succeeded, failed, outcome_unknown), provider_request_id, provider_result_id, attempt_count, last_error, user_action_at, completed_at. Unique idempotency key. |

HTML bodies are stored as files, not in the database, and are always sanitized again at render time.

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
| `audit_log` | id, action (send, archive, label, delete, settings_change, connect_account), target, created_at |

Every outbound action is logged. AI proposals and their decisions are logged through `proposals` and `task_events`. `outbound_operations` is the durable execution record; `audit_log` is the human-readable trail.
