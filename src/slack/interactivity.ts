// Button + payment-proof handlers.
//
// Phase 1.0 surfaces:
//   - expense_approve   (approver DM)
//   - expense_mark_paid (financial-manager DM)
//   - file_share watcher → moves AWAITING_PAYMENT → PAID
//
// All button handlers ack() immediately, then re-read the ticket, verify
// authorization, run transition(), apply side effects (sheet write, edit DM,
// next-step DM), and append audit entries. Reject / clarify / delegate are
// out of scope per Phase 1.0 brief.

import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { v4 as uuidv4 } from "uuid";

import type { Config } from "../config.js";
import { appendApproval, listApprovalsForTicket, updateApprovalDecision } from "../sheets/approvals.js";
import { getTicketByTrackingId, listNonTerminalTickets, updateTicket } from "../sheets/tickets.js";
import { transition } from "../state/machine.js";
import { AUDIT_EVENTS, type Approval, type Ticket } from "../types.js";

import { dmUser, postEphemeral, updateMessage } from "./messaging.js";
import { PAYMENT_STEP_SENTINEL, safeAudit } from "./events.js";
import {
  approverDmAfterApprove,
  approverDmAfterReject,
  financialManagerDmAfterMarkPaid,
  financialManagerDmBlocks,
  MODAL_REJECT_CALLBACK_ID,
  REJECT_REASON_ACTION_ID,
  REJECT_REASON_BLOCK_ID,
  rejectionReasonModal,
} from "./views.js";

interface Deps {
  config: Config;
}

// ---------- approve ----------

