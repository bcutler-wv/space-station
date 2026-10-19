# AI

## Principles

1. **Read, extract, propose.** The AI layer has no code path to send, delete, archive, post, book, or edit anything in a provider. Internal task completion is a separate, opt-in rule engine decision with evidence and undo; the model only supplies a validated assessment. See `TASKS.md`.
2. **Optional.** Station must be fully usable with no AI provider configured: sync, search, rules, tasks, and calendar all work without it.
3. **Provider-neutral.** One adapter interface for Anthropic, OpenAI, and any OpenAI-compatible endpoint (which covers local models). Tools and schemas are defined once.
4. **Every claim is cited.** Extractions point to text spans. CAPCOM answers cite item IDs.
5. **Untrusted input.** Message content is data, never instructions. See Prompt injection below.

## Provider configuration

Set in the wizard and in Settings, then AI provider:
- Provider and API key (tested with a live call before saving).
- A **fast model** for per-item extraction and a **strong model** for CAPCOM, briefings, meeting briefs, and Flight Plans. Each provider gets sensible defaults.
- A monthly spend cap enforced by the app, with usage tracked per feature in `ai_usage`.
- Exclusion rules (also editable per Orbit).

## The three tiers

| Tier | What | When | Model |
|---|---|---|---|
| 1. Rules | Deterministic labels, Orbit routing, bulk detection | Every item, at ingest | None |
| 2. Extraction | Structured extraction per item (schema below) | Every item that isn't bulk or excluded | Fast |
| 3. On demand | CAPCOM, briefings, meeting briefs, Flight Plans, saved views | When asked, or on schedule | Strong |

Bulk detection uses headers (List-Unsubscribe, Precedence: bulk, known automated senders). Bulk items get rule-based labels only.

## What the model receives with each item

- The Orbit context text the user wrote.
- The user's identity: name and every address and chat ID they own.
- Label and tag vocabularies.
- Entity hints from the people graph for senders and recipients.
- Candidate open tasks chosen by the deterministic matcher (see TASKS.md).
- The item itself, wrapped as untrusted data.

## Per-item extraction schema

Validated with zod. Output that fails validation is retried once, then dropped and logged.

```ts
type ItemExtraction = {
  itemId: string;
  summary: string;                    // one line, max ~140 chars
  whyItMatters?: string;              // the "why" line in Needs you
  priority: "urgent" | "high" | "normal" | "low";
  needsReply: { value: boolean; confidence: number };
  labels: string[];                   // existing labels only
  tags: string[];                     // existing tags only
  suggestedNewTags?: string[];        // go to the review tray

  actionItems: Array<{                // incoming items only
    title: string;
    due?: { date: string; sourceText: string };
    completion: CompletionCondition;
    confidence: number;
    evidence: Span;
  }>;

  commitments: Array<{                // the user's outgoing items only
    text: string;
    toPersonIds: string[];
    due?: { date: string; sourceText: string };
    confidence: number;
    evidence: Span;
  }>;

  waitingOn: Array<{                  // the user's outgoing asks only
    ask: string;
    fromPersonIds: string[];
    expectedBy?: string;
    evidence: Span;
  }>;

  taskUpdates: Array<{                // only for candidate tasks supplied in the prompt
    taskId: string;
    change: "complete" | "reschedule" | "cancel" | "merge";
    newDue?: string;
    mergeIntoTaskId?: string;
    reason: string;
    confidence: number;
  }>;

  entities: Array<{
    kind: "person" | "org" | "project";
    name: string;
    email?: string;
    role?: string;
    matchEntityId?: string;
  }>;

  security: { suspicious: boolean; reason?: string };
};

type CompletionCondition =
  | { type: "reply_to_person"; personIds: string[] }
  | { type: "reply_in_thread"; threadId: string }
  | { type: "send_artifact"; personIds: string[]; artifact: string }
  | { type: "meeting_scheduled"; personIds: string[] }
  | { type: "manual" };

type Span = { itemId: string; start: number; end: number };
```

### Rules enforced in code after validation

