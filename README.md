# Curacel Expense Bot

Slack bot that automates expense and invoice tracking. Listens to `#expenses`, classifies each message via an LLM, logs the ticket to Google Sheets, runs a DM-based approval pipeline, and notifies the requester at every state change.

**See [PLAN.md](./PLAN.md) for the full design and scope. PLAN.md is the source of truth.**

---

## Stack

- TypeScript + Node.js 20+ (single long-lived process)
- `@slack/bolt` in Socket Mode (no public webhooks)
- `openai` SDK pointed at OpenRouter, provider-locked to `anthropic` (no fallbacks)
- `googleapis` (Sheets v4) — Sheets is the only persistent store
- `express` (only for `GET /health`)
- `vitest` for tests
- Deploys to Railway via `railway up`

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

After bootstrap, manually add at least one row to the `routes` tab (Phase 1.0 reads the first matching route's first approver):

| route_id | currency | min_amount | max_amount | category_filter | approvers_csv |
|---|---|---|---|---|---|
| default-ngn | NGN | 0 | | | U_THE_APPROVER_ID |

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

## Phase 1.0 spine — what works

- One Slack channel listened to (`EXPENSES_CHANNEL_ID`)
- Single-step approval, sourced from the `routes` sheet (no hardcoded IDs)
- Approve flow only (Reject / Clarify / Delegate are Phase 1.1–1.3)
- Single-expense classification (multi-split is Phase 1.4)
- LLM classification, thread ack, DM approval, Mark-as-Paid, payment proof forwarded to thread
- Boot-time reconciliation of non-terminal tickets
- `/health` endpoint
