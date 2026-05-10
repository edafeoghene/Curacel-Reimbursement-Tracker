# NEXT — Phase 2 plan: FM frontend (read-only Next.js dashboard, Google-OAuth-gated)

> **Read order:** [PLAN.md](./PLAN.md) is the source of truth. This file is a *resumption brief* — it captures what shipped in Phase 1, what's coming in Phase 2, and the open decisions that need user sign-off before any code lands. Always reconcile against PLAN.md if anything below conflicts.

---

## Snapshot — where we are (2026-05-10)

**Phase 1 of the Slack expense bot is complete and validated end-to-end in the live `Ad Lab` workspace.** Latest validated ticket: `EXP-2605-C5ME` walked through clarify → `/expense-resume` → 2-step approval → Mark as Paid → file proof → **PAID**.

```
2f56522 fix(events): payment-proof predicate must exclude the expenses channel
35854b6 revert: keep NGN currency default in routeToManualReview
11c36fc docs: refresh NEXT.md and README to match shipped state (audit §13)
7614aa6 fix: address audit findings §7, §8, §9, §11, §12, §15, §18, §19
508fb64 fix(sheets): retry-with-backoff on transient Sheets errors (audit §14)
89d3a32 docs: NEXT.md follow-ups for deferred audit items
fe40a3a test: provider lock assertion for OpenRouter calls (audit §6)
1393a68 fix: address audit findings §1, §2, §3
487ae94 fix: open Reject/Clarify/Delegate modals before sheet read
4399c1b phase 1.7: optional #expense-log feed channel
506567c phase 1.6: /expense-cancel slash command
17c09f8 phase 1.4: multi-expense splitting
2ddfedc phase 1.3: delegate button + user-picker modal
6a600eb phase 1.2: clarification branch + /expense-resume slash command
64f78ca fm DM: tag prior approver(s) on Mark as Paid
78024a5 phase 1.5: multi-step routing across route.approvers chain
… plus the Phase 1.0 spine + hardening commits before that.
```

- **221 tests** passing across 17 files (`npm test`).
- `npm run typecheck` (now includes `tests/` via `tsconfig.test.json`) clean.
- `npm run build` clean.
- Bot has been run locally via `npm run dev` against the live workspace.

**The only Phase 1 acceptance-box still unchecked is Railway deploy.** That can be done in parallel with Phase 2 setup or after — it's a one-shot `railway up` once an env file is provisioned on the service. Phase 2 does not block on it.

Audit follow-ups deferred (full sketches near the bottom of [the previous NEXT history in git](./)): A) file-share watcher full-table scans, B) `PAYMENT_STEP_SENTINEL=99` magic value → real Ticket fields, C) test gap on the bigger handler files, D) `args: any` on Bolt registrations, E) splitting events.ts / interactivity.ts, F) O(n) full-table sheet reads. None of these block Phase 2; pick them up when they bite.

---

## Phase 2 scope (per [PLAN.md §19](./PLAN.md))

> "A read-only Next.js frontend that visualizes the bot's work and the Sheet's data — ticket queue, status filters, audit timelines, per-approver workload."

The user has refined PLAN.md §19's auth checkbox ("Slack OAuth or company SSO") to a specific shape:

- **Google OAuth** as the only sign-in method.
- **Domain restriction:** only `@curacel.ai` Google accounts may sign in (via the `hd=curacel.ai` hosted-domain hint AND a server-side claim assertion — the `hd` URL parameter is advisory, not enforcement).
- **Per-email allowlist** held in `.env` as `ALLOWED_FM_EMAILS=alice@curacel.ai,bob@curacel.ai`. Login from a curacel.ai account NOT on the allowlist is denied. This is the load-bearing gate. The domain check is defense-in-depth; the allowlist is the actual policy.

### Feature surface (from PLAN.md §19, refined)

- [ ] Google sign-in / sign-out (NextAuth.js or equivalent)
- [ ] Ticket queue page with filters (status, requester, route, date range, currency)
- [ ] Per-ticket detail page: header + approval-row timeline + audit-log entries + receipt preview + payment-proof preview
- [ ] Per-approver workload view (counts of pending tickets per approver)
- [ ] Receipt + payment-proof image proxy: backend fetches `url_private` from Slack with the bot token and streams to the browser; the bot token is never exposed client-side
- [ ] Polling or on-demand refresh — no realtime (PLAN.md §19 explicitly says no realtime needed)
- [ ] Read-only. No writes back to the Sheet. No buttons that mutate state. (Mutations stay in the bot, which is the only system of record write path.)

### Out of scope (Phase 2)

