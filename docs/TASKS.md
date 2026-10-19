# Tasks

Tasks live in Mission Control. Orbits feed them in. They are meant to be living things that update and close themselves as work actually happens.

## Fields

See `tasks` in [DATA_MODEL.md](DATA_MODEL.md). The important distinctions:

- **Scheduled day vs due date.** `scheduled_on` is when the user plans to work on it and is what the week board uses. `due_on` is the deadline. Dragging a card changes `scheduled_on` only. A card scheduled after its due date shows as past due.
- **Estimate.** Optional, used by the Flight Plan to fit tasks into gaps between meetings.
- **Sources.** Every task created from a message links back to it.

## Tags

- A task can have many tags. Tags are a table with an optional parent, so filtering by `finance` includes tasks tagged `accounting` if `accounting` is a child of `finance`.
- Each tag on a task records its source: `orbit`, `ai`, or `user`.
- **Orbit tag:** applied automatically from the task's origin Orbit. Cannot be removed while the task belongs to that Orbit. Tasks created directly in Mission Control get no Orbit tag unless the user picks one.
- **AI tags:** chosen only from the existing tag list. New tag ideas go to the review tray.
- **Corrections:** removing an AI tag is logged as feedback and added to that tag's examples for future extraction.
- **Filters:** combine with AND and OR, and save as views.

## Recurrence

- RRULE strings (RFC 5545), computed with the rrule library.
- **Fixed schedule** mode: next instance on the rule's next date regardless of completion.
- **After completion** mode: next instance a set interval after the last one was completed.
- Missed instances do not pile up. If several are missed, the user sees one overdue instance.

## The review tray

Tasks the AI finds go to the review tray first, never straight onto the board. Each proposal shows the title, Orbit, suggested tags, where it came from, and its completion condition, with Add task and Dismiss. Approved tasks land in the Unscheduled column.

## Auto-completion

Each AI-created task carries a `CompletionCondition` (see AI.md). Users can attach one to their own tasks too.

### The matcher

Every verified **outgoing** item (sent email, sent Slack or Teams message) and every calendar change attributable to the user runs through a two-step matcher. Sync of an invitation, automatic provider update, or another person's calendar edit is not a user action.

1. **Deterministic candidates.** Find open tasks whose condition references the same recipient (through the identity graph, so a Slack DM can satisfy a task that came from an email) or the same thread. Most outgoing items match nothing and stop here.
2. **Model check.** Only candidates go to the fast model with one question: does this message actually satisfy the task? "Got it, I'll look at this Monday" does not complete "send the quote." Instead, it keeps the task open, adds a note, and records a commitment for Monday.

### Confidence

- **Default: suggest only.** A candidate with verified evidence creates a suggestion card that asks the user to confirm.
- **Opt-in auto.** The user can explicitly enable automatic internal completion per condition type. A high-confidence match then closes the task, records the outbound operation or verified calendar action and matching evidence, appears in Recently auto-cleared, and offers one-click undo.
- **Off.** The matcher does nothing for that condition type. Low-confidence or ambiguous matches never auto-complete.

Auto-completed tasks are never deleted. They are marked done with `auto_completed = true` and either `completion_evidence_item_id` or `completion_evidence_calendar_action_id` set.

### Security rule

Only verified user-originated sent messages and calendar actions can satisfy completion conditions. A received invitation alone cannot satisfy `meeting_scheduled`; require an event creation or change made by the user, linked to its operation or provider audit provenance. Incoming messages can only *propose* task changes. The exception is waiting-on items, which by definition clear when the other person replies.

## Other living behavior

The same matcher turns these into review tray proposals:
- **Deadline moved:** "Can we push this to next week?" proposes a new due date.
- **No longer needed:** "Never mind, we handled it" proposes canceling.
- **Duplicates:** the same request in an email and a chat message proposes a merge.

## Event log

Every change to a task writes a `task_events` row with the actor (user, system), condition, evidence references, prior state, and decision reason. The task detail view shows this history. Undo restores the prior state, writes a compensating event, and prevents the same evidence from re-closing the task without a new user action.

## Views

- **Week board (v1):** columns Unscheduled, then Sunday through Saturday. Each day header shows meeting load in hours from the combined calendar, highlighted when heavy. Tag filter chips above the board.
- **Other views:** list, calendar overlay, and others to be recommended during the build.
