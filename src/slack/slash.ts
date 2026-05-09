// Slash commands.
//
// Phase 1.2: `/expense-resume <tracking_id>` — financial-manager-only
// command that resumes an approval after clarification. Re-DMs the same
// approver at the same step (fresh DM + fresh PENDING approval row;
// the original CLARIFICATION_REQUESTED row stays in place as the audit
// trail).
//
// TODO Phase 1.6: register `/expense-cancel` (cancellation by requester
// or financial manager).

import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { v4 as uuidv4 } from "uuid";

import type { Config } from "../config.js";
import { isValidTrackingId } from "../id.js";
import { appendApproval } from "../sheets/approvals.js";
import { getTicketByTrackingId, updateTicket } from "../sheets/tickets.js";
import { transition } from "../state/machine.js";
import { AUDIT_EVENTS, type Ticket } from "../types.js";

import { fetchUserName, safeAudit } from "./events.js";
import { dmUser } from "./messaging.js";
import { approverDmBlocks } from "./views.js";

interface Deps {
  config: Config;
}

/**
 * Parse the slash-command text payload — strip whitespace, accept either a
 * bare tracking_id or one prefixed with a backtick (Slack auto-formats
 * `code` blocks pasted into the command box). Returns the validated id, or
 * null if it doesn't match the canonical EXP-YYMM-XXXX shape.
 */
export function parseResumeArg(text: string): string | null {
  if (!text) return null;
  const stripped = text.trim().replace(/^`+|`+$/g, "");
  if (!stripped) return null;
  // `command.text` is the rest after the slash command. Take the first
  // whitespace-delimited token so `/expense-resume EXP-2605-ABCD please`
  // still works.
  const first = stripped.split(/\s+/)[0] ?? "";
  return isValidTrackingId(first) ? first : null;
}

function makeExpenseResumeHandler({ config }: Deps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any): Promise<void> => {
    await args.ack();

    const command = args.command as { text?: string; user_id?: string };
    const client: WebClient = args.client;
    const respond = args.respond as (msg: {
      response_type?: "ephemeral" | "in_channel";
      text: string;
    }) => Promise<unknown>;
    const userId = command.user_id ?? "";
    const text = command.text ?? "";

    const trackingId = parseResumeArg(text);
    if (!trackingId) {
      await respond({
        response_type: "ephemeral",
        text: "Usage: `/expense-resume EXP-YYMM-XXXX`",
      });
      return;
    }

    if (userId !== config.FINANCIAL_MANAGER_USER_ID) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: userId,
        event_type: AUDIT_EVENTS.AUTHORIZATION_REJECTED,
        details: {
          action: "expense_resume",
          expected: config.FINANCIAL_MANAGER_USER_ID,
          got: userId,
        },
      });
      await respond({
        response_type: "ephemeral",
        text: "Only the financial manager can resume an expense.",
      });
      return;
    }

    const ticket = await getTicketByTrackingId(trackingId);
    if (!ticket) {
      await respond({
        response_type: "ephemeral",
        text: `Ticket \`${trackingId}\` not found.`,
      });
      return;
    }

    const result = transition(ticket, { type: "RESUME_AFTER_CLARIFY" });
    if (!result.ok) {
      await respond({
        response_type: "ephemeral",
        text: `Cannot resume \`${trackingId}\`: ${result.error}`,
      });
      return;
    }

    let updatedTicket: Ticket;
    try {
      updatedTicket = await updateTicket(trackingId, ticket.row_version, {
        status: result.next,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[slash] updateTicket(AWAITING_APPROVAL) failed:", err);
      await respond({
        response_type: "ephemeral",
        text: `Could not update ticket \`${trackingId}\`. See server logs.`,
      });
      return;
    }

    // Always re-DM via a fresh conversations.open (handled by dmUser). The
    // original approval row's coords belong to the CLARIFICATION_REQUESTED
    // record and stay there as audit; the fresh DM gets its own PENDING row.
    const approverId = updatedTicket.current_approver_user_id;
    if (!approverId) {
      // eslint-disable-next-line no-console
      console.error(
        `[slash] /expense-resume: ticket ${trackingId} has no current_approver_user_id`,
      );
      await respond({
        response_type: "ephemeral",
        text: `Ticket \`${trackingId}\` has no current approver — manual intervention needed.`,
      });
      return;
    }

    let dm: { channel: string; ts: string };
    try {
      const { blocks, fallbackText } = approverDmBlocks(updatedTicket);
      dm = await dmUser(client, approverId, blocks, fallbackText);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[slash] re-DM after resume failed:", err);
      await respond({
        response_type: "ephemeral",
        text: `Could not DM <@${approverId}> for \`${trackingId}\`. See server logs.`,
      });
      return;
    }

    try {
      const approverName = await fetchUserName(client, approverId);
      await appendApproval({
        approval_id: uuidv4(),
        tracking_id: trackingId,
        step_number: updatedTicket.current_step,
        approver_user_id: approverId,
        approver_name: approverName,
        decision: "PENDING",
        decided_at: null,
        comment: "resumed after clarification",
        delegated_to_user_id: null,
        dm_channel_id: dm.channel,
        message_ts: dm.ts,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[slash] appendApproval (resume) failed:", err);
      // The DM was sent — without a row we can't easily track it, but the
      // ticket is in a sane state. Surface to FM.
      await respond({
        response_type: "ephemeral",
        text: `DM sent but the approval row could not be appended for \`${trackingId}\`. See server logs.`,
      });
      return;
    }

    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: userId,
      event_type: AUDIT_EVENTS.CLARIFICATION_RESUMED,
      details: { step: updatedTicket.current_step, approver: approverId },
    });
    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: userId,
      event_type: AUDIT_EVENTS.STATE_TRANSITION,
      details: {
        event: "RESUME_AFTER_CLARIFY",
        from: ticket.status,
        to: result.next,
        approver: approverId,
      },
    });

    await respond({
      response_type: "ephemeral",
      text: `Resumed \`${trackingId}\` — DM'd <@${approverId}> at step ${updatedTicket.current_step}.`,
    });
  };
}

export function registerSlashCommands(app: App, deps: Deps): void {
  const resumeHandler = makeExpenseResumeHandler(deps);
  app.command("/expense-resume", resumeHandler);
}
