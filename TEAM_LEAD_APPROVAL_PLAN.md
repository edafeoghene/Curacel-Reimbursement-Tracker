# Team-lead approval flow — implementation plan

Replace the amount-band routing (`routes` tab + `resolveRoute`) with a per-employee team-lead approval flow driven by the **Employee data** sheet tab.

## Decisions locked in

- **FM role:** informational DM only on submission (no buttons). Team lead is the sole approver. Post-approval "Mark as Paid" DM to FM stays exactly as today.
- **Team lead lookup:** read the `Team Lead Slack ID` column directly. (Data is being cleaned manually.)
- **Team channel sourcing:** read the `Team Slack Channel` column off the requester's row.
- **Visibility:** persistent channel post with the team lead `@`-tagged. Server-side authz — non-lead button clicks get an ephemeral "not authorized" reply.

## New flow per submission

1. Classifier runs as today.
2. Look up requester in **Employee data** by Slack user ID.
3. Post a buttoned message in the requester's `Team Slack Channel`, tagging the team lead.
4. DM the FM a no-buttons informational summary with a Slack permalink to the channel post.
5. Approve → edit channel message (remove buttons, "Approved by @lead"), DM FM the existing **Mark as Paid** prompt. Payment proof flow unchanged.
6. Reject / Clarify / Delegate work as today but operate on the channel post instead of a DM.

## Edge cases → MANUAL_REVIEW (FM gets buttoned DM, as today)

- Requester not found in Employee data.
- `Team Lead Slack ID` missing, equal to requester's own ID, or not `U`-prefixed.
- `Team Slack Channel` missing or not `C`/`G`-prefixed.
- Team lead is the requester (no self-approval).
- Channel post or FM info-DM fails to send.
- Bot is not a member of the team channel (`not_in_channel` from Slack) — one-time onboarding: invite the bot to each team channel.

## Waves

### Wave A — shared schema + employees loader