- **Direction.** `actionItems` are discarded on outgoing items. `commitments`, `waitingOn`, and `taskUpdates` with `change: "complete"` are discarded on incoming items. A stranger's email can never create a commitment or close a task.
- **Vocabulary.** Labels and tags not in the existing lists are dropped. New tag ideas become proposals.
- **Task IDs.** Any `taskId` not in the supplied candidate list is dropped.
- **Spans.** Evidence spans must fall inside the item's text, or the extraction is dropped.
- **Thresholds.** Extraction thresholds determine whether a proposal is shown or dropped. They never authorize provider actions. Internal completion defaults to suggest only; an explicit per-condition opt-in enables automatic completion after deterministic eligibility and evidence checks.
- **Storage.** Raw output is stored in `extractions` with model and prompt version, so history can be re-run after prompts improve.

## Meeting brief

Built for each upcoming event, refreshed when related items arrive. Powers Up next.

```ts
type MeetingBrief = {
  eventId: string;
  attendeePersonIds: string[];
  sinceLastMeeting: Array<{ text: string; cites: string[] }>;
  openItems: Array<{ kind: "task" | "promise" | "waiting_on"; id: string }>;
  prepNotes: Array<{ text: string; cites: string[] }>;
  conflicts: string[];                // overlapping event IDs from any Orbit
};
```

## Daily briefing

Generated each morning by the strong model and on demand.

```ts
type DailyBriefing = {
  date: string;
  summary: string;                    // max 3 sentences, plain language
  cites: string[];
  flightPlan?: FlightPlanProposal;    // only when the user presses "Plan my day"
};

type FlightPlanProposal = {
  blocks: Array<{ start: string; end: string; taskId?: string; eventId?: string; note?: string }>;
  unplaced: string[];                 // task IDs that didn't fit
};
```

## CAPCOM

CAPCOM is an agent loop over the tools below, scoped to the current Orbit (or all Orbits from Mission Control).

### Read tools

| Tool | Purpose |
|---|---|
| `search` | Lexical search with operators across mail, chat, and calendar |
| `semantic_search` | Meaning-based search |
| `get_thread`, `get_item` | Full email thread, Slack thread, Teams chat, or event |
| `get_attachment_text` | Extracted text from documents and OCR |
| `lookup_entity` | Resolve a name or description to a person or org, with domains and Orbit |
| `list_calendar`, `find_free_time` | Events across all calendars, open slots |
| `list_tasks`, `list_promises` | Tasks, commitments, waiting-on items |
| `aggregate` | Count and group (by sender, day, Orbit, label) |
| `slack_live_search` | Live-mode Slack workspaces only. Queries Slack directly, caches nothing. |

### Proposal tools

Each creates a card the user approves. None has side effects outside Station's `proposals` table.

| Tool | Creates |
|---|---|
| `propose_task`, `propose_task_change` | New task, reschedule, merge, cancel |
| `draft_reply` | A draft in the right account and thread, opened in the composer |
| `propose_event` | A calendar event or time block |
| `propose_flight_plan` | A day plan |

### Enforced in code

- **No action tools exist.** Not sending, archiving, deleting, posting, or editing.
- **Scope is applied server-side.** Inside an Orbit, tools cannot return items from other Orbits. The model is not trusted to filter.
- **Excluded items are invisible** to every tool and never reach a provider. The most restrictive policy across all matching Orbits governs the item, attachment, embeddings, and derived content. Recheck at retrieval time and invalidate derived data when a policy tightens.
- **Budget per question:** a cap on tool calls (default 12) and tokens. The UI shows each step as it runs.
- **Citations required.** The answer format requires cited item IDs. Uncited claims are flagged in the UI.

## Prompt injection

Every email, message, attachment, and event description is attacker-controlled text. Defenses, in order of importance:

1. **No dangerous capabilities.** The model has no provider action tools. Internal auto-completion requires a user-enabled condition and independent evidence checks, so model text alone cannot complete a task.
2. **Direction rules** (above) stop incoming content from creating commitments or completing tasks; task auto-completion additionally checks verified user action provenance.
3. **Untrusted wrapping.** Item content is passed inside clearly delimited data blocks, with instructions stating it is data.
4. **Schema-only output** for extraction. Free text only appears in short summary fields, which are rendered as plain text, never HTML or links.
5. **The `security.suspicious` flag** surfaces likely phishing and injection attempts in the UI.

## Prompts

Prompts live in `packages/ai/prompts/`, versioned, one file per task, with fixture-based tests: a set of sample items with expected extraction outputs. Prompt changes must keep the fixture suite passing.
