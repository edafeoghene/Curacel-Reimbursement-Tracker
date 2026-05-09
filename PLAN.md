# Curacel Expense Bot — Product & Build Plan

> **Status:** Pre-build. This document is the source of truth for what we are building, how we are building it, and what we are explicitly not building. Treat any deviation from the **Hard Constraints** section as a failure that must be raised before continuing.

---

## 1. Project Identity

| | |
|---|---|
| **Name** | Curacel Expense Bot |
| **Owner** | Edafe (AI Automation Engineer, Curacel) |
| **Purpose** | Automate expense and invoice tracking on Slack — classify, log, route for approval, notify, and close. |
| **Repo** | TBD (private Bitbucket repo, deployed to Railway via CLI) |
| **Stage** | Phase 1 design complete, build not started |

---

## 2. Problem & Solution

### The problem

Curacel employees post expense requests (Ubers, equipment dispatches, repairs, invoices) into an internal Slack channel as short messages with attached receipts. The financial manager has to:

1. Manually keep track of which tickets exist, what type, what's approved, what's paid.
2. Manually notify the requester at every state change ("being processed", "approved", "paid").

This is high-friction, error-prone, and doesn't scale.

### The solution (Phase 1)

A Slack bot that lives on the expenses channel and runs an autonomous expense pipeline:

1. **Listens** to top-level messages in `#expenses`.
2. **Classifies** each message via an LLM — is this an expense/invoice request, and if so, what are the details?
3. **Logs** each expense as a row in a Google Sheet with a unique tracking ID.
4. **Acks** the requester in a threaded reply with the tracking ID.
5. **DMs** the first approver with the ticket details and approve/reject/clarify/delegate buttons.
6. **Advances** through the approval chain on each click.
7. **DMs the financial manager** when fully approved with a "Mark as Paid" button.
8. **Forwards** the payment confirmation back to the requester's thread when uploaded.
9. **Updates** the Google Sheet at every state transition.

### The solution (Phase 2)

A read-only Next.js frontend that visualizes the bot's work and the Sheet's data — ticket queue, status filters, audit timelines, per-approver workload.

---

## 3. Scope

### In scope (Phase 1)

- Single Slack workspace integration (Curacel)
- Single source channel (`#expenses`)
- DM-based approval flow
- Multi-step approval with amount-banded routing
- Reject, Clarify, Delegate branches
- Multi-expense detection per message
- Receipt parsing via vision (LLM)
- Google Sheets as system of record
- Audit log of every state transition

### Out of scope (Phase 1)

- Frontend / dashboard (Phase 2)
- Mobile app
- Multi-workspace support
- Direct integration with bank/payment APIs
- Automatic FX conversion
- Tax/VAT line-item splitting
- "Submit privately" path for sensitive expenses
- OCR fallback for unreadable receipts (manual-review state instead)

### Explicitly rejected designs (do not reintroduce)

- ❌ n8n or any low-code orchestrator
- ❌ Anthropic SDK direct (we have OpenRouter keys only)
- ❌ Postgres / Supabase / any external database
- ❌ Bitbucket Pipelines (deploy via Railway CLI directly)
- ❌ Public HTTPS webhook for Slack (use Socket Mode)
- ❌ Approvals in a shared private channel (we chose DMs)
- ❌ Auto-creating tickets from thread replies — **except** as completion of a pre-classify nudge (§8). A thread reply is processed only when the parent message previously triggered an in-memory `pendingNudges` entry AND the reply is from the original requester. Edits and replies on already-logged tickets are still ignored.
- ❌ Auto-reprocessing edited messages — **except** as completion of a pre-classify nudge (§8). An edit is processed only when the original message ts is in `pendingNudges`.

---

## 4. Hard Constraints (Non-Negotiable)

These are the rules. Every implementation decision must be checked against them.

1. **Language & runtime:** TypeScript + Node.js 20+. Single long-lived process.
2. **Slack:** `@slack/bolt` SDK in **Socket Mode**. No public webhooks.
3. **LLM:** OpenRouter via OpenAI-compatible SDK, with `provider.order: ["anthropic"]` and `allow_fallbacks: false` on every call. Never call the Anthropic API directly. Never accept a fallback to a non-Anthropic provider.
4. **Storage:** Google Sheets is the only persistent store. No database. No local files for state.
5. **Approval surface:** Direct messages from the bot to each approver. Not a shared channel.
6. **Deployment:** Railway, deployed manually via `railway up` from the local CLI. No Bitbucket Pipelines, no auto-deploy hooks.
7. **Concurrency model:** Single process, single async write queue serializing all sheet mutations. Optimistic concurrency via `row_version` column on read-modify-write.
8. **Source channel:** Bot only listens to top-level messages in one channel (`#expenses`). Thread replies and edits are filtered out at the event handler.
9. **Tracking ID format:** `EXP-YYMM-XXXX` where `XXXX` is a 4-character base32 random suffix.
10. **State changes only via the state machine:** No code path may write `status` to the sheet without going through `transition(currentState, event)`.

---

## 5. Architecture

### Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+, TypeScript (strict mode) |
| Slack | `@slack/bolt` (Socket Mode) |
| LLM | `openai` SDK pointed at `https://openrouter.ai/api/v1` |
| Sheets | `googleapis` (sheets v4), service account auth |
| HTTP (health only) | `express` (minimal) |
| Tests | `vitest` |
| Lint | `eslint`, `prettier` |
| Deploy | Railway via `railway` CLI |

### Process topology

One Node process running two things in parallel:

- A Bolt app on Socket Mode (websocket to Slack — no inbound HTTP needed)
- A tiny Express server on `$PORT` exposing `GET /health` (for Railway's health check)

No worker queues, no separate services. The single-process model is intentional — it makes the in-memory write queue trivially correct and the system easy to reason about. If load ever exceeds what one process can do (it won't — this is internal expense tracking), revisit then, not now.

### Why this shape

- **Socket Mode** removes the entire class of webhook-signing, public-endpoint, retry-payload concerns. Internal tools should always use Socket Mode unless there's a reason not to.
- **Single process** makes the Sheets concurrency story fixable with a simple async mutex. A multi-process or serverless deployment would require external locking.
- **No DB** is a constraint, but it forces a clean discipline: Sheets is the source of truth, in-memory state is rebuildable from it on boot.

---

## 6. OpenRouter Integration

### Client setup

```ts
import OpenAI from "openai";

export const llm = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://curacel.co",
    "X-Title": "Curacel Expense Bot",
  },
});
```

### Provider locking — every call

```ts
const response = await llm.chat.completions.create({
  model: "anthropic/claude-sonnet-4.6",  // confirmed; verify exact OpenRouter slug at first deploy
  // @ts-expect-error provider is OpenRouter-specific
  provider: { order: ["anthropic"], allow_fallbacks: false },
  response_format: { type: "json_object" },
  messages: [...],
});
```

**MUST:** Every LLM call passes `provider.order: ["anthropic"]` with `allow_fallbacks: false`. Build a thin wrapper `callLLM(messages, opts)` so this can never be forgotten.

### Vision payload format

Receipts are sent as OpenAI-style content parts (NOT Anthropic-native blocks):

```ts
{
  role: "user",
  content: [
    { type: "text", text: messageText },
    { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
  ],
}
```

### Reliability

- 30-second hard timeout on every call.
- Retry on 429/5xx with exponential backoff: 1s, 2s, 4s, then fail.
- On final failure: do **not** silently drop. Set ticket to `MANUAL_REVIEW` status, DM the financial manager, log the failure.

---

## 7. Slack Integration

### Listener: source channel only

```ts
slack.message(async ({ message, client }) => {
  if (message.channel !== EXPENSES_CHANNEL_ID) return;
  if (message.subtype === "message_changed") return;     // ignore edits
  if (message.subtype === "message_deleted") return;     // ignore deletes
  if (message.thread_ts && message.thread_ts !== message.ts) return;  // ignore thread replies
  if (message.bot_id) return;                            // ignore bots (incl. self)
  // proceed to classification
});
```

### DM pattern for approvals

For each pending approval step:

1. `client.conversations.open({ users: approver_user_id })` → channel ID
2. `client.chat.postMessage({ channel, blocks: [...] })` with the ticket summary, receipt thumbnail, and four buttons in an actions block.
3. Store `dm_channel_id` and `message_ts` on the approval row in Sheets.

On button click:

1. Verify `payload.user.id === ticket.current_approver_user_id`. If mismatch, `ack()` + ephemeral rejection. (DMs make this structurally hard to violate, but check anyway in case of stale clicks after delegation.)
2. Open the appropriate modal (Reject reason, Clarification question, Delegate user picker) or process Approve directly.
3. After the action completes, `chat.update` rewrites the original DM message to remove buttons and show the outcome (e.g. "✅ Approved · 14:32"). This prevents stale clicks.
4. Post the next state's DM (or close out if final).

### Modals

- **Reject:** single text input — "Reason"
- **Clarification:** single text input — "Question for the requester"
- **Delegate:** users_select element — "Reassign to"

All modals submit to handlers that update the sheet via the state machine before posting any user-facing message.

### The `#expense-log` channel (Option A — recommended)

A read-only public-to-the-finance-team channel. Bot posts a one-liner for every state transition:

> `EXP-2605-A7K2 · ₦45,000 laptop repair · approved by @patrick · awaiting @stephan`

No buttons, no interactivity. Pure feed. This restores shared awareness lost from moving approvals to DMs. Approvers and the financial manager join.

This is **opt-in**: env var `EXPENSE_LOG_CHANNEL_ID` enables it. If unset, skip these posts.

### Slack file download for receipts

Receipts are attached to the source message. URLs (`url_private`) require auth:

```ts
const res = await fetch(file.url_private, {
  headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
});
const buffer = Buffer.from(await res.arrayBuffer());
const b64 = buffer.toString("base64");
```

Store `file.id` and `file.url_private` on the ticket row. The URL is permanent if you have the token; for the Phase 2 frontend, we'll proxy through the backend.

---

## 8. LLM Classifier

### Input

- The full text of the source message.
- All image attachments (PNG, JPG) as base64 image_url parts.
- For PDFs: extract first page as image (use `pdf-poppler` or similar) and include as image_url. Document this as a known limitation — multi-page PDFs only send page 1 to the model.

### Output schema (strict JSON)

```json
{
  "is_expense": true,
  "confidence": 0.95,
  "items": [
    {
      "description": "Uber to client meeting and back",
      "category": "transport",
      "amount": 15000,
      "currency": "NGN",
      "vendor": "Uber",
      "date": "2026-05-08"
    }
  ],
  "notes": "Two trips grouped as one expense (same purpose)."
}
```

### Decision rules (embed in system prompt)

- **`is_expense`:** true only if the message clearly raises an expense or invoice for payment/reimbursement.
- **`confidence`:** if below 0.7, set ticket status to `MANUAL_REVIEW` rather than processing.
- **Multi-expense splitting:** "Group items as one expense if they share a single purpose or trip (e.g., outbound + return Uber for the same meeting). Split into separate expenses if items are for unrelated purposes (e.g., a laptop repair and a team lunch)." Each item in the array becomes its own ticket with its own tracking ID.
- **Amount/currency reconciliation:** if message says one amount and receipt says another, prefer the receipt and add a note flagging the discrepancy.

### Pre-classification gate (smart, two-stage)

Before calling the LLM:

1. If the message has an attachment **or** a parseable amount in the text → proceed to classification.
2. Otherwise, run a cheap regex check (`hasExpenseKeywords`) against the text for expense-shaped vocabulary (uber, bolt, paid, invoice, repair, subscription, lunch, ...). Three outcomes:
   - **Has expense keywords:** post the ephemeral nudge ("Looks like an expense — please attach a receipt or include the amount. Edit the message or reply in this thread with the missing piece and I'll log it.") AND register the source ts in an in-memory `pendingNudges` map (TTL 30 min, lazy GC, max 200 entries).
   - **No keywords (pure chatter):** silent drop. No nudge.
3. When a `message_changed` arrives whose parent ts is in `pendingNudges`, OR a thread reply arrives on a parent ts in `pendingNudges` (from the original requester), re-enter the pipeline using the new text/files and anchor the resulting ticket on the *parent* ts. Consume the nudge entry on success.

**State location:** `pendingNudges` is in-memory. Bot restart clears it; users can re-post in that case. PLAN §4 forbids persistent state outside Sheets, but pending nudges aren't load-bearing — they're a UX nicety.

---

## 9. Google Sheets — Schema

One workbook, four tabs.

### `tickets` (one row per expense)

| Column | Type | Notes |
|---|---|---|
| `tracking_id` | string | PK, format `EXP-YYMM-XXXX` |
| `created_at` | ISO timestamp | UTC |
| `source_message_ts` | string | Slack message ts of the original post |
| `source_channel_id` | string | always `EXPENSES_CHANNEL_ID` for Phase 1 |
| `requester_user_id` | string | Slack user ID |
| `requester_name` | string | display name (snapshot at creation) |
| `description` | string | from LLM |
| `category` | string | from LLM (transport / equipment / subscription / etc) |
| `amount` | number | |
| `currency` | string | ISO 4217 |
| `receipt_file_id` | string | Slack file ID |
| `receipt_file_url` | string | url_private |
| `status` | enum | see State Machine |
| `route_id` | string | FK to `routes.route_id` |
| `current_step` | int | 1-indexed step in approval chain |
| `current_approver_user_id` | string | Slack user ID |
| `payment_confirmation_file_id` | string | nullable, set on PAID |
| `updated_at` | ISO timestamp | bumped on every write |
| `row_version` | int | optimistic concurrency token |

### `approvals` (one row per approval step, append-only writes; updates only flip `decision`)

| Column | Type | Notes |
|---|---|---|
| `approval_id` | string | PK, UUID |
| `tracking_id` | string | FK |
| `step_number` | int | |
| `approver_user_id` | string | current assignee (changes on delegate) |
| `approver_name` | string | snapshot |
| `decision` | enum | `PENDING` / `APPROVED` / `REJECTED` / `CLARIFICATION_REQUESTED` / `DELEGATED` |
| `decided_at` | ISO timestamp | nullable until decided |
| `comment` | string | reject reason / clarification question / delegate target |
| `delegated_to_user_id` | string | nullable |
| `dm_channel_id` | string | for `chat.update` after decision |
| `message_ts` | string | for `chat.update` after decision |

### `audit_log` (append-only, no updates)

| Column | Type |
|---|---|
| `log_id` | UUID |
| `tracking_id` | string |
| `timestamp` | ISO |
| `actor_user_id` | string |
| `event_type` | string (e.g. `TICKET_CREATED`, `APPROVAL_GRANTED`, `STATE_TRANSITION`, `LLM_CLASSIFIED`, `RECEIPT_PARSED`) |
| `details_json` | string (stringified JSON of the event payload) |

### `routes` (config, edited manually by ops)

| Column | Type | Notes |
|---|---|---|
| `route_id` | string | e.g. `low-ngn`, `mid-ngn`, `high-ngn` |
| `currency` | string | ISO 4217 |
| `min_amount` | number | inclusive |
| `max_amount` | number | exclusive; empty = no upper bound |
| `category_filter` | string | comma-separated; empty = all categories |
| `approvers_csv` | string | comma-separated Slack user IDs in order |

Example rows:

```
low-ngn  | NGN | 0       | 50000   |          | U_STEPHAN
mid-ngn  | NGN | 50000   | 500000  |          | U_PATRICK,U_STEPHAN
high-ngn | NGN | 500000  |         |          | U_PATRICK,U_TINUS,U_STEPHAN
```

Routes are loaded into memory at boot and refreshed every 5 minutes.

---

## 10. State Machine

### States

```
SUBMITTED
AWAITING_APPROVAL          — at least one step pending
NEEDS_CLARIFICATION        — sent back to requester
APPROVED                   — all steps approved, ready for payment
AWAITING_PAYMENT           — financial manager has clicked "Mark as Paid", waiting for receipt
PAID                       — terminal
REJECTED                   — terminal
CANCELLED                  — terminal
MANUAL_REVIEW              — LLM failed or low confidence, financial manager handles manually
```

### Transitions

```
NEW MESSAGE        → SUBMITTED                      (after classify+log)
SUBMITTED          → AWAITING_APPROVAL              (after first DM sent)
SUBMITTED          → MANUAL_REVIEW                  (low confidence / LLM failure)
AWAITING_APPROVAL  → AWAITING_APPROVAL              (approve, advance step)
AWAITING_APPROVAL  → APPROVED                       (final approval granted)
AWAITING_APPROVAL  → REJECTED                       (any step rejects)
AWAITING_APPROVAL  → NEEDS_CLARIFICATION            (any step requests clarification)
NEEDS_CLARIFICATION → AWAITING_APPROVAL             (financial manager runs /expense-resume)
APPROVED           → AWAITING_PAYMENT               (financial manager clicks Mark as Paid)
AWAITING_PAYMENT   → PAID                           (financial manager uploads receipt)
ANY non-terminal   → CANCELLED                      (requester runs /expense-cancel <id>)
```

### Implementation rule

Implement this as a pure function in `src/state/machine.ts`:

```ts
type Event =
  | { type: "CLASSIFIED"; confidence: number }
  | { type: "FIRST_DM_SENT" }
  | { type: "APPROVE"; step: number; approver: string }
  | { type: "REJECT"; step: number; reason: string }
  | { type: "CLARIFY"; step: number; question: string }
  | { type: "RESUME_AFTER_CLARIFY" }
  | { type: "MARK_AS_PAID" }
  | { type: "PAYMENT_CONFIRMED"; file_id: string }
  | { type: "CANCEL" };

export function transition(
  ticket: Ticket,
  event: Event
): { next: Status; sideEffects: SideEffect[] } | { error: string } {
  // pure, no I/O
}
```

No code path may write to the `status` column without going through this function.

---

## 11. Concurrency Model

### The problem

Multiple button clicks can land within the same second. Sheets has no transactions. Naive read-modify-write loses updates.

### The solution

**1. Single async write queue.** All sheet mutations go through:

```ts
let writeChain: Promise<void> = Promise.resolve();

export function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeChain.then(() => fn());
  writeChain = result.then(() => undefined, () => undefined);
  return result;
}
```

This serializes writes within the process. Reads remain concurrent.

**2. Optimistic concurrency on tickets.** Every update reads `row_version`, writes with `row_version + 1`, and verifies the row didn't change between read and write. On conflict: retry up to 3 times, then fail loudly.

**3. Boot-time reconciliation.** On startup, scan `tickets` for non-terminal statuses and rebuild in-memory state. No persistent local cache needed.

### What this does NOT protect against

- Multiple instances of the bot running. **MUST NOT** run more than one instance. Railway service must be configured for replica count = 1.

---

## 12. Tracking ID Format

```
EXP-YYMM-XXXX
```

- `EXP` — fixed prefix
- `YYMM` — 2-digit year + 2-digit month (e.g. `2605` for May 2026)
- `XXXX` — 4 random characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (Crockford-ish, no ambiguous chars)

Generated client-side, no coordination needed. Collision probability per month: ~1 in 1M for typical volume; if a write detects a duplicate `tracking_id`, regenerate and retry.

---

## 13. User Flows

### 13.1 Submission (happy path)

1. Employee posts in `#expenses`: "Repaired the office laptop charging port, ₦15,000" + attaches receipt.png
2. Bot's message handler fires.
3. Bot downloads the receipt, calls LLM classifier with text + image.
4. LLM returns `{ is_expense: true, confidence: 0.96, items: [{ amount: 15000, currency: "NGN", category: "equipment", ... }] }`.
5. Bot resolves route → `low-ngn` → approvers `[U_STEPHAN]`.
6. Bot generates `EXP-2605-A7K2`, writes ticket row + first approval row.
7. Bot replies in thread: "Logged as `EXP-2605-A7K2`. Routing to @stephan for approval."
8. Bot opens DM with Stephan, posts ticket summary + 4 buttons.
9. Bot logs `TICKET_CREATED` in audit_log.
10. State: `AWAITING_APPROVAL`.

### 13.2 Approval (advancing)

1. Stephan clicks Approve in DM.
2. Bot verifies `clicker == current_approver_user_id`.
3. Bot updates approval row (decision = APPROVED).
4. Bot edits Stephan's DM message to remove buttons, add "✅ Approved · 14:32".
5. State machine: if more steps, `AWAITING_APPROVAL` (next step); if last, `APPROVED`.
6. If more: bot opens DM with next approver, posts buttons.
7. If last: bot DMs financial manager with "Mark as Paid" button. State: `APPROVED` then `AWAITING_PAYMENT` after click.
8. Bot posts to `#expense-log` if enabled.

### 13.3 Rejection

1. Approver clicks Reject. Modal opens asking for reason.
2. Modal submits → bot updates approval row (decision = REJECTED, comment = reason).
3. Bot edits the DM message: "❌ Rejected · reason: ...".
4. Bot posts in requester's `#expenses` thread tagging requester: "Sorry @edafe, this expense was rejected by @patrick. Reason: ..."
5. State: `REJECTED` (terminal).

### 13.4 Clarification

1. Approver clicks Request Clarification. Modal opens for question.
2. Modal submits → bot updates approval row (decision = CLARIFICATION_REQUESTED, comment = question).
3. Bot edits DM: "❓ Awaiting clarification".
4. Bot posts in requester's thread: "@edafe, @patrick has a question: ..."
5. Bot DMs financial manager: "Ticket EXP-XXXX is awaiting clarification from @edafe. Run `/expense-resume EXP-XXXX` once they've replied to resume the approval flow."
6. State: `NEEDS_CLARIFICATION`.
7. Requester replies in thread (free text — bot does not parse).
8. Financial manager runs slash command `/expense-resume EXP-2605-A7K2`. Bot rolls state back to `AWAITING_APPROVAL` at the same step, re-DMs the approver with the original ticket + a "Clarification posted in thread, please re-review" note.

**Why manual resume:** auto-detecting that a clarification has been resolved is a bad use of LLM judgement at this stage. Manual is one extra command for the financial manager but eliminates an entire class of bugs.

### 13.5 Delegation

1. Approver clicks Delegate. Modal opens with users_select.
2. Modal submits → bot updates approval row (`approver_user_id` becomes the delegate, original logged in `delegated_to_user_id`).
3. Bot edits original DM: "Delegated to <@new>".
4. Bot opens DM with the new approver, posts buttons. New approver is now the only authorized clicker.
5. State unchanged (still `AWAITING_APPROVAL`).

### 13.6 Payment

1. After last approval, bot DMs financial manager: ticket summary + "Mark as Paid" button.
2. State: `APPROVED`.
3. Financial manager clicks Mark as Paid.
4. Bot edits DM: "💰 Awaiting payment confirmation. Reply to this DM with the proof of payment within 24h."
5. State: `AWAITING_PAYMENT`. Sheet records `payment_pending_since`.
6. Bot watches DMs for the next file upload **from this user, in this DM channel**, within 24h.
7. Once received: bot stores `payment_confirmation_file_id`, posts in requester's `#expenses` thread with the proof attached: "Payment processed for EXP-2605-A7K2 ✅"
8. State: `PAID` (terminal).
9. If 24h elapses with no file: bot DMs financial manager a reminder. They can re-trigger by posting the file or by re-clicking "Mark as Paid" (button is restored if needed).

### 13.7 Cancellation

Slash command `/expense-cancel <tracking_id>`. Only the requester or financial manager can run it. Allowed in any non-terminal state. Sets state to `CANCELLED`, posts in requester's thread, edits any pending DMs to remove buttons and show "Cancelled".

---

## 14. Edge Cases & Caveats — Comprehensive

| Case | Handling |
|---|---|
| Thread reply in `#expenses` (parent has no pending nudge) | **Ignored.** Filter at event handler. |
| Thread reply in `#expenses` (parent has a pending nudge, reply is from the original requester) | **Processed** as a nudge completion — combined parent+reply text and reply files re-enter the pipeline, ticket anchors on the parent ts. |
| Edit to original message after a ticket has been logged | **Ignored.** Filter `message_changed` subtype. |
| Edit to a message that has a pending nudge (no ticket yet) | **Processed** as a nudge completion — new text/files re-enter the pipeline, ticket anchors on the original ts. |
| Pure chatter ("hello", "good morning") with no attachment, no amount, no expense keywords | **Silent drop.** No ephemeral, no LLM call. |
| Multiple expenses in one message, related | LLM groups as one ticket. |
| Multiple expenses in one message, unrelated | LLM splits; bot creates N tickets, one ack listing all IDs. |
| LLM returns `is_expense: false` | Bot does nothing. No reply. |
| LLM returns confidence < 0.7 | Status `MANUAL_REVIEW`. Financial manager handles. |
| LLM API failure (after retries) | Status `MANUAL_REVIEW`. DM financial manager. |
| Message with no attachment AND no parseable amount | Ephemeral nudge to user, skip classification. |
| Receipt amount ≠ message amount | Prefer receipt amount, flag in `notes` column for human review. |
| Currency in message ≠ currency on receipt | Prefer receipt currency, flag. |
| PDF receipt with multiple pages | Use page 1 only, log warning. Phase 2 can improve. |
| Duplicate submission (same amount, vendor, date) | Log warning in audit_log; do NOT auto-merge. Financial manager decides. |
| Concurrent button clicks on same ticket | Write queue serializes; second click sees updated row_version, gets ephemeral "already processed". |
| Wrong-user clicks button after delegation | Authorization check fails, ephemeral rejection. |
| Approver out of office | Use Delegate. No automatic OOO detection in Phase 1. |
| Approver doesn't act for days | No auto-escalation in Phase 1. Financial manager nudges manually or uses `/expense-cancel`. |
| Bot restart mid-flow | On boot, reconcile non-terminal tickets from sheet. In-flight LLM calls are lost; affected tickets stay in `SUBMITTED` and need a manual nudge (rare). |
| Slack websocket drops | Bolt auto-reconnects. Health endpoint flips to 503 if down >threshold. Railway restarts container. |
| Slack queues a button click during downtime | Slack retries for ~3s. Beyond that, click is lost. Mitigation: keep deploys fast (<30s). |
| Late payment confirmation (>24h) | Bot DMs reminder; financial manager can re-click Mark as Paid to reset window. |
| Payment confirmation uploaded to wrong DM | Bot only watches the specific DM channel for the specific user. Wrong-DM uploads are ignored. |
| Routes config malformed | Fail loudly at boot. Don't start. |
| Required env var missing | Fail loudly at boot. Don't start. |
| Sheet structure changed | Fail loudly at first read. Don't proceed silently. |
| Bot deleted from a DM | Re-open conversation on next interaction; should "just work". |
| User blocks the bot | Bot will get an error opening DM. Set ticket to `MANUAL_REVIEW` and DM financial manager. |

---

## 15. Module Layout

```
expense-bot/
├── src/
│   ├── index.ts                    # Bolt + Express boot, graceful shutdown
│   ├── config.ts                   # env parsing, fail-fast on missing vars
│   ├── slack/
│   │   ├── events.ts               # message handler (filter + dispatch)
│   │   ├── interactivity.ts        # button + modal handlers
│   │   ├── views.ts                # modal definitions (reject, clarify, delegate)
│   │   ├── messaging.ts            # DM helpers, thread reply helpers, log channel
│   │   ├── files.ts                # download Slack files with auth
│   │   └── slash.ts                # /expense-cancel, /expense-resume
│   ├── llm/
│   │   ├── client.ts               # OpenRouter wrapper with provider lock + retries
│   │   ├── classify.ts             # classifier orchestration
│   │   └── prompts.ts              # system prompts
│   ├── sheets/
│   │   ├── client.ts               # service account auth, raw API
│   │   ├── tickets.ts              # CRUD + row_version logic
│   │   ├── approvals.ts
│   │   ├── audit.ts                # append-only logger
│   │   ├── routes.ts               # cached, refresh every 5min
│   │   └── queue.ts                # serial write queue
│   ├── state/
│   │   ├── machine.ts              # pure transition function
│   │   ├── routing.ts              # resolveRoute(amount, currency, category)
│   │   └── reconcile.ts            # boot-time state rebuild
│   ├── id.ts                       # tracking ID generator
│   ├── health.ts                   # Express /health
│   └── types.ts
├── tests/
│   ├── state/machine.test.ts       # state transitions
│   ├── llm/classify.test.ts        # mocked OpenRouter responses
│   └── id.test.ts
├── .env.example
├── tsconfig.json
├── package.json
├── eslint.config.js
├── README.md
└── PLAN.md                         # this file
```

---

## 16. Environment Variables

All required unless marked optional. Bot fails to start if any required var is missing.

```
# Slack
SLACK_BOT_TOKEN=xoxb-...                # bot user OAuth token
SLACK_APP_TOKEN=xapp-...                # Socket Mode app-level token (connections:write)

# OpenRouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=anthropic/claude-sonnet-4.6  # confirmed by Edafe 2026-05-09 — verify exact OpenRouter slug at first deploy

# Google Sheets
GOOGLE_SHEETS_ID=1AbC...                # the workbook ID
GOOGLE_SERVICE_ACCOUNT_B64=eyJ0eXA...   # base64 of the service account JSON file

# Slack channel/user IDs
EXPENSES_CHANNEL_ID=C0...               # source channel
EXPENSE_LOG_CHANNEL_ID=C0...            # OPTIONAL — Option A read-only feed
FINANCIAL_MANAGER_USER_ID=U0...         # who gets payment DMs

# Runtime
PORT=3000                               # Railway sets this; default for local
NODE_ENV=production
LOG_LEVEL=info
```

The service account JSON is base64'd to avoid multi-line headaches in Railway. Decode at boot:

```ts
const sa = JSON.parse(
  Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64!, "base64").toString("utf8")
);
```

---

## 17. Health & Operations

### Health endpoint

```ts
const health = express();
let socketReady = false;

health.get("/health", (_, res) => {
  if (!socketReady) return res.status(503).send("socket not connected");
  res.send("ok");
});
```

`socketReady` flips true after `slack.start()` resolves and false on shutdown. Railway uses this for restart decisions.

### Graceful shutdown

```ts
const shutdown = async () => {
  socketReady = false;
  await slack.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

### Railway config

- Service replica count: **1** (must not run multiple instances — concurrency model breaks).
- Health check path: `/health`
- Health check timeout: 60s
- Restart policy: on-failure
- Build: Nixpacks (no Dockerfile needed for v1)
- Start command: `npm start`

### Deploy

```bash
railway up --service expense-bot
```

Run from local machine. No CI/CD. Document this in README.

### Logs & monitoring

- Use Railway's built-in logs for v1 (`railway logs`).
- Add Better Stack uptime monitor on `/health` once stable.
- Critical logs to emit:
  - Every state transition (already captured in audit_log)
  - Every LLM call: model, tokens, duration, success/failure
  - Every sheet write: table, operation, duration, retry count
  - Every authorization rejection (wrong-user click)

---

## 18. Claude Code Guardrails

> **Read this section before generating any code.**

### Things you MUST do

- Use TypeScript strict mode.
- Use the `callLLM()` wrapper for every OpenRouter call. Never construct the request inline — provider lock must be enforced at one place.
- Use `enqueueWrite()` for every sheet mutation. No direct sheet writes.
- Use `transition()` for every state change. Read the current state, compute next, write.
- Append to `audit_log` for every state transition and every LLM call.
- Validate env vars at boot. Fail fast.
- Filter message events for `subtype !== "message_changed"`, `!message.bot_id`, `!message.thread_ts || message.thread_ts === message.ts`.
- Verify `payload.user.id === ticket.current_approver_user_id` on every button click. Yes, even though DMs make this hard to violate.
- Edit DM messages with `chat.update` after handling buttons to prevent stale clicks.

### Things you MUST NOT do

- Do not import `@anthropic-ai/sdk`. We use OpenRouter only.
- Do not introduce a database, KV store, Redis, or persistent local file (other than transient receipt buffers).
- Do not introduce a public webhook for Slack. Socket Mode only.
- Do not post approval-action messages to a shared channel — DMs only.
- Do not auto-create tickets from thread replies.
- Do not auto-reprocess edited messages.
- Do not retry LLM calls more than 3 times before falling to `MANUAL_REVIEW`.
- Do not write `status` to the sheet outside the state machine.
- Do not add a Dockerfile in v1 (Nixpacks is sufficient).
- Do not add Bitbucket Pipelines or any other CI/CD.

### When you must ask the user instead of guessing

- Final OpenRouter model string (verify on OpenRouter docs at build time).
- Initial routes config (amount bands and approver Slack user IDs — these come from Stephan).
- Whether to enable the `#expense-log` read-only channel (Option A).
- The final list of expense categories the LLM should classify into.
- Whether `/expense-cancel` should be requester-only or also include the financial manager (default: both).

---

## 19. Implementation Roadmap

Tick checkboxes as work completes. Each phase has an explicit acceptance test.

### Phase 1.0 — Spine (target: 2 days)

The minimum end-to-end working bot. **No hardcoded approver IDs anywhere in code.** A single seed row in the `routes` sheet provides the approver(s); the bot reads it at boot. This means resignations / approver swaps are a sheet edit, never a code change. Single-step routing only in 1.0; full amount-banded `resolveRoute` lands in 1.5.

- [ ] Project scaffold: tsconfig, eslint, prettier, vitest, package.json
- [ ] `config.ts` with env-var validation
- [ ] Sheets client + all 4 tabs (`tickets`, `approvals`, `audit_log`, `routes`) bootstrapped programmatically
- [ ] `enqueueWrite()` queue
- [ ] `transition()` state machine for the happy path only
- [ ] `id.ts` tracking ID generator with tests
- [ ] OpenRouter client with provider lock and `callLLM()` wrapper
- [ ] Classifier returning JSON for single-expense messages (no multi-split yet)
- [ ] Slack Bolt app boots in Socket Mode, listens to one channel
- [ ] Source-message filters in place (no threads, no edits, no bots)
- [ ] On classified expense: write ticket row, ack in thread, DM the first approver from `routes` sheet
- [ ] Approve button → write approval row, edit DM, DM financial manager
- [ ] Mark as Paid button → state = AWAITING_PAYMENT, prompt for receipt
- [ ] Receipt upload watcher → forward to thread, state = PAID
- [ ] `/health` endpoint
- [ ] Boot-time reconciliation
- [ ] Deploy to Railway via CLI, end-to-end test in real workspace

**Acceptance:** an employee can post a receipt, get acknowledged, the (single) approver can approve in DM, the financial manager can mark as paid and upload proof, the requester gets the proof in their thread, and the sheet reflects every step.

### Phase 1.1 — Reject branch

- [x] Reject button → modal for reason
- [x] Modal submit → state = REJECTED, post in requester thread
- [x] Edit DM to show rejection
- [x] Audit log entry
- [x] Test: rejection flow end-to-end (validated 2026-05-09 — `EXP-2605-RVYP`)

### Phase 1.2 — Clarification branch

- [ ] Request Clarification button → modal for question
- [ ] Modal submit → state = NEEDS_CLARIFICATION, post in requester thread, DM financial manager
- [ ] `/expense-resume <id>` slash command
- [ ] Resume re-DMs the approver with the clarification context
- [ ] Audit log entries
- [ ] Test: full clarify-then-resume cycle

### Phase 1.3 — Delegate branch

- [ ] Delegate button → modal with user picker
- [ ] Modal submit → reassign approver, edit DM, open DM with delegate
- [ ] Authorization check uses updated `current_approver_user_id`
- [ ] Audit log entry
- [ ] Test: delegate then approve as new user

### Phase 1.4 — Multi-expense splitting

- [ ] Update classifier prompt with grouping rule
- [ ] Handler creates N tickets when classifier returns multiple items
- [ ] Single thread ack lists all tracking IDs
- [ ] Test: message with two unrelated items → two tickets

### Phase 1.5 — Routes-driven multi-step approvals

- [ ] `routes` sheet schema, manual data entry
- [ ] `routes.ts` loader + 5-min refresh
- [ ] `resolveRoute(amount, currency, category)` function
- [ ] Approval handler advances through full chain, not just one approver
- [ ] Test: high-amount expense routes through 3 approvers in order

### Phase 1.6 — `/expense-cancel`

- [ ] Slash command implementation
- [ ] Authorization (requester or financial manager only)
- [ ] State transition to CANCELLED, edit pending DMs, post in thread
- [ ] Test: requester cancels mid-flow

### Phase 1.7 — Read-only log channel (optional, Option A)

- [ ] Conditional on `EXPENSE_LOG_CHANNEL_ID` being set
- [ ] One-liner posted on every state transition
- [ ] Test: full ticket lifecycle visible as feed

### Phase 1.8 — Hardening

- [ ] Edge cases from §14 covered with tests
- [ ] Manual review path for low-confidence and LLM failures
- [ ] Pre-classification gate (no attachment + no amount → ephemeral nudge)
- [ ] Receipt-vs-message reconciliation flag
- [ ] Duplicate detection warning
- [ ] Better Stack monitor on `/health`
- [ ] README for ops handover

### Phase 1 Definition of Done

- All boxes above checked.
- Two weeks of real usage at Curacel without manual sheet edits to fix bot mistakes.
- Audit log shows zero state writes outside the state machine.
- Zero approvals ever processed by the wrong user.

### Phase 2 — Frontend (separate plan, future)

- [ ] Next.js app reading from Sheets API server-side
- [ ] Ticket queue with status filters
- [ ] Per-ticket detail page with audit timeline
- [ ] Per-approver workload view
- [ ] Receipt and payment-proof preview (proxied through backend)
- [ ] Polling or on-demand refresh (no realtime needed)
- [ ] Auth (Slack OAuth or company SSO)

---

## 20. Open Decisions

These are not blockers for Phase 1.0 but must be resolved before subsequent phases:

1. **Final OpenRouter model string.** Check OpenRouter's models page when starting build; pick the strongest current Claude with vision support.
2. **Routes config.** Get from Stephan: amount bands (in NGN and any other currencies you accept) and the Slack user IDs of approvers per band.
3. **Category list.** Fixed enum for the LLM to classify into. Suggested starter: `transport`, `equipment`, `repair`, `subscription`, `meals`, `travel`, `professional_services`, `other`.
4. **`#expense-log` channel.** Yes/no? Recommendation is yes.
5. **Cancellation rights.** Requester only, or also financial manager? Default: both.
6. **OOO/auto-escalation.** Out of scope for Phase 1; revisit if it becomes a real problem in usage.
7. **Multi-page PDFs.** Page 1 only in Phase 1. Phase 2 might add proper handling.

---

## 21. Glossary

| Term | Meaning |
|---|---|
| Source message | The original Slack post in `#expenses` that triggers a ticket. |
| Tracking ID | The `EXP-YYMM-XXXX` identifier for a ticket. |
| Approval step | One row in the `approvals` table; one decision by one approver. |
| Route | A configured chain of approvers selected based on amount/currency/category. |
| Spine | The minimum end-to-end happy path (Phase 1.0). |
| Manual review | Status used when the bot can't confidently process a message and the financial manager handles it directly. |
| Reconciliation | Boot-time scan of the tickets sheet to rebuild in-memory state. |

---

*End of plan. Treat this document as the contract. If reality forces a deviation, update this file in the same commit.*
