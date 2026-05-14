# Curacel Expense Bot

Slack bot that automates expense and invoice tracking. Listens to `#expenses`, classifies each message via an LLM, logs the ticket to Google Sheets, runs a DM-based approval pipeline, and notifies the requester at every state change.


---

## Stack

- TypeScript + Node.js 20+ (single long-lived process)
- `@slack/bolt` in Socket Mode (no public webhooks)
- `openai` SDK pointed at OpenRouter, provider-locked to `anthropic` (no fallbacks)
- `googleapis` (Sheets v4) — Sheets is the only persistent store
- `express` (only for `GET /health`)
- `vitest` for tests

## Local setup

```bash
npm install
cp .env.example .env
# fill in .env (Slack tokens, OpenRouter key, Sheets ID, base64'd service account JSON, channel/user IDs)
```

### Bootstrap the Google Sheet

Once `.env` is filled in, create the four required tabs (`tickets`, `approvals`, `audit_log`, `routes`) with the right headers:

```bash
npm run bootstrap-sheet
```

Idempotent — safe to re-run. Will not overwrite existing data.

After bootstrap, add at least one row to the `routes` tab. Each ticket walks the route's `approvers_csv` left-to-right, advancing one step per Approve click.

| route_id | currency | min_amount | max_amount | category_filter | approvers_csv |
|---|---|---|---|---|---|
| default-ngn | NGN | 0 | | | U_FIRST_APPROVER |
| mid-ngn | NGN | 100000 | 1000000 | | U_FIRST,U_SECOND |
| high-ngn | NGN | 1000000 | | | U_FIRST,U_SECOND,U_FM |

### Run

```bash
npm run dev      # tsx watch
npm run build    # compile to dist/
npm start        # run compiled
npm test         # vitest
npm run typecheck
npm run lint
```

## Deploy

```bash
railway up --service expense-bot
```

Replica count must be **1** — the concurrency model relies on a single process. See PLAN.md §11.

## Phase 1.x — what works (validated end-to-end in a real workspace)

- One Slack channel listened to (`EXPENSES_CHANNEL_ID`)
- LLM classification (PNG / JPG / PDF page-1) with a smart pre-classify gate
- Multi-step approval chains via the `routes` sheet (no hardcoded user IDs)
- Approve · **Clarify** · **Delegate** · Reject buttons, each with a modal
- **Multi-expense splitting** — one Slack message can produce N tickets
- Mark-as-Paid → payment-proof watcher → forwards proof to source thread
- `/expense-resume EXP-YYMM-XXXX` — FM-only clarification resume
- `/expense-cancel EXP-YYMM-XXXX` — requester or FM
- Optional `#expense-log` feed (one-liner per state transition; gated on `EXPENSE_LOG_CHANNEL_ID`)
- Audit log for every transition through the state machine
- Boot-time reconciliation of non-terminal tickets
- Sheets writes are serialized with optimistic concurrency + retry-with-backoff
- OpenRouter calls are provider-locked to Anthropic (no fallbacks; test-asserted)
- Slack file downloads validate the URL host before sending the bot token
- `/health` endpoint, graceful shutdown

The only unchecked Phase 1.0 acceptance-box is **Railway deploy**.

See [NEXT.md](./NEXT.md) for the resumption brief and audit follow-ups.
