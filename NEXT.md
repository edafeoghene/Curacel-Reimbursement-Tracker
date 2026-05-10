# NEXT — Phase 2 plan: FM dashboard (read-only Next.js, monorepo, Google-OAuth-gated)

> **Read order:** [PLAN.md](./PLAN.md) is the source of truth. This file is a *resumption brief* — what shipped in Phase 1, what's coming in Phase 2, and the architectural decisions already locked in. Always reconcile against PLAN.md if anything below conflicts.

---

## Snapshot — where we are (2026-05-10)

**Phase 1 of the Slack expense bot is complete and validated end-to-end in the live `Ad Lab` workspace.** Latest validated ticket: `EXP-2605-C5ME` walked through clarify → `/expense-resume` → 2-step approval → Mark as Paid → file proof → **PAID**.

- 221 tests passing across 17 files (`npm test`).
- `npm run typecheck` (now includes `tests/` via `tsconfig.test.json`) clean.
- `npm run build` clean.
- Bot has been run locally via `npm run dev` against the live workspace.
- The only Phase 1 acceptance-box still unchecked is **Railway deploy** — orthogonal to Phase 2; can happen any time.

Audit follow-ups still deferred (none block Phase 2): A) file-share watcher full-table scans, B) `PAYMENT_STEP_SENTINEL=99` magic value → real Ticket fields, C) test gap on the bigger handler files, D) `args: any` on Bolt registrations, E) splitting events.ts / interactivity.ts, F) O(n) full-table sheet reads.

---

## Phase 2 scope (per [PLAN.md §19](./PLAN.md), refined with user)

> "A read-only Next.js frontend that visualizes the bot's work and the Sheet's data — ticket queue, status filters, audit timelines, per-approver workload."

### Architecture — locked in

- **Monorepo, npm workspaces.** Root stays the bot (no relocation of the bot tree). Two new workspace members: `packages/shared/` and `frontend/`.
- **Bot:** unchanged at root, deploys to Railway as today.
- **Frontend:** Next.js 15 (App Router) in `frontend/`, deploys to Vercel.
- **Shared types:** extracted from [src/types.ts](src/types.ts) into `packages/shared/src/index.ts`. Bot and frontend both `import { Ticket } from "@curacel/shared"`. One source of truth.
- **Separate processes.** A frontend crash cannot take the bot down. Independent dev loops, independent deploy lifecycles.
- **Read-only.** No writes to the Sheet from the dashboard. PLAN.md §11's single-writer rule remains intact.
- **FM-only audience.** Only emails on `ALLOWED_FM_EMAILS` may sign in. Employees still track their tickets via Slack DMs.
- **Auth:** NextAuth.js / Auth.js v5 with Google provider + `hd=curacel.ai` hint + server-side claim assertion + per-email allowlist gate. JWT cookies (no DB).
- **UI:** shadcn/ui + Tailwind.

### Hard constraints carried forward from Phase 1

1. **No new database.** Google Sheets remains the only persistent store. Frontend reads via the same `googleapis` client shape used by the bot.
2. **No writes to the Sheet from the frontend.** Every state mutation must go through `transition()` in the bot.
3. **No exposing service-account JSON or `SLACK_BOT_TOKEN` to the browser.** Sheets reads and Slack file fetches happen in Server Components / Route Handlers.
4. **TypeScript strict mode** consistent with the bot's tsconfig.
5. **Same identity sources** — `EXPENSES_CHANNEL_ID`, `FINANCIAL_MANAGER_USER_ID` env vars unchanged.

### Out of scope (Phase 2)