function makeApproveHandler({ config }: Deps) {
  return async ({
    ack,
    body,
    client,
    action,
  }: {
    ack: () => Promise<void>;
    body: BlockAction;
    client: WebClient;
    action: ButtonAction;
  }): Promise<void> => {
    await ack();

    const trackingId = action.value;
    if (!trackingId) {
      // eslint-disable-next-line no-console
      console.warn("[interactivity] expense_approve: missing tracking_id value");
      return;
    }

    const clickerId = body.user.id;
    const channelId = body.channel?.id ?? "";
    const messageTs = body.message?.ts ?? "";

    const ticket = await getTicketByTrackingId(trackingId);
    if (!ticket) {
      try {
        if (channelId) {
          await postEphemeral(
            client,
            channelId,
            clickerId,
            `Ticket \`${trackingId}\` could not be found.`,
          );
        }
      } catch {
        // ignore
      }
      return;
    }

    // Authorization
    if (clickerId !== ticket.current_approver_user_id) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: clickerId,
        event_type: AUDIT_EVENTS.AUTHORIZATION_REJECTED,
        details: {
          action: "expense_approve",
          expected: ticket.current_approver_user_id,
          got: clickerId,
        },
      });
      try {
        if (channelId) {
          await postEphemeral(
            client,
            channelId,
            clickerId,
            "You are not the assigned approver for this ticket.",
          );
        }
      } catch {
        // ignore
      }
      return;
    }

    // Phase 1.0 single-step: this approval IS the final step.
    const isFinal = true;

    const result = transition(ticket, {
      type: "APPROVE",
      step: ticket.current_step,
      approver_user_id: clickerId,
      is_final_step: isFinal,
    });
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[interactivity] expense_approve: illegal transition: ${result.error}`,
      );
      try {
        if (channelId) {
          await postEphemeral(
            client,
            channelId,
            clickerId,
            `This ticket is no longer in a state that can be approved (status: ${ticket.status}).`,
          );
        }
      } catch {
        // ignore
      }
      return;
    }

    // Find the matching approval row for this step.
    const approvals = await listApprovalsForTicket(trackingId);
    const pending = approvals.find(
      (a) =>
        a.step_number === ticket.current_step && a.decision === "PENDING",
    );

    const approverName = ticket.requester_name; // fallback only — not used as approver display
    void approverName;

    const decidedAt = new Date();
    const decidedAtIso = decidedAt.toISOString();

    if (pending) {
      try {
        await updateApprovalDecision(pending.approval_id, {
          decision: "APPROVED",
          decided_at: decidedAtIso,
          comment: "",
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[interactivity] updateApprovalDecision failed:", err);
      }
    }

    // Update ticket status (single source of truth = state machine).
    let updatedTicket: Ticket;
    try {
      updatedTicket = await updateTicket(trackingId, ticket.row_version, {
        status: result.next,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[interactivity] updateTicket(APPROVED) failed:", err);
      return;
    }

    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: clickerId,
      event_type: AUDIT_EVENTS.APPROVAL_GRANTED,
      details: { step: ticket.current_step, decided_at: decidedAtIso },
    });
    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: clickerId,
      event_type: AUDIT_EVENTS.STATE_TRANSITION,
      details: {
        event: "APPROVE",
        from: ticket.status,
        to: result.next,
        is_final_step: isFinal,
      },
    });

    // Edit the approver DM to remove the button.
    if (channelId && messageTs) {
      try {
        // Best-effort approver display name pulled from the approval row
        // (already snapshotted at DM time).
        const name = pending?.approver_name ?? `<@${clickerId}>`;
        const { blocks, fallbackText } = approverDmAfterApprove(
          updatedTicket,
          decidedAt,
          name,
        );
        await updateMessage(client, channelId, messageTs, blocks, fallbackText);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[interactivity] approver DM update failed:", err);
      }
    }

    // Side effect: DM the financial manager with "Mark as Paid".
    try {
      const { blocks, fallbackText } = financialManagerDmBlocks(updatedTicket);
      const { channel: fmChannel, ts: fmTs } = await dmUser(
        client,
        config.FINANCIAL_MANAGER_USER_ID,
        blocks,
        fallbackText,
      );

      // Sentinel approval row holding the FM DM coords. step_number = 99.
      // See final report for why this pattern was chosen over adding fields
      // to the Ticket type.
      await appendApproval({
        approval_id: uuidv4(),
        tracking_id: trackingId,
        step_number: PAYMENT_STEP_SENTINEL,
        approver_user_id: config.FINANCIAL_MANAGER_USER_ID,
        approver_name: "financial_manager",
        decision: "PENDING",
        decided_at: null,
        comment: "payment-step (sentinel)",
        delegated_to_user_id: null,
        dm_channel_id: fmChannel,
        message_ts: fmTs,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[interactivity] DM to financial manager failed:", err);
    }
  };
}

// ---------- reject (Phase 1.1) ----------

/**
 * Reject button handler. Authorization is checked here AND again at modal
 * submission time, because the modal can stay open for minutes — by the
 * time the user submits, state may have shifted (e.g. delegation, terminal
 * status). Re-checking is cheap and structurally important.
 */
function makeRejectButtonHandler() {
  return async ({
    ack,
    body,
    client,
    action,
  }: {
    ack: () => Promise<void>;
    body: BlockAction;
    client: WebClient;
    action: ButtonAction;
  }): Promise<void> => {
    await ack();

    const trackingId = action.value;
    if (!trackingId) {
      // eslint-disable-next-line no-console
      console.warn("[interactivity] expense_reject: missing tracking_id value");
      return;
    }

    const clickerId = body.user.id;
    const channelId = body.channel?.id ?? "";

    const ticket = await getTicketByTrackingId(trackingId);
    if (!ticket) {
      try {
        if (channelId) {
          await postEphemeral(
            client,
            channelId,
            clickerId,
            `Ticket \`${trackingId}\` could not be found.`,
          );
        }
      } catch {
        // ignore
      }
      return;
    }

    if (clickerId !== ticket.current_approver_user_id) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: clickerId,
        event_type: AUDIT_EVENTS.AUTHORIZATION_REJECTED,
        details: {
          action: "expense_reject",
          expected: ticket.current_approver_user_id,
          got: clickerId,
        },
      });
      try {
        if (channelId) {
          await postEphemeral(
            client,
            channelId,
            clickerId,
            "You are not the assigned approver for this ticket.",
          );
        }
      } catch {
        // ignore
      }
      return;
    }

    // Open the reason modal. trigger_id is short-lived (~3s) — opening
    // immediately after ack is essential.
    if (!body.trigger_id) {
      // eslint-disable-next-line no-console
      console.warn("[interactivity] expense_reject: missing trigger_id");
      return;
    }
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        view: rejectionReasonModal(trackingId) as any,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[interactivity] views.open(reject modal) failed:", err);
    }
  };
}