- `packages/shared/src/index.ts`
  - Add `Employee` type: `{ employee_name, team_lead_name, team, employee_slack_id, team_lead_slack_id, team_channel_id }`.
  - Add `EMPLOYEES_HEADERS` (mirror of the tab's headers — note the existing trailing whitespace; loader trims).
  - Add `TAB_EMPLOYEES = "Employee data"` (quoted via existing `quoteTab` helper because it has a space).
  - Append to `ALL_TABS`.
- `src/sheets/employees.ts` — mirror of `routes.ts`:
  - `parseEmployeeRow(raw)` — trims, validates `U`-prefix on user IDs, `C`/`G`-prefix on channel ID. Throws `MalformedEmployeeError` so the loader can skip the row with a logged warning rather than crashing the whole load.
  - `loadEmployees()` — replace in-memory cache.
  - `getCachedEmployees()` — sync accessor.
  - `lookupEmployeeBySlackId(id)` — `O(n)` scan; if duplicates exist for the same ID, return the **last** one (matches sheet edit-history intent).
  - `startEmployeesRefresh(intervalMs = 5min)` / `stopEmployeesRefresh()`.
- Tests: `parseEmployeeRow` happy + each malformed variant; `lookupEmployeeBySlackId` not-found + duplicate.

### Wave B — view helpers

In `src/slack/views.ts`:
- `teamChannelApprovalBlocks(ticket, leadSlackId)` — header `<@LEAD> please approve`, summary fields, description, receipt context, Approve / Clarify / Delegate / Reject buttons. **Reuse the existing `action_id` constants** so handlers fire without changes.
- `teamChannelAfterApprove / AfterReject / AfterClarify / AfterDelegate` — variants matching the existing approver-DM-after-* helpers (header replaced with decision summary, buttons stripped).
- `fmInfoDmBlocks(ticket, lead, channelId, messageTs)` — no buttons. Includes a `slack.com/archives/{channelId}/p{ts-no-dot}` permalink so FM can jump straight to the channel post.

### Wave C — submission path in `events.ts`

Replace the `getCachedRoutes` + `resolveRoute` block (~lines 713–770):

```text
employee = lookupEmployeeBySlackId(userId)
if !employee || !lead_id || !team_channel || lead_id == userId → routeToManualReview
ticket = { ..., route_id: "", current_step: 1, current_approver_user_id: leadSlackId }
appendTicket
chat.postMessage in employee.team_channel_id with teamChannelApprovalBlocks
on post failure → escalateToManualReview
appendApproval(step_number: 1, dm_channel_id: <team channel>, message_ts: <post ts>)
  → reuses approval-row slots; `dm_channel_id` now means "channel where the buttoned message lives" (DM or channel)
fmInfoDm = build via fmInfoDmBlocks
dmUser(FM, fmInfoDm)  → best-effort, not blocking
FIRST_DM_SENT transition + audit (rename in audit details: { event: "FIRST_DM_SENT" → "FIRST_POST_SENT" } — keep "FIRST_DM_SENT" if you want zero migration churn)
```

### Wave D — interactivity (`interactivity.ts`)

For each of the 4 button handlers (Approve / Reject / Clarify / Delegate):
- After re-fetching the ticket, look up the requester's team lead.
- If `clicker_user_id !== team_lead_slack_id` → `postEphemeral` "Only <@LEAD> can act on this expense" and return. (Today the DM context implicitly enforced this; the channel context needs an explicit gate.)

In `expense_approve`:
- Single-step flow: `is_final_step` is always `true`. Drop the `ADVANCE_TO_STEP` branch in this handler (state machine itself stays untouched — non-final APPROVE just becomes unreachable for new tickets; old in-flight multi-step tickets, if any, still resolve via the existing branch).
- `updateMessage` uses the stored `dm_channel_id` / `message_ts` from the step-1 approval row → edits the channel post in place. No change to the helper, just to which message it edits.
- FM "Mark as Paid" DM (final-approve path, ~lines 367–418) is untouched.

### Wave E — cleanup

- Delete `src/state/routing.ts`, `src/sheets/routes.ts`, and the `loadRoutes` / `startRoutesRefresh` boot calls in `src/index.ts`.
- Remove `Route`, `RouteRow`, `ROUTES_HEADERS`, `TAB_ROUTES` from `packages/shared`. Drop `TAB_ROUTES` entry from `ALL_TABS`. (The physical `routes` tab in the sheet can stay; nothing reads it.)
- Frontend has no routes reader — no change required. The ticket detail page already renders `route_id || "—"`, so new tickets will show "—".
- **Optional follow-up:** swap that field's label from "Route" → "Team" by reading Employee data on the detail page. Out of scope for this plan unless you want it in the same PR.

### Wave F — tests + smoke

Unit:
- `parseEmployeeRow` — happy, missing TL ID, ID `D`-prefix, channel missing, channel `D`-prefix.
- `lookupEmployeeBySlackId` — not-found, duplicate (returns last).
- `events.ts` integration-style — each of the 5 MANUAL_REVIEW fallbacks.
- `interactivity.ts` — authz rejection for each button handler.

Manual smoke:
- Submit a real expense as yourself (your row is the only fully-populated one — your team lead is yourself, so it'll route to MANUAL_REVIEW under the "lead == requester" rule). To smoke the happy path, temporarily fix another row to use you as the lead, or have a teammate submit.
- Verify: channel post appears, FM DM appears, Approve edits the channel post, FM gets Mark-as-Paid DM, full payment-proof loop still closes.

## Schema notes — no Sheet migration needed

- `Ticket.route_id` becomes empty string for new tickets. Existing rows keep their values.
- `Ticket.current_step` is always `1`. Old multi-step in-flight tickets still resolve via the existing `ADVANCE_TO_STEP` branch.
- The step-1 `Approval` row now stores the team-channel `{channel, ts}` in `dm_channel_id` / `message_ts`. Field is misnamed under the new flow; renaming is a follow-up (would require sheet header change).

## Estimate

~2–3 hours: A=30min, B=20min, C=30min, D=30min, E=15min, F=30min + manual smoke.
