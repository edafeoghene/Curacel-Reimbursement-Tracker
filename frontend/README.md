# Curacel Expense Dashboard (frontend)

Read-only Next.js dashboard for the [Curacel expense bot](../). FM-only,
Google-OAuth-gated, allow-list-restricted. The bot stays the only writer
to the Google Sheet; this app just visualizes its work.

See [PLAN.md §19](../PLAN.md) for the design contract and
[NEXT.md](../NEXT.md) for the roadmap.

---

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript strict
- Tailwind 4 (CSS-first config in `app/globals.css`)
- NextAuth v5 with the Google provider (`hd=curacel.ai` hint +
  server-side allow-list)
- `googleapis` Sheets v4 client (read-only scope)
- Recharts for the homepage charts, `react-day-picker` + Radix Popover
  for the calendar filter, `cmdk` for the requester combobox

## Setup

Frontend is a workspace inside the bot's monorepo, so dependencies are
managed from the repo root.

```bash
# from repo root
npm install
```

### Env vars

The frontend reads the **repo-root `.env`** (not `frontend/.env`) — same
file the bot uses. `next.config.ts` calls
`loadEnvConfig(repoRoot, isDev, undefined, /* forceReload */ true)` to
make sure `@next/env` re-reads from the parent directory after its
internal cwd-based pass.

Required keys (in repo-root `.env`):

| Var | Purpose | Reused by bot? |
|---|---|---|
| `NEXTAUTH_URL` | Auth.js base URL. `http://localhost:3001` for local. | no |
| `NEXTAUTH_SECRET` | Cookie/JWT secret. `openssl rand -hex 32`. | no |
| `GOOGLE_CLIENT_ID` | Google OAuth client. | no |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client. | no |
| `ALLOWED_FM_EMAILS` | CSV of allow-listed FM emails. Empty = nobody allowed. | no |
| `GOOGLE_SHEETS_ID` | Workbook id. | yes |
| `GOOGLE_SERVICE_ACCOUNT_B64` | Base64 service-account JSON, read-only scope is enough for the frontend. | yes |
| `SLACK_BOT_TOKEN` | For the `/api/files/:fileId` proxy. | yes |
| `EXPENSES_CHANNEL_ID` | Used by the bot; available to the frontend if needed. | yes |

### Google OAuth setup

Cloud Console → OAuth 2.0 Client (type: Web application). Authorized
redirect URIs:

- Local: `http://localhost:3001/api/auth/callback/google`
- Vercel preview / prod: `https://<preview-or-prod-domain>/api/auth/callback/google`

The `hd=curacel.ai` hint nudges Google's account chooser; the
`signIn` callback in [auth.ts](./auth.ts) re-checks the `hd` claim
server-side AND the allow-list. Domain + claim are defense-in-depth;
the allow-list is the actual gate.

## Run

```bash
# from repo root — workspace-aware npm scripts
npm run dev   -w @curacel/frontend     # http://localhost:3001
npm run build -w @curacel/frontend
npm start     -w @curacel/frontend     # production build
npm test                               # vitest, picks up frontend/lib/**/*.test.ts too
```

## Layout

- `app/(dashboard)/` — every signed-in page. Group layout owns sidebar
  + mobile top bar + sign-out.
  - `page.tsx` — Overview with KPI cards, paid-per-week chart, status
    donut, top categories / requesters, recent tickets.
  - `tickets/` — queue table (URL-paramed filters + pagination).
  - `tickets/[trackingId]/` — detail page with approval timeline and
    receipt / payment-proof previews via the file proxy.
  - `workload/` — per-approver pending counts.
- `app/login/`, `app/not-allowed/` — public, no dashboard chrome.
- `app/api/auth/[...nextauth]/route.ts` — NextAuth handlers.
- `app/api/files/[fileId]/route.ts` — Slack file proxy. Requires session,
  validates the requested file_id is referenced by a ticket in the
  sheet, then streams `url_private` server-side using `SLACK_BOT_TOKEN`.
- `auth.ts` — NextAuth config (Google provider + signIn allowlist gate).
- `proxy.ts` — Next 16 renamed middleware → proxy. Matcher excludes
  static assets and `/api/auth/*`; everything else requires a session.
- `lib/` — server-only Sheets reader (`sheets/`), dashboard
  aggregations (`dashboard/`), status palette, the auth allowlist.
- `components/` — Client Components: charts, file preview, date picker,
  requester combobox, refresh button, nav links, sidebar shell.

## Deploy (Vercel)

1. Link the repo in Vercel. **Root Directory = `frontend`** (otherwise
   Vercel builds the bot too).
2. Project Settings → Environment Variables: paste in everything above
   for Production. For Preview, set `NEXTAUTH_URL` to the auto-assigned
   preview domain pattern if you want the OAuth flow to work in PR
   previews — otherwise restrict OAuth to prod-only.
3. Add the Vercel domain(s) to the Google OAuth client's authorized
   redirect URIs.
4. `vercel deploy --prod` (or push to the main branch if you've wired
   Git auto-deploy).

Vercel auto-adds Strict-Transport-Security on production deploys; the
app's own `next.config.ts` sets the other baseline security headers
(X-Content-Type-Options, X-Frame-Options, frame-ancestors via CSP,
Referrer-Policy, Permissions-Policy).

## Hard constraints

These come from the project's design contract — see PLAN.md.

- **No writes to the Sheet from this frontend.** Every mutation goes
  through the bot's `transition()` function. This dashboard is purely
  presentational.
- **No `SLACK_BOT_TOKEN` / service-account JSON in the client bundle.**
  Sheets reads and Slack file fetches all happen in Server Components
  / Route Handlers. The browser only ever sees same-origin
  `/api/files/:fileId` URLs.
- **No new database.** Google Sheets is the single source of truth.