/**
 * Reject modal submission handler. Re-fetches the ticket, re-authorizes,
 * runs the state machine, updates the approval row + ticket, edits the
 * approver DM to remove buttons + show the rejection, and posts the
 * rejection notice in the requester's source thread.
 */
function makeRejectModalSubmitHandler() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any): Promise<void> => {
    await args.ack();

    const view = args.body.view;
    const clickerId = args.body.user.id;
    const trackingId: string = view.private_metadata ?? "";
    const reasonRaw: string =
      view.state?.values?.[REJECT_REASON_BLOCK_ID]?.[REJECT_REASON_ACTION_ID]
        ?.value ?? "";
    const reason = reasonRaw.trim();

    if (!trackingId || !reason) {
      // eslint-disable-next-line no-console
      console.warn(
        "[interactivity] reject modal submit: missing tracking_id or reason",
      );
      return;
    }

    const client: WebClient = args.client;

    const ticket = await getTicketByTrackingId(trackingId);
    if (!ticket) {
      // eslint-disable-next-line no-console
      console.warn(
        `[interactivity] reject modal submit: ticket ${trackingId} not found`,
      );
      return;
    }

    if (clickerId !== ticket.current_approver_user_id) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: clickerId,
        event_type: AUDIT_EVENTS.AUTHORIZATION_REJECTED,
        details: {
          action: "expense_reject_submit",
          expected: ticket.current_approver_user_id,
          got: clickerId,
        },
      });
      return;
    }

    const result = transition(ticket, {
      type: "REJECT",
      step: ticket.current_step,
      approver_user_id: clickerId,
      reason,
    });
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[interactivity] expense_reject illegal: ${result.error}`,
      );
      return;
    }

    // Find the pending approval row for the current step.
    const approvals = await listApprovalsForTicket(trackingId);
    const pending = approvals.find(
      (a) =>
        a.step_number === ticket.current_step && a.decision === "PENDING",
    );

    const decidedAt = new Date();
    const decidedAtIso = decidedAt.toISOString();

    if (pending) {
      try {
        await updateApprovalDecision(pending.approval_id, {
          decision: "REJECTED",
          decided_at: decidedAtIso,
          comment: reason,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          "[interactivity] updateApprovalDecision(REJECT) failed:",
          err,
        );
      }
    }

    let updatedTicket: Ticket;
    try {
      updatedTicket = await updateTicket(trackingId, ticket.row_version, {
        status: result.next,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[interactivity] updateTicket(REJECTED) failed:", err);
      return;
    }

    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: clickerId,
      event_type: AUDIT_EVENTS.APPROVAL_REJECTED,
      details: { step: ticket.current_step, reason, decided_at: decidedAtIso },
    });
    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: clickerId,
      event_type: AUDIT_EVENTS.STATE_TRANSITION,
      details: { event: "REJECT", from: ticket.status, to: result.next, reason },
    });

    // Edit the approver DM to remove buttons and show the rejection.
    if (pending?.dm_channel_id && pending?.message_ts) {
      try {
        const approverName = pending.approver_name ?? `<@${clickerId}>`;
        const { blocks, fallbackText } = approverDmAfterReject(
          updatedTicket,
          decidedAt,
          approverName,
          reason,
        );
        await updateMessage(
          client,
          pending.dm_channel_id,
          pending.message_ts,
          blocks,
          fallbackText,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[interactivity] approver DM update (reject) failed:", err);
      }
    }

    // Notify the requester in the source thread.
    try {
      await client.chat.postMessage({
        channel: updatedTicket.source_channel_id,
        thread_ts: updatedTicket.source_message_ts,
        text: `Sorry <@${updatedTicket.requester_user_id}>, expense \`${updatedTicket.tracking_id}\` was rejected by <@${clickerId}>.\n*Reason:* ${reason}`,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[interactivity] thread notify (reject) failed:",
        err,
      );
    }
  };
}

// ---------- mark as paid ----------

