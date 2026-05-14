# Status Lookup — `/expense-status` slash command

> **Status:** Built 2026-05-14. `statusBlocks` in [src/slack/views.ts](src/slack/views.ts), handler + registration in [src/slack/slash.ts](src/slack/slash.ts). 9 tests in [tests/slack/views.test.ts](tests/slack/views.test.ts).
> Owner: Edafe.
>
> **Choices locked in vs. open questions:**
> - Access policy = **A (open)**. Anyone in the workspace can query.
> - Timeline depth = show all (no cap).
> - Time formatting = absolute UTC + relative "X ago" on the submitted line.
> - Source-thread deep link = **deferred**. Would require `chat.getPermalink` from the handler; the v1 surface includes the receipt link only. Easy follow-up if missed.
> - Audit logging on `/expense-status` queries = none (read-only, matches /expense-cancel convention).
>
> **Remaining manual step:** add the command in the Slack app dashboard (Slash Commands → Create New Command). See the table below.

A user types `/expense-status EXP-2605-T46G` and gets back an ephemeral block-kit message showing where their ticket is in the approval flow, who currently holds the ball, and what has already happened to it.

## Why this is cheap

Almost every primitive needed already exists in the codebase. This is composition, not a new system.

| Need | Where it lives today |
|---|---|
| Parse `EXP-YYMM-XXXX` from slash text | [`parseTrackingIdArg`](src/slack/slash.ts#L36) |
| Fetch a ticket by ID | [`getTicketByTrackingId`](src/sheets/tickets.ts) |
| List approval rows for a ticket | [`listApprovalsForTicket`](src/sheets/approvals.ts) |
| Resolve user IDs to display names | [`fetchUserName`](src/slack/users.ts) |
| Slash command registration | [`registerSlashCommands`](src/slack/slash.ts#L398) |
| Ephemeral `respond({...})` pattern | All over [`src/slack/slash.ts`](src/slack/slash.ts) |
| Block-kit composition | [`src/slack/views.ts`](src/slack/views.ts) |

No new Slack scopes — the bot already has `commands`.

---

## UX

### Command
```
/expense-status EXP-YYMM-XXXX
```

Accepts the same input shapes `parseTrackingIdArg` already handles: bare ID, backtick-wrapped ID (Slack auto-formats), trailing extra words ignored.

### Response (ephemeral, block-kit)

```
Status: EXP-2605-T46G — AWAITING_APPROVAL (step 1)
─────────────────────────────────────────────
Requester        Amount          Category
@edafe           NGN 4,600       Travel

Currently with: @kunle  (step 1)
Submitted:      Mon 11 May, 14:23  (3h ago)

Timeline
✓ Step 1 — @kunle — PENDING since Mon 14:23

[Open receipt ↗]   (file link)
```

The exact wording and ordering can be tweaked in code. Use the same Block Kit helpers as `approverDmBlocks` / feed messages so the look matches what users already see.

### Failure messages (all ephemeral)
- Bad/missing ID: `Usage: /expense-status EXP-YYMM-XXXX`
- ID parses but not found: `` Ticket `EXP-XXXX` not found. ``
- Sheet read errors: `Could not look up `EXP-XXXX`. See server logs.` (and `console.error`, like the other slash handlers do)
- Access denied (only if we adopt the restricted policy below): `` You're not on the approver list for `EXP-XXXX`. ``

---

## Slack app dashboard config (one-time, manual)

In the Slack app config under **Slash Commands** → **Create New Command**:

| Field | Value |
|---|---|
| Command | `/expense-status` |
| Short description | `Look up the approval status of an expense ticket` |
| Usage hint | `EXP-YYMM-XXXX` |
| Request URL | n/a — Socket Mode |
| Escape channels, users… | unchecked (we parse plain text) |

No re-install needed since we don't add scopes.

---

## Access policy — decision required

Two reasonable options. **Pick one before building.**

### Option A — open to anyone in the workspace (recommended)
Anyone who knows a tracking ID can look it up. Tracking IDs are not secret (they're posted to the feed channel, in DMs, etc.). The data returned is non-PII: amount, category, who's reviewing. This is the lowest-friction option and matches how `/expense-cancel` already trusts the workspace boundary.

### Option B — restricted to involved parties
Allow lookup only if the caller is: the requester, the FM, the current approver, or any past approver/delegate on this ticket. Adds ~15 lines and an audit row for rejections (mirroring [src/slack/slash.ts:73-89](src/slack/slash.ts#L73-L89)).

**Recommendation: A.** B is more code for a payoff that probably doesn't matter inside a single finance team's workspace. If we ever expose this to vendors/external collaborators, revisit.

---

## Data shape we need to surface

From [`Ticket`](packages/shared/src/index.ts) (inferred from how it's used elsewhere):
- `tracking_id`, `status`, `current_step`, `current_approver_user_id`
- `requester_user_id`, `amount`, `currency`, `category`
- `source_channel_id`, `source_message_ts` (for receipt deep-link)
- `created_at` (for "submitted X ago" — verify the field exists; if not, derive from `source_message_ts`)

From `Approval[]` (one row per step decision):
- `step_number`, `approver_user_id`, `approver_name`, `decision`, `decided_at`, `comment`, `delegated_to_user_id`

The "Timeline" section is just the approval rows in order, each line rendered by decision type:
- `APPROVED` → `✓ Step N — @approver — Approved at <time>`
- `REJECTED` → `✗ Step N — @approver — Rejected at <time>: <comment>`
- `PENDING` → `⏳ Step N — @approver — Awaiting since <time>`
- `DELEGATED` → `↪ Step N — @approver → @delegated_to — at <time>`
- `CLARIFICATION_REQUESTED` → `❓ Step N — @approver — Asked for clarification at <time>: <comment>`

(Emoji choices are bikesheddable — match what `feed.ts` already uses.)

---

## Edge cases

| Case | Behavior |
|---|---|
| Tracking ID syntactically valid but not in sheet | "not found" ephemeral |
| Ticket is in `MANUAL_REVIEW` (no approvals row yet) | Show status + reason; timeline empty with note "Awaiting LLM extraction / manual triage" |
| Ticket is `CANCELLED` / `REJECTED` / `PAID` | Show terminal status + final approval row; suppress the "Currently with" line |
| Ticket has no approval rows yet (just-created, before first DM sent) | Same as MANUAL_REVIEW case — empty timeline with a contextual note |
| Sheet read fails | `console.error`, ephemeral "see server logs" message (don't crash) |
| User-name fetch fails for one user in the timeline | Fall back to `<@USERID>` mention; don't fail the whole response |
| Receipt file no longer exists in Slack | Render the timeline anyway; omit or stub the "Open receipt" link |

---

## Test plan (TDD — write tests first)

Mirror the structure of [`tests/slack/slash.test.ts`](tests/slack/slash.test.ts).

### Unit
1. `parseTrackingIdArg` — already tested for the resume/cancel commands; we're reusing it, so no new parsing tests needed.
2. **`renderStatusBlocks(ticket, approvals, userNamesById)`** — pure function, no I/O. Cases:
   - AWAITING_APPROVAL at step 1, no decisions yet → header + currently-with + empty timeline
   - AWAITING_APPROVAL at step 2 after step 1 APPROVED → currently-with step 2; timeline shows step 1 ✓
   - APPROVED (terminal) → no currently-with line; both steps in timeline
   - REJECTED → no currently-with; rejection comment in timeline
   - CANCELLED → no currently-with; "Cancelled by @x at <time>" in timeline
   - MANUAL_REVIEW → "Awaiting triage" note, no timeline
   - DELEGATED step → arrow notation shown
   - CLARIFICATION_REQUESTED step → clarification line with comment
   - Missing user name → falls back to `<@U…>` mention

### Integration (slash handler)
3. Bad ID → ephemeral "Usage" message; no sheet calls made.
4. Valid ID but ticket not found → ephemeral "not found"; `getTicketByTrackingId` called once; `listApprovalsForTicket` NOT called.
5. Happy path → both sheet helpers called; `respond` called once with `response_type: "ephemeral"` and the blocks from `renderStatusBlocks`.
6. Sheet error in `getTicketByTrackingId` → ephemeral "see server logs"; `console.error` called.
7. Sheet error in `listApprovalsForTicket` → degrade gracefully: show ticket-level info + a "(could not load timeline)" note. Don't fail the whole command.

### Test infra
- Mock `getTicketByTrackingId` and `listApprovalsForTicket` directly (the existing slash tests already mock these — copy the pattern).
- Mock `client.users.info` for name resolution, OR refactor to inject `userNamesById` as a pre-resolved map (cleaner — recommend this).

---

## Implementation order (build day)

1. **Tests for `renderStatusBlocks`** (red) → pure function, fastest feedback loop. Cover all 9 cases above.
2. **Implement `renderStatusBlocks`** in `src/slack/views.ts` (green). Reuse the formatters/emoji from existing `views.ts` exports.
3. **Tests for the slash handler** (red) — mock the two sheet calls and `client`.
4. **Implement `makeExpenseStatusHandler`** in `src/slack/slash.ts` — mirror the shape of `makeExpenseResumeHandler`, minus the state-machine transition (read-only command, no writes).
5. **Wire into `registerSlashCommands`** — `app.command("/expense-status", statusHandler)`.
6. **Add the command in the Slack app dashboard** (manual).
7. **Smoke test in Slack** — query an AWAITING_APPROVAL ticket, an APPROVED one, and a MANUAL_REVIEW one (we have all three live right now).

Rough effort estimate: half a day, end-to-end, with tests. The longest step is probably nailing the Block Kit visual.

---

## Out of scope (write down so we don't drift)

- No mutation. Read-only command. Any state changes go through `/expense-resume` or `/expense-cancel`.
- No bulk listing (`/expense-list`, `/my-expenses`, etc.). One ID at a time.
- No `@mention` UX. If we want that later, it's a sibling handler reading the same `renderStatusBlocks` — but slash command is the canonical entry point.
- No App Home tab. Could be a richer follow-up but is its own feature.
- No exposing the lookup over HTTP / from the dashboard. The Phase 2 dashboard already has its own ticket views.

---

## Open questions for Edafe

1. **Access policy** — A (open) or B (restricted)? Default: A.
2. **Timeline depth** — show every approval row, or cap at the most recent N to avoid wall-of-text on rejected-then-resumed tickets? Default: show all; they don't get that long in practice.
3. **Time formatting** — relative (`3h ago`) or absolute (`Mon 11 May, 14:23`)? Default: both, like the example in the UX section.
4. **Should the response include a deep link back to the source thread**, in addition to the receipt file link? Useful for the FM, less useful for the requester. Default: yes, as a small "View thread ↗" link in the context block.
5. **Audit logging** — should `/expense-status` queries appear in the audit sheet? Other read-only operations don't audit; default: no. (If yes, only on access denials under Option B.)
