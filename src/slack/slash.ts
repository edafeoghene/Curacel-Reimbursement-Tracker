// Slash commands.
//
// Phase 1.2: `/expense-resume <tracking_id>` — financial-manager-only.
// Phase 1.6: `/expense-cancel <tracking_id>` — requester or FM.

import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { v4 as uuidv4 } from "uuid";

import type { Config } from "../config.js";
import { isValidTrackingId } from "../id.js";
import {
  appendApproval,
  listApprovalsForTicket,
} from "../sheets/approvals.js";
import { getTicketByTrackingId, updateTicket } from "../sheets/tickets.js";
import { transition } from "../state/machine.js";
import { AUDIT_EVENTS, type Approval, type Ticket } from "../types.js";

import { fetchUserName, safeAudit } from "./events.js";
import { postFeedLine } from "./feed.js";
import { dmUser, updateMessage } from "./messaging.js";
import { approverDmBlocks, dmAfterCancel } from "./views.js";

interface Deps {
  config: Config;
}

/**
 * Parse the slash-command text payload — strip whitespace, accept either a
 * bare tracking_id or one prefixed with a backtick (Slack auto-formats
 * `code` blocks pasted into the command box). Returns the validated id, or
 * null if it doesn't match the canonical EXP-YYMM-XXXX shape.
 */
export function parseTrackingIdArg(text: string): string | null {
  if (!text) return null;
  const stripped = text.trim().replace(/^`+|`+$/g, "");
  if (!stripped) return null;
  // `command.text` is the rest after the slash command. Take the first
  // whitespace-delimited token so `/expense-resume EXP-2605-ABCD please`
  // still works.
  const first = stripped.split(/\s+/)[0] ?? "";
  return isValidTrackingId(first) ? first : null;
}

/** @deprecated Phase 1.2 alias — prefer parseTrackingIdArg. */
export const parseResumeArg = parseTrackingIdArg;

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

    const trackingId = parseTrackingIdArg(text);
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

    await postFeedLine(
      client,
      config,
      `:repeat: Resumed: \`${trackingId}\` by <@${userId}> → re-DM'd <@${approverId}> at step ${updatedTicket.current_step}`,
    );

    await respond({
      response_type: "ephemeral",
      text: `Resumed \`${trackingId}\` — DM'd <@${approverId}> at step ${updatedTicket.current_step}.`,
    });
  };
}

// ---------- /expense-cancel (Phase 1.6) ----------

/**
 * Cancel an in-flight ticket. Authorized for the requester (whoever logged
 * the expense) or the financial manager. Runs CANCEL through the state
 * machine, edits any open PENDING approval-row DMs and the FM Mark-as-Paid
 * sentinel DM to "Cancelled", and posts in the source thread.
 *
 * The state machine refuses CANCEL when the ticket is already terminal
 * (PAID/REJECTED/CANCELLED), so a double-click is a no-op for the user.
 */
function makeExpenseCancelHandler({ config }: Deps) {
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

    const trackingId = parseTrackingIdArg(text);
    if (!trackingId) {
      await respond({
        response_type: "ephemeral",
        text: "Usage: `/expense-cancel EXP-YYMM-XXXX`",
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

    const isRequester = userId === ticket.requester_user_id;
    const isFm = userId === config.FINANCIAL_MANAGER_USER_ID;
    if (!isRequester && !isFm) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: userId,
        event_type: AUDIT_EVENTS.AUTHORIZATION_REJECTED,
        details: {
          action: "expense_cancel",
          allowed: ["requester", "financial_manager"],
          got: userId,
        },
      });
      await respond({
        response_type: "ephemeral",
        text: "Only the requester or the financial manager can cancel an expense.",
      });
      return;
    }

    const result = transition(ticket, {
      type: "CANCEL",
      actor_user_id: userId,
    });
    if (!result.ok) {
      await respond({
        response_type: "ephemeral",
        text: `Cannot cancel \`${trackingId}\`: ${result.error}`,
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
      console.error("[slash] updateTicket(CANCELLED) failed:", err);
      await respond({
        response_type: "ephemeral",
        text: `Could not update ticket \`${trackingId}\`. See server logs.`,
      });
      return;
    }

    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: userId,
      event_type: AUDIT_EVENTS.CANCELLED,
      details: {
        cancelled_by_role: isRequester ? "requester" : "financial_manager",
        from_status: ticket.status,
      },
    });
    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: userId,
      event_type: AUDIT_EVENTS.STATE_TRANSITION,
      details: {
        event: "CANCEL",
        from: ticket.status,
        to: result.next,
      },
    });

    // Edit every open PENDING approval-row DM to "Cancelled" — that
    // includes any in-flight approver DM and the FM Mark-as-Paid
    // sentinel row if it exists. Errors are non-fatal.
    const cancelledAt = new Date();
    let approvals: Approval[] = [];
    try {
      approvals = await listApprovalsForTicket(trackingId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[slash] listApprovalsForTicket(cancel) failed:",
        err,
      );
    }
    // Includes the FM Mark-as-Paid sentinel row when it's still PENDING.
    const pending = approvals.filter(
      (a) => a.decision === "PENDING" && a.dm_channel_id && a.message_ts,
    );
    const { blocks, fallbackText } = dmAfterCancel(
      updatedTicket,
      cancelledAt,
      userId,
    );
    for (const a of pending) {
      try {
        await updateMessage(
          client,
          a.dm_channel_id,
          a.message_ts,
          blocks,
          fallbackText,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[slash] cancel DM update failed for approval ${a.approval_id}:`,
          err,
        );
      }
    }

    // POST_CANCELLATION_TO_THREAD side effect — post in the source thread.
    try {
      await client.chat.postMessage({
        channel: updatedTicket.source_channel_id,
        thread_ts: updatedTicket.source_message_ts,
        text: `Expense \`${updatedTicket.tracking_id}\` was cancelled by <@${userId}>.`,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[slash] thread notify (cancel) failed:", err);
    }

    await postFeedLine(
      client,
      config,
      `:no_entry: Cancelled: \`${trackingId}\` by <@${userId}>`,
    );

    await respond({
      response_type: "ephemeral",
      text: `Cancelled \`${trackingId}\`.`,
    });
  };
}

export function registerSlashCommands(app: App, deps: Deps): void {
  const resumeHandler = makeExpenseResumeHandler(deps);
  const cancelHandler = makeExpenseCancelHandler(deps);
  app.command("/expense-resume", resumeHandler);
  app.command("/expense-cancel", cancelHandler);
}