- Approving/rejecting/clarifying/delegating/marking-paid from the dashboard (PLAN.md §4 #5: DMs are the approval surface).
- Editing tickets directly.
- Multi-tenant / multi-workspace UI.
- Public-facing pages — entire app behind auth.

---

## Wave plan

Each wave is its own commit (or small commit chain). Bot's `src/` is touched only for the type-extraction in Wave 2.0 — no behavior changes.

### Wave 2.0 — Workspaces + types extraction

1. Convert root `package.json` to npm workspaces (`packages/*`, `frontend`).
2. Create `packages/shared/` with its own `package.json` + `tsconfig.json` + `src/index.ts`.
3. Move type definitions out of [src/types.ts](src/types.ts) into `packages/shared/src/index.ts`.
4. Update all 27 bot imports (`from "../types.js"` and similar) → `from "@curacel/shared"`.
5. Add tsconfig path so tsx-watch resolves `@curacel/shared` to TS source in dev (no shared rebuild loop).
6. Add `prebuild` script that builds `@curacel/shared` first.
7. Verify `npm run build` + `npm run typecheck` + `npm test` still green.

### Wave 2.1 — Frontend scaffold

1. `frontend/` via `create-next-app` (Next.js 15, App Router, TypeScript strict, Tailwind).
2. shadcn/ui init.
3. Basic layout shell + placeholder home page.
4. `frontend/.env.example`.
5. Verify `npm run build -w frontend`.

### Wave 2.2 — Auth spine

1. NextAuth.js v5 with Google provider. `hd=curacel.ai` hint.
2. `signIn` callback enforces `email.endsWith("@curacel.ai")` AND `email ∈ ALLOWED_FM_EMAILS` (lowercased + trimmed).
3. Protected layout (everything except `/api/auth/*` and `/login` requires a session).
4. Sign-out button + "not allowed here" rejection page.
5. Tests: signIn callback unit-test against fixtures (allowed, wrong-domain, right-domain-not-on-list, edge cases).

### Wave 2.3 — Server-side Sheets reader

1. `frontend/lib/sheets/{tickets,approvals,audit}.ts` mirroring read patterns from the bot.
2. Reuses `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` + `GOOGLE_SHEETS_SPREADSHEET_ID` env vars.
3. Server-only — never imported into client components.
4. Tests against fixture rows.

### Wave 2.4 — Ticket queue page

1. `app/(dashboard)/tickets/page.tsx` Server Component.
2. Status / requester / route / currency / date filters via URL params.
3. Sort `created_at` desc, paginated via URL params.
4. SSR with `revalidate ~30s` + manual refresh button (`router.refresh()`).

### Wave 2.5 — Per-ticket detail page + Slack file proxy

1. `app/(dashboard)/tickets/[trackingId]/page.tsx`.
2. Header card, approval timeline, audit log, receipt + payment-proof previews.
3. `app/api/files/[id]/route.ts` — Slack file proxy. Bot token stays server-side. Stream every request (no caching layer in 2.x).

### Wave 2.6 — Per-approver workload + polish

1. `app/(dashboard)/workload/page.tsx`. Counts of `PENDING` approvals per `approver_user_id`.
2. Resolve display names via `users.info`, in-memory cache.
3. Empty/error states, mobile-responsive.

### Wave 2.7 — Vercel deploy

1. Vercel project linked, `Root Directory = frontend`.
2. Env vars provisioned (Google OAuth client ID/secret, NEXTAUTH_SECRET, NEXTAUTH_URL, `ALLOWED_FM_EMAILS`, `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `SLACK_BOT_TOKEN`, `EXPENSES_CHANNEL_ID`).
3. End-to-end auth flow verified against a real Google account.
4. `frontend/README.md` documents dev → preview → prod promotion.

---

## Required new env vars (in `frontend/.env.example`)

```
NEXTAUTH_URL=http://localhost:3001
NEXTAUTH_SECRET=                          # openssl rand -hex 32
GOOGLE_CLIENT_ID=                          # Google Cloud Console → OAuth client
GOOGLE_CLIENT_SECRET=
ALLOWED_FM_EMAILS=                         # CSV, lowercased+trimmed at runtime

# Reused from the bot (frontend reads, never writes)
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=
GOOGLE_SHEETS_SPREADSHEET_ID=
SLACK_BOT_TOKEN=                           # for the file proxy only
EXPENSES_CHANNEL_ID=
```

---

## Operational state when paused

- **Bot:** local server stopped. To bring it back: `npm run dev`. Latest non-terminal tickets at last reconciliation: `EXP-2605-VZKE` (APPROVED step 1), `EXP-2605-JNW8` (APPROVED step 2). PAID test today: `EXP-2605-C5ME`.
- **Sheet:** four tabs (`tickets`, `approvals`, `audit_log`, `routes`). `mid-ngn` and `high-ngn` configured for two-approver chains during testing — confirm before resuming bot work.
- **Slack app:** id `A09DBSH1BG9`, bot user `U0B2NA9BZQD`. Socket Mode + `commands` scope.
- **Memory notes still load-bearing:** `feedback_currency_default.md` (do **not** propose dropping the `currency ?? "NGN"` default in the bot), `feedback_no_hardcoded_ids.md`, `feedback_llm_json_defense.md`, `user_role.md`.

---

## Resume protocol after `/compact`

1. `git log --oneline -5` to confirm the most recent Phase 2 commit.
2. Read this file + [PLAN.md §19](./PLAN.md).
3. Architectural decisions are locked. Do not re-litigate. Continue at the next pending wave in the [todo list](./).
4. Phase 2 must not modify any file under `src/` of the bot, except for the type-extraction in Wave 2.0. Bot behavior must not change in Phase 2.