function makeMarkPaidHandler({ config }: Deps) {
  return async ({
    ack,
    body,
    client,
    action,
  }: {
    ack: () => Promise<void>;
    body: BlockAction;
    client: WebClient;
    action: ButtonAction;
  }): Promise<void> => {
    await ack();

    const trackingId = action.value;
    if (!trackingId) {
      // eslint-disable-next-line no-console
      console.warn("[interactivity] expense_mark_paid: missing tracking_id");
      return;
    }

    const clickerId = body.user.id;
    const channelId = body.channel?.id ?? "";
    const messageTs = body.message?.ts ?? "";

    if (clickerId !== config.FINANCIAL_MANAGER_USER_ID) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: clickerId,
        event_type: AUDIT_EVENTS.AUTHORIZATION_REJECTED,
        details: {
          action: "expense_mark_paid",
          expected: config.FINANCIAL_MANAGER_USER_ID,
          got: clickerId,
        },
      });
      try {
        if (channelId) {
          await postEphemeral(
            client,
            channelId,
            clickerId,
            "Only the financial manager can mark a ticket as paid.",
          );
        }
      } catch {
        // ignore
      }
      return;
    }

    const ticket = await getTicketByTrackingId(trackingId);
    if (!ticket) {
      try {
        if (channelId) {
          await postEphemeral(
            client,
            channelId,
            clickerId,
            `Ticket \`${trackingId}\` not found.`,
          );
        }
      } catch {
        // ignore
      }
      return;
    }

    const result = transition(ticket, { type: "MARK_AS_PAID" });
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[interactivity] expense_mark_paid illegal: ${result.error}`,
      );
      try {
        if (channelId) {
          await postEphemeral(
            client,
            channelId,
            clickerId,
            `Cannot mark paid; ticket status is ${ticket.status}.`,
          );
        }
      } catch {
        // ignore
      }
      return;
    }

    let updatedTicket: Ticket;
    try {
      updatedTicket = await updateTicket(trackingId, ticket.row_version, {
        status: result.next,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[interactivity] updateTicket(AWAITING_PAYMENT) failed:", err);
      return;
    }

    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: clickerId,
      event_type: AUDIT_EVENTS.PAYMENT_MARKED,
      details: { from: ticket.status, to: result.next },
    });
    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: clickerId,
      event_type: AUDIT_EVENTS.STATE_TRANSITION,
      details: { event: "MARK_AS_PAID", from: ticket.status, to: result.next },
    });

    // Edit the FM DM to remove the button + show the prompt.
    if (channelId && messageTs) {
      try {
        const { blocks, fallbackText } =
          financialManagerDmAfterMarkPaid(updatedTicket);
        await updateMessage(client, channelId, messageTs, blocks, fallbackText);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[interactivity] FM DM update failed:", err);
      }
    }

    // Make sure the sentinel approval row's dm coords are current — if the
    // approve flow already stored them this is a no-op; if for some reason
    // they're missing, top them up here.
    try {
      const approvals = await listApprovalsForTicket(trackingId);
      const sentinel = approvals.find(
        (a) => a.step_number === PAYMENT_STEP_SENTINEL,
      );
      if (sentinel && (!sentinel.dm_channel_id || !sentinel.message_ts)) {
        await updateApprovalDecision(sentinel.approval_id, {
          dm_channel_id: channelId,
          message_ts: messageTs,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[interactivity] sentinel approval upkeep failed:", err);
    }
  };
}

// ---------- payment-proof watcher ----------

interface FileShareEvent {
  channel?: string;
  user?: string;
  files?: Array<{
    id?: string;
    permalink?: string;
    url_private?: string;
  }>;
  ts?: string;
}

function makeFileShareHandler({ config }: Deps) {
  return async ({
    message,
    client,
  }: {
    message: unknown;
    client: WebClient;
  }): Promise<void> => {
    const ev = message as FileShareEvent & { subtype?: string };
    if (ev.subtype !== "file_share") return;
    if (!ev.channel || !ev.user) return;
    if (ev.user !== config.FINANCIAL_MANAGER_USER_ID) return;
    const files = ev.files ?? [];
    if (files.length === 0) return;
    const file = files[0]!;
    if (!file.id) return;

    // Find an AWAITING_PAYMENT ticket whose sentinel approval row's
    // dm_channel_id matches this file-share's channel.
    let candidates: Ticket[];
    try {
      candidates = await listNonTerminalTickets();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[interactivity] listNonTerminalTickets failed:", err);
      return;
    }
    const awaiting = candidates.filter((t) => t.status === "AWAITING_PAYMENT");
    if (awaiting.length === 0) return;

    let matched: { ticket: Ticket; sentinel: Approval } | null = null;
    for (const t of awaiting) {
      let approvals: Approval[];
      try {
        approvals = await listApprovalsForTicket(t.tracking_id);
      } catch {
        continue;
      }
      const sentinel = approvals.find(
        (a) =>
          a.step_number === PAYMENT_STEP_SENTINEL &&
          a.dm_channel_id === ev.channel,
      );
      if (sentinel) {
        matched = { ticket: t, sentinel };
        break;
      }
    }

    if (!matched) {
      // File posted in an unrelated DM — ignore.
      return;
    }

    const { ticket } = matched;

    const result = transition(ticket, {
      type: "PAYMENT_CONFIRMED",
      file_id: file.id,
    });
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[interactivity] PAYMENT_CONFIRMED illegal: ${result.error}`,
      );
      return;
    }

    let updated: Ticket;
    try {
      updated = await updateTicket(ticket.tracking_id, ticket.row_version, {
        status: result.next,
        payment_confirmation_file_id: file.id,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[interactivity] updateTicket(PAID) failed:",
        err,
      );
      return;
    }

    await safeAudit({
      tracking_id: ticket.tracking_id,
      actor_user_id: ev.user,
      event_type: AUDIT_EVENTS.PAYMENT_CONFIRMED,
      details: { file_id: file.id, permalink: file.permalink },
    });
    await safeAudit({
      tracking_id: ticket.tracking_id,
      actor_user_id: ev.user,
      event_type: AUDIT_EVENTS.STATE_TRANSITION,
      details: {
        event: "PAYMENT_CONFIRMED",
        from: ticket.status,
        to: result.next,
      },
    });

    // Mark the sentinel approval row as APPROVED so it's clear the payment
    // step is closed. (Idempotent — second click is a no-op.)
    try {
      await updateApprovalDecision(matched.sentinel.approval_id, {
        decision: "APPROVED",
        decided_at: new Date().toISOString(),
        comment: "payment confirmed",
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[interactivity] sentinel approval close failed:",
        err,
      );
    }

    // Forward to the requester's source thread.
    try {
      const link =
        file.permalink ?? file.url_private ?? "(payment proof attached)";
      await client.chat.postMessage({
        channel: updated.source_channel_id,
        thread_ts: updated.source_message_ts,
        text: `Payment processed for \`${updated.tracking_id}\` :white_check_mark:\n${link}`,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[interactivity] forwarding payment proof to thread failed:",
        err,
      );
    }
  };
}

// ---------- public registration ----------

export function registerInteractivity(app: App, deps: Deps): void {
  // Bolt's `app.action(id, handler)` types are loose — cast handler to the
  // shape Bolt provides. We accept BlockAction with a ButtonAction element.
  const approveHandler = makeApproveHandler(deps);
  const rejectButtonHandler = makeRejectButtonHandler();
  const rejectModalSubmitHandler = makeRejectModalSubmitHandler();
  const markPaidHandler = makeMarkPaidHandler(deps);
  const fileShareHandler = makeFileShareHandler(deps);

  app.action(
    "expense_approve",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      const action = args.action as ButtonAction;
      await approveHandler({
        ack: args.ack,
        body: args.body as BlockAction,
        client: args.client as WebClient,
        action,
      });
    },
  );

  app.action(
    "expense_reject",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      const action = args.action as ButtonAction;
      await rejectButtonHandler({
        ack: args.ack,
        body: args.body as BlockAction,
        client: args.client as WebClient,
        action,
      });
    },
  );

  // Reject modal submission. Bolt's `app.view(callback_id, handler)` matches
  // by callback_id. Authorization is re-checked inside the handler because
  // the modal can stay open after the underlying state has shifted.
  app.view(
    MODAL_REJECT_CALLBACK_ID,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      await rejectModalSubmitHandler(args);
    },
  );

  app.action(
    "expense_mark_paid",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      const action = args.action as ButtonAction;
      await markPaidHandler({
        ack: args.ack,
        body: args.body as BlockAction,
        client: args.client as WebClient,
        action,
      });
    },
  );

  // The `file_share` message subtype carries the file in `message.files[0]`.
  // We use `app.message` rather than `app.event("file_shared")` because the
  // message subtype gives us the user + channel + files in one payload.
  app.message(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      await fileShareHandler({
        message: args.message,
        client: args.client as WebClient,
      });
    },
  );
}
