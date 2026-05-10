# NEXT — implementation plan for upcoming phases

> **Read order:** [PLAN.md](./PLAN.md) is the source of truth for the bot's design and hard constraints. This file is the *resumption brief* — what's shipped, where we paused, and what to build next.

---

## Where we are (2026-05-10)

All Phase 1.x feature work is shipped and **validated end-to-end in a real Slack workspace** (latest run: `EXP-2605-C5ME` reached PAID through clarify + resume + 2-step approval + Mark as Paid + file-proof). External code audit produced 19 findings; in-scope items have been fixed, deferred items captured below.

- **221+ tests** passing across 17 files (`npm test` / `npx vitest run`).
- **`npm run typecheck`** (now includes tests via `tsconfig.test.json`) clean. **`npm run build`** clean.
- Bot runs locally via `npm run dev` (tsx watch). The only unchecked acceptance-box on the original PLAN is **Railway deploy**.

### What's working in production-shape behaviour

| Capability | Status |
|---|---|
| Socket Mode connection | ✅ |
| Source-channel-only filter, bot/edit/thread filters | ✅ |
| Smart pre-classify gate (regex keyword filter) | ✅ |
| Nudge completion via edit OR thread reply | ✅ |
| OpenRouter classifier with Anthropic provider lock (test-asserted) | ✅ |
| Markdown code-fence strip on classifier output | ✅ |
| PNG/JPG receipt classification | ✅ |
| PDF page-1 extraction → PNG → vision input | ✅ |
| **Multi-step routing — chain traversal across `route.approvers[1..N]`** | ✅ |
| **Approver tags on FM Mark-as-Paid DM** | ✅ |
| Approve / **Clarify** / **Delegate** / Reject buttons + modals | ✅ |
| **Multi-expense splitting (N tickets per message)** | ✅ |
| Mark as Paid + payment-proof watcher | ✅ |
| **`/expense-resume EXP-…`** (FM-only clarification resume) | ✅ |
| **`/expense-cancel EXP-…`** (requester or FM) | ✅ |
| **Optional `#expense-log` feed (one-liner per state transition)** | ✅ |
| Audit log for every transition (canonical `StateEvent` names only) | ✅ |
| Optimistic concurrency + serial write queue + **retry-with-backoff** | ✅ |
| Slack file-CDN host allow-list before sending bot token | ✅ |
| `/health` endpoint, graceful shutdown | ✅ |

### What's still NOT built

| Item | Scope |
|---|---|
| — | **Railway deploy** (last unchecked Phase 1.0 acceptance box) |
| audit follow-up A | File-share watcher does N full sheet scans (defer; Phase 2 perf) |
| audit follow-up B | `PAYMENT_STEP_SENTINEL = 99` magic value → ticket fields (sheet schema migration) |
| audit follow-up C | Test coverage gap on `tickets.ts` retry / `interactivity.ts` modal handlers / `sheets/*` |
| audit follow-up D | `args: any` casts on Bolt action/view handlers (low-leverage type tightening) |
| audit follow-up E | Split events.ts (1.1 KB) + interactivity.ts (1.6 KB) into per-handler modules |
| audit follow-up F | O(n) full-table sheet reads on every interaction (Phase 2 indexing) |

---

## Phase 1.5 — Multi-step routing (recommended next)

**Why first:** today the bot only DMs the first approver of any matching route, regardless of how many approvers the route lists. For your `mid-ngn` (`U_PATRICK,U_STEPHAN`) and `high-ngn` (`U_PATRICK,U_TINUS,U_STEPHAN`) bands, this is silently wrong. No new Slack surfaces, purely internal logic.

### Implementation outline

1. **Refactor `DM_NEXT_APPROVER` side effect** in [src/types.ts](./src/types.ts):
   - Today: `{ type: "DM_NEXT_APPROVER"; approver_user_id: string; step_number: number }` — the empty-string sentinel for `approver_user_id` in the non-final APPROVE branch is a footgun.
   - **Drop `approver_user_id` from the side effect.** The Slack handler already loads the route to compute `is_final_step`; have it look up `route.approvers[step_number - 1]` for the next DM. Cleaner contract.
   - For `RESUME_AFTER_CLARIFY`, the user is already known (same approver, same step) — use a different side-effect type or carry the user id only there.

2. **Update [src/state/machine.ts](./src/state/machine.ts):**
   - APPROVE non-final: emit `{ type: "ADVANCE_TO_STEP", step_number: ticket.current_step + 1 }`.
   - RESUME_AFTER_CLARIFY: keep current shape (re-DM same approver, same step).
   - Update `tests/state/machine.test.ts` accordingly.