- Approving / rejecting from the dashboard (that stays in DM-button territory; PLAN.md §4 #5 mandates DMs as the approval surface)
- Editing tickets directly
- Multi-tenant / multi-workspace UI (single Curacel workspace, same as bot)
- Mobile-specific layouts beyond responsive defaults
- Public-facing pages — entire app is behind auth

---

## Hard constraints carried forward from Phase 1

These are still non-negotiable in Phase 2:

1. **No new database.** Google Sheets remains the only persistent store ([PLAN.md §4 #4](./PLAN.md)). The frontend reads via the same `googleapis` client used by the bot.
2. **No writes to the Sheet from the frontend.** Every state mutation must go through `transition()` in the bot. The frontend is strictly read-only.
3. **No exposing service-account JSON or `SLACK_BOT_TOKEN` to the browser.** All Sheets reads and Slack file fetches happen server-side (Next.js Server Components / Route Handlers).
4. **TypeScript strict mode** consistent with the bot's `tsconfig`.
5. **Single source channel + financial manager** — same `EXPENSES_CHANNEL_ID` and `FINANCIAL_MANAGER_USER_ID` env vars as the bot reads. No new identity sources.
6. **Single-process operating model preserved** — the frontend is a separate process from the bot; the bot stays load-bearing for state.

---

## Open decisions — RESOLVE BEFORE CODING

The user wants alignment on these before we start. Defaults below are recommendations, not commitments. None of these affect the Phase 1 codebase.

| # | Decision | Default (recommendation) | Why it matters |
|---|---|---|---|
| 1 | **Repo layout:** monorepo with bot + frontend, or separate repo? | Monorepo with `frontend/` folder (or pnpm workspace) | Shared types (`Ticket`, `Approval`, `AuditLogEntry`) live in [src/types.ts](./src/types.ts). Duplicating them across repos is a future-bug factory. |
| 2 | **Hosting:** Vercel or Railway? | **Vercel** for the frontend (Railway stays for the bot) | Vercel is the obvious Next.js host. Railway works but Vercel's Next.js DX is materially better. PLAN.md §6 mandates Railway only for the bot; the frontend is unconstrained. |
| 3 | **Auth library:** NextAuth.js (Auth.js v5), or hand-rolled `google-auth-library` + JWT cookies? | **NextAuth.js** (Auth.js v5, with the Google provider) | Battle-tested, supports `hd=curacel.ai`, lets us inject the `signIn` callback for the allowlist check. Hand-rolling buys little and is more attack surface. |
| 4 | **UI library:** shadcn/ui (Tailwind), Mantine, plain Tailwind, etc.? | **shadcn/ui + Tailwind** | Best DX for a small dashboard. Easy to keep consistent, easy to copy-paste components. |
| 5 | **App Router vs Pages Router?** | **App Router** (Server Components by default; Route Handlers for the file proxy) | Modern Next.js default. Allows server-side Sheets reads without exposing creds. |
| 6 | **Cache strategy:** SSR with `revalidate`, vs. client-side fetch + interval polling? | **SSR with a short `revalidate` (~30s) + a manual "refresh" button** | Sheets data is small and rarely-changing; SSR is simpler than client polling. PLAN.md §19: "polling or on-demand refresh — no realtime needed." |
| 7 | **Pagination shape for ticket queue:** URL-paramed (`?status=…&page=…`) or cursor / infinite scroll? | **URL params** | Bookmarkable, shareable links to filtered views. The dataset is small enough that offset pagination is fine. |
| 8 | **Image preview cache:** stream every receipt request through Slack each time, or cache server-side? | **Stream every time** for Phase 2.0 | Phase 2.0 keeps it stateless — no caching layer. Caching is a Phase 2.x optimization once we know the access patterns. |
| 9 | **Allowlist normalization:** case-insensitive, trim, etc. | Lowercase + trim on both the `.env` parse and the OAuth-returned email | Standard hygiene. The `.env` will be edited by humans; tolerate whitespace and case. |
| 10 | **Session strategy:** JWT cookies (default for NextAuth Edge) or database sessions? | **JWT cookies** | We have no database. NextAuth's JWT mode is fine. Sessions live in the encrypted cookie. |

The user should sign off on each before we open the worktree.

---

## Suggested implementation waves

Same shape as Phase 1.0/1.1/etc. — small commits, each independently testable. Preliminary sequencing:

### Wave 2.0 — Auth spine

1. Bootstrap `frontend/` with Next.js 15 (App Router) + TypeScript strict + Tailwind + shadcn/ui.
2. NextAuth.js (Auth.js v5) with the Google provider. Configure the `hd=curacel.ai` hint.
3. `signIn` callback enforces: `email.endsWith("@curacel.ai")` AND `email` is in `ALLOWED_FM_EMAILS` (parsed from `.env`, lowercased + trimmed).
4. Protected layout (everything except `/api/auth/*` and `/login` requires a session).
5. Sign-out button + simple "you're not allowed here" rejection page for users who pass Google OAuth but fail the allowlist.
6. Tests: signIn callback unit-test against fixtures (allowed, wrong-domain, right-domain-not-on-list).

### Wave 2.1 — Sheets-read layer (server-only)

1. New `frontend/lib/sheets/` mirroring the bot's `src/sheets/` shape — `tickets.ts`, `approvals.ts`, `audit.ts` — but `noEmit` reads only.
2. Either reuse the bot's types via a shared `packages/shared/types.ts`, or copy-paste `Ticket`/`Approval`/`AuditLogEntry`/`Status` definitions if we keep separate repos. Decide per Open Decision #1.
3. Each sheets-read helper accepts a service-account credentials object from env (same `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` env var the bot uses).
4. Tests against fixture rows.

### Wave 2.2 — Ticket queue page

1. `app/(dashboard)/tickets/page.tsx` — Server Component, reads `listAllTickets()` server-side, renders a table.
2. Status / requester / route / currency / date filters via URL params.
3. Sort by `created_at` desc, paginate (URL-paramed).
4. Manual "refresh" button (`router.refresh()`) + a `revalidate` of ~30s.

### Wave 2.3 — Per-ticket detail page

1. `app/(dashboard)/tickets/[trackingId]/page.tsx` — Server Component, reads `getTicketByTrackingId` + `listApprovalsForTicket` + `listAuditEntriesForTicket`.
2. Header card: tracking ID, status, amount, requester, route, current step.
3. Approval timeline: each row's step + decision + decided_at + comment + delegated_to_user_id.
4. Audit log: every event_type + details_json rendered nicely.
5. Receipt preview: `<img src="/api/files/{ticket.receipt_file_id}">` — the proxy fetches with the bot token and streams.
6. Payment-proof preview: same pattern via `payment_confirmation_file_id`.

### Wave 2.4 — Per-approver workload + polish

1. `app/(dashboard)/workload/page.tsx` — counts of `PENDING` approval rows per `approver_user_id`, sorted by count desc.
2. Friendly user-name column (resolve via Slack `users.info`, cached in-memory).
3. Empty states, error states, mobile-responsive defaults.

### Wave 2.5 — Deploy

1. Set up Vercel project, link the env vars (Google OAuth client ID/secret, NEXTAUTH_SECRET, NEXTAUTH_URL, `ALLOWED_FM_EMAILS`, `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `SLACK_BOT_TOKEN` for the file proxy, `EXPENSES_CHANNEL_ID`).
2. Verify the auth flow against a real Google account.
3. Document the dev → preview → prod promotion steps in `frontend/README.md`.

---

## Required new env vars (for `.env.example`)

When Wave 2.0 lands, the bot's `.env.example` (or a sibling `frontend/.env.example`) should grow:

```
# Phase 2 (FM frontend) — required by the Next.js app, NOT by the bot
NEXTAUTH_URL=http://localhost:3001
NEXTAUTH_SECRET=                         # generate via `openssl rand -hex 32`
GOOGLE_CLIENT_ID=                         # Google Cloud Console → OAuth client
GOOGLE_CLIENT_SECRET=
ALLOWED_FM_EMAILS=                        # CSV, e.g. edafe@curacel.ai,patrick@curacel.ai
```

(Reuses the bot's `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `SLACK_BOT_TOKEN`, `EXPENSES_CHANNEL_ID` as already shaped.)

---

## Operational state when paused

- **Bot:** local server is **stopped** (was just shut down via TaskStop). Latest credentials are in `.env`. To bring it back: `npm run dev`. Real tickets in the workbook; latest non-terminal ones at last reconciliation: `EXP-2605-VZKE` (APPROVED step 1) and `EXP-2605-JNW8` (APPROVED step 2). The PAID test ticket today was `EXP-2605-C5ME`.
- **Sheet:** four tabs (`tickets`, `approvals`, `audit_log`, `routes`). Routes has `low-ngn` / `mid-ngn` / `high-ngn`. `mid-ngn` and `high-ngn` were configured for two-approver chains during testing — confirm before resuming.
- **Slack app:** id `A09DBSH1BG9`, name `n8n-2`, bot user `U0B2NA9BZQD`. Socket Mode + scopes including `commands` (slash commands installed: `/expense-resume`, `/expense-cancel`).
- **Memory notes the agent has carried forward:** [user_role.md](/Users/mac/.claude/projects/-Users-mac-curacel-expense-tracker-agent/memory/user_role.md), [feedback_no_hardcoded_ids.md](/Users/mac/.claude/projects/-Users-mac-curacel-expense-tracker-agent/memory/feedback_no_hardcoded_ids.md), [feedback_llm_json_defense.md](/Users/mac/.claude/projects/-Users-mac-curacel-expense-tracker-agent/memory/feedback_llm_json_defense.md), [feedback_currency_default.md](/Users/mac/.claude/projects/-Users-mac-curacel-expense-tracker-agent/memory/feedback_currency_default.md). The currency one is critical: do **not** propose dropping the `currency ?? "NGN"` default in the bot.

---

## Resume protocol after `/compact`

When you come back:

1. `git log --oneline -5` to confirm the most recent commit is `2f56522 fix(events): payment-proof predicate must exclude the expenses channel` (or later — Railway deploy may have landed).
2. Read this file + [PLAN.md §19](./PLAN.md) before suggesting any frontend code.
3. **Wait for the user's sign-off on the Open Decisions table above.** Do not start scaffolding `frontend/` until they've answered #1–#10. Once signed off, proceed in waves; commit per wave.
4. The bot is still in production-shape and unchanged by Phase 2 work. Phase 2 must not modify any file under `src/` of the bot (except possibly to share a type definition; even then, prefer a small `packages/shared/` module over an in-place edit).