3. **Update [src/slack/interactivity.ts](./src/slack/interactivity.ts) `expense_approve` handler:**
   - Today hardcodes `is_final_step: true`. Replace with: `const route = getCachedRoutes().find(r => r.route_id === ticket.route_id); const isFinal = ticket.current_step === route.approvers.length;`.
   - On approve-not-final: bump `ticket.current_step`, set `ticket.current_approver_user_id = route.approvers[ticket.current_step]` (1-indexed in plan, but `route.approvers` is 0-indexed array — pay attention), append a fresh approval row for the next step, DM the next approver.
   - On approve-final: keep existing behaviour (DM the FM with Mark as Paid).

4. **Tests:**
   - Add a state machine test for the new `ADVANCE_TO_STEP` side effect shape.
   - Add an integration test (mocked WebClient) walking a 3-step route through 3 approvals.

5. **PLAN.md §19 Phase 1.5:** tick the boxes after e2e validation.

### Edge cases to think about

- Ticket whose `route_id` is no longer in the routes sheet (route was deleted or renamed) → fail loudly + manual review.
- Approve called twice in quick succession on the same step (concurrent clicks): handled by optimistic concurrency on `row_version` — second click sees mismatch → ephemeral "already processed".
- Authorization on approve at step N: must be `ticket.current_approver_user_id` (which we update on each advance), not `route.approvers[0]`.

**Estimate:** 30–45 min including tests + e2e validation.

---

## Phase 1.2 — Clarification branch

### Implementation outline

1. **[src/slack/views.ts](./src/slack/views.ts):**
   - `ACTION_CLARIFY = "expense_clarify"` constant.
   - Add Clarify button (neutral style, no `style` field) to `approverDmBlocks` alongside Approve and Reject.
   - `MODAL_CLARIFY_CALLBACK_ID = "expense_clarify_modal"`.
   - `clarificationQuestionModal(trackingId)` — same shape as `rejectionReasonModal` but labelled "Question for the requester".
   - `approverDmAfterClarify(ticket, askedAt, approverName, question)` — shows ":question: Awaiting clarification" + question text.

2. **[src/slack/interactivity.ts](./src/slack/interactivity.ts):**
   - `makeClarifyButtonHandler` opens the modal via `views.open` (same pattern as Reject).
   - `makeClarifyModalSubmitHandler`: re-fetch ticket, re-authorize, run `transition()` with `CLARIFY` event, update approval row (`decision: CLARIFICATION_REQUESTED, comment: question`), edit DM, post in requester's source thread tagging them with the question, DM the financial manager with the resume hint.
   - Register `app.action("expense_clarify", ...)` and `app.view(MODAL_CLARIFY_CALLBACK_ID, ...)`.

3. **`/expense-resume` slash command:**
   - **Slack app config** (out-of-code): under "Slash Commands", add `/expense-resume`. With Socket Mode enabled, no Request URL is needed. **Reinstall the app** afterwards.
   - **[src/slack/slash.ts](./src/slack/slash.ts):** replace the stub. Implement `registerSlashCommands(app, deps)` and add a handler:
     ```
     app.command("/expense-resume", async ({ command, ack, client }) => { ... })
     ```
   - Handler: parse tracking_id from `command.text`, validate format with `isValidTrackingId`, fetch ticket. Authorize: only `config.FINANCIAL_MANAGER_USER_ID` may run it. Run `RESUME_AFTER_CLARIFY` event through `transition()`. Update ticket status. Re-DM the same approver at the same step (using stored `dm_channel_id`/`message_ts` on the existing approval row, or a fresh DM if those are gone). Append audit entries.

4. **[src/index.ts](./src/index.ts):** call `registerSlashCommands(app, { config })` instead of the no-op stub call.

5. **Tests:** view-builder tests for the clarify modal + after-clarify block; events.test.ts coverage of `/expense-resume` parsing edge cases (whitespace, missing arg, malformed tracking_id).

### Edge cases

- `/expense-resume` on a ticket that's not in `NEEDS_CLARIFICATION`: state machine returns illegal → ephemeral error.
- `/expense-resume` from a non-FM user: ephemeral rejection + audit `AUTHORIZATION_REJECTED`.
- The original approver was delegated since clarification: the resumed DM should go to the **current** `current_approver_user_id`, not the original.
- The original approval row's DM is gone (deleted): re-DM via `conversations.open` and update the approval row's `dm_channel_id` / `message_ts`.

**Estimate:** 45–60 min including the Slack app config step.

---

## Subsequent phases (sketch)

- **1.3 Delegate** — fourth button on approver DM; modal with `users_select` element; updates `approver_user_id` on the approval row, original logged in `delegated_to_user_id`; re-DMs the new approver. State unchanged (still AWAITING_APPROVAL).
- **1.4 Multi-expense splitting** — drop the `items[0]`-only line in [src/slack/events.ts](./src/slack/events.ts); for each item, allocate a fresh tracking_id, write a ticket row, append approval row, DM approver. Single thread ack listing all IDs.
- **1.6 `/expense-cancel`** — slash command; auth: requester or FM; runs CANCEL event; edits any pending DMs to "Cancelled" via `chat.update`; posts in source thread.
- **1.7 `#expense-log` feed** — conditional on `EXPENSE_LOG_CHANNEL_ID` env var; one-liner posted from a single helper called at every state transition.

---

## Operational state when paused

- **Bot is running locally** via `npm run dev` (background task — tsx watch). Real tickets in the workbook. Latest validated tickets:
  - `EXP-2605-RVYP` (REJECTED, validated reject flow)
  - `EXP-2605-UHPS` (PAID, validated full pipeline + thread-reply nudge completion)
  - `EXP-2605-VZKE` (APPROVED → FM has Mark as Paid; validated PDF flow)
- **Sheet:** four tabs in place; `routes` has `low-ngn`/`mid-ngn`/`high-ngn` rows each with one approver (Edafe's user id `U09DUCBKKGU`). For 1.5 testing, the `mid-ngn` and `high-ngn` rows can be expanded to multi-approver chains.
- **`.env`:** all credentials filled (Slack, OpenRouter, Sheets); `LOG_LEVEL=debug` for the current debugging session — fine to leave or revert.
- **Slack app:** id `A09DBSH1BG9`, name `n8n-2` (repurposed), bot user `U0B2NA9BZQD`. Socket Mode enabled, scopes per `.env.example` requirements.
- **Diagnostic breadcrumb** in [src/slack/events.ts](./src/slack/events.ts) at the top of the message handler — emits one `[events] message received ...` line per delivered event. Keep this; it earned its place during the session.

## Pending validation (low priority)

- E2E of nudge completion via **edit** (we validated thread-reply completion; edit path is the same code).
- Multi-page PDF (current behaviour: page 1 only, no warning).
- Slack websocket disconnect + reconnect (Bolt handles automatically; never observed a real loss in this session).

## Open question (re-confirm before merging 1.5)

The state machine's `DM_NEXT_APPROVER` side effect carries an empty-string `approver_user_id` for the non-final APPROVE branch. **Phase 1.5 should refactor** this away (per §1.5.1 above). Confirm before doing so — it's a small `types.ts` + `machine.ts` + `interactivity.ts` cleanup, but it is a cross-cutting change to the side-effect contract.

---

## Audit follow-ups (2026-05-10)

External code audit produced six findings. Three were fixed in-session (ESCALATE_TO_MANUAL_REVIEW state event, widened cancel filter, consolidated `app.message` dispatcher) plus the highest-priority test gap (provider-lock assertion). The remaining items are deferred — captured here so a future session can pick them up without re-deriving the analysis.

### A. File-share watcher does N full sheet scans per FM file upload

In [src/slack/events.ts](./src/slack/events.ts) `processPaymentProofFromFile`: lists all non-terminal tickets, filters to `AWAITING_PAYMENT`, then for each calls `listApprovalsForTicket()`. Five FM screenshots in a thread = 5×(1 + N) full-sheet reads. Fine at current scale; a real concern at ~1000 tickets.

**Fix shape** (~30 min):
- Add `findSentinelByDmChannel(channel_id): Promise<Approval | null>` to [src/sheets/approvals.ts](./src/sheets/approvals.ts) — single sheet read, filters by `step_number === PAYMENT_STEP_SENTINEL && dm_channel_id === channel`.
- Or keep a tiny in-memory `Map<dm_channel_id, tracking_id>` populated when the sentinel approval row is written and invalidated when the ticket reaches `PAID`.

The map approach is faster at runtime but adds invalidation logic. The single-read approach is enough for any plausible team size.

### B. Sentinel `step_number = 99` magic value leaking through several files

[src/slack/events.ts](./src/slack/events.ts) `PAYMENT_STEP_SENTINEL = 99` is referenced in `collectStepApproverIds`, `processPaymentProofFromFile`, and the cancel filter (implicit via `decision === "PENDING"`). Works today; will silently break if someone ever configures a 99-step route (theoretical).

**Fix shape** (~2 hours, sheet schema migration):
- Add `payment_dm_channel_id: string | null` and `payment_dm_message_ts: string | null` to the `Ticket` type.
- Update bootstrap to add the columns; update [src/sheets/tickets.ts](./src/sheets/tickets.ts) `rowToTicket` / `ticketToRow` to include them.
- Replace sentinel-row append in the final-approve branch with `updateTicket(..., { payment_dm_channel_id, payment_dm_message_ts })`.
- Replace sentinel-row reads with ticket-field reads.
- Drop `PAYMENT_STEP_SENTINEL` and related branches.

Migration: existing in-flight tickets need their sentinel rows back-filled into the new columns. One-shot migration script, or accept manual re-Mark-as-Paid.

### C. Test coverage gap on the bigger files

These have zero test files; their business logic is exercised only by end-to-end Slack runs:
- [src/slack/interactivity.ts](./src/slack/interactivity.ts) — modal-submit auth, route-lost recovery, sentinel handling, multi-step advance ticket-patch logic
- [src/sheets/tickets.ts](./src/sheets/tickets.ts) — optimistic concurrency + RowVersionConflict retry behavior
- [src/sheets/approvals.ts](./src/sheets/approvals.ts) — CRUD with mocked sheets client
- [src/sheets/audit.ts](./src/sheets/audit.ts), [src/sheets/bootstrap.ts](./src/sheets/bootstrap.ts), [src/sheets/client.ts](./src/sheets/client.ts) — initialization paths
- [src/slack/files.ts](./src/slack/files.ts) — auth + 20 MB cap

The provider-lock test (audit's most security-critical item) is in place at [tests/llm/client.test.ts](./tests/llm/client.test.ts).

**Best next slice** (~3-4 hours): tickets.ts retry behavior. Mock the sheets client to return a conflicting `row_version` on the first read, then a fresh value on the retry. Same setup unlocks tests for the rest of `sheets/`.

Modal-submit handler tests for interactivity.ts require a Bolt-shaped harness — high plumbing cost (~1 day for the suite). Defer until a regression actually bites.

### D. `args: any` on Bolt action / view registrations

Every `app.action(id, ...)` and `app.view(id, ...)` callback is typed `args: any` with an `// eslint-disable-next-line` comment. The auth checks inside the handlers are explicit identifier comparisons, so `any` doesn't actively defeat them — but field-name typos (e.g. `body.user.uid` instead of `body.user.id`) wouldn't be caught at compile time.

**Fix shape** (~2 hours): Bolt exports `SlackActionMiddlewareArgs<BlockAction<ButtonAction>>` and `SlackViewMiddlewareArgs<ViewSubmitAction>`. Replace each `args: any` cast with the correct middleware-args type. Drop the eslint disables. No behavioral change.

Low-leverage relative to the cost — the auth checks are the load-bearing safety, and they're explicit. Defer.

### E. File size — events.ts at ~1.1 KB lines, interactivity.ts at ~1.6 KB

PLAN.md §15 had each as one of nine modules. They've grown to swallow per-handler bodies, helpers, sentinels, and recovery paths. Most of the original-plan splits still make sense but require care.

**Fix shape** (~3-4 hours, two passes):
- `interactivity.ts` → split per button: `interactivity/approve.ts`, `reject.ts`, `clarify.ts`, `delegate.ts`, `mark_paid.ts`, plus a thin `index.ts` that registers them. Each file owns its button handler + modal-submit handler.
- `events.ts` → keep the message dispatcher; relocate `processOneItem` to `events/process_item.ts`, `processPaymentProofFromFile` to `events/payment_proof.ts`, and the nudge-completion logic to `events/nudges.ts`.

No urgency — the bot works. Worth doing the next time someone is reading the files for a full session.

### F. O(n) full-table sheet reads on every interaction

`getTicketByTrackingId`, `getTicketBySourceMessageTs`, `listNonTerminalTickets` each read the entire tickets sheet. Every button click is at least one full read; every `updateTicket` is two (read for `row_version`, write back). Fine at a few hundred tickets; multi-second latency at 5,000+; unusable at 50,000.

**Fix shape** (~half day):
- In-memory index `Map<tracking_id, sheet_row_index>` rebuilt at boot (the existing reconciliation read) and updated on every `appendTicket` / write.
- Replace full-table reads with index lookup → `values.get` for the specific row range.

This is a Phase 2 problem — the current operating point is small enough that the slowdown is invisible — but the design choice is worth flagging now so the next person knows it's not "always been like this".

### Decisions skipped (and why)

- **Audit said `routeToManualReview` violates the state-machine rule** by writing `status: "MANUAL_REVIEW"` on creation. Not fixed — interpreted the rule pragmatically: "no code path may CHANGE status without going through `transition()`". Creation has no prior state; there's nothing to transition from. The audit log there now uses `TICKET_CREATED` + `MANUAL_REVIEW_OPENED` (no fake `STATE_TRANSITION` entry). Keeping the rule as "transitions only".
- **Audit suggested cancel should update every non-terminal approval row's DM** — current fix only widens the filter to include `CLARIFICATION_REQUESTED` (and keeps `PENDING`). `DELEGATED` rows already had their DMs replaced with "Delegated to <@new>"; re-editing them is redundant. `APPROVED` / `REJECTED` rows are already terminal for the row's own DM lifecycle.
