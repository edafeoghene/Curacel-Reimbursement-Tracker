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
import { getCachedRoutes } from "../sheets/routes.js";
import { getTicketByTrackingId, listNonTerminalTickets, updateTicket } from "../sheets/tickets.js";
import { transition } from "../state/machine.js";
import { AUDIT_EVENTS, type Approval, type Ticket } from "../types.js";

import { dmUser, postEphemeral, updateMessage } from "./messaging.js";
import { fetchUserName, PAYMENT_STEP_SENTINEL, safeAudit } from "./events.js";
import {
  approverDmAfterApprove,
  approverDmAfterClarify,
  approverDmAfterDelegate,
  approverDmAfterReject,
  approverDmBlocks,
  CLARIFY_QUESTION_ACTION_ID,
  CLARIFY_QUESTION_BLOCK_ID,
  clarificationQuestionModal,
  DELEGATE_USER_ACTION_ID,
  DELEGATE_USER_BLOCK_ID,
  delegateUserPickerModal,
  financialManagerClarifyHintBlocks,
  financialManagerDmAfterMarkPaid,
  financialManagerDmBlocks,
  manualReviewDmBlocks,
  MODAL_CLARIFY_CALLBACK_ID,
  MODAL_DELEGATE_CALLBACK_ID,
  MODAL_REJECT_CALLBACK_ID,
  REJECT_REASON_ACTION_ID,
  REJECT_REASON_BLOCK_ID,
  rejectionReasonModal,
} from "./views.js";

interface Deps {
  config: Config;
}

/**
 * Build the ordered, deduped list of approver Slack IDs to surface on the FM
 * DM. Walks the approvals for this ticket: non-sentinel rows that are
 * APPROVED, ordered by step_number. Same person approving multiple steps is
 * shown once (rare, but possible during single-person testing).
 */
function collectStepApproverIds(approvals: Approval[]): string[] {
  const sorted = approvals
    .filter(
      (a) =>
        a.step_number !== PAYMENT_STEP_SENTINEL && a.decision === "APPROVED",
    )
    .sort((a, b) => a.step_number - b.step_number);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of sorted) {
    if (a.approver_user_id && !seen.has(a.approver_user_id)) {
      out.push(a.approver_user_id);
      seen.add(a.approver_user_id);
    }
  }
  return out;
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

    // Look up the route to compute is_final_step. Fail loudly to MANUAL_REVIEW
    // if the ticket's route_id is no longer in the cache (route was deleted or
    // renamed mid-flight). Per PLAN.md §14.
    const route = getCachedRoutes().find((r) => r.route_id === ticket.route_id);
    if (!route) {
      // eslint-disable-next-line no-console
      console.warn(
        `[interactivity] expense_approve: route ${ticket.route_id} not in cache; routing to MANUAL_REVIEW`,
      );
      try {
        const updated = await updateTicket(trackingId, ticket.row_version, {
          status: "MANUAL_REVIEW",
        });
        await safeAudit({
          tracking_id: trackingId,
          actor_user_id: "system",
          event_type: AUDIT_EVENTS.STATE_TRANSITION,
          details: {
            event: "ROUTE_LOST",
            from: ticket.status,
            to: "MANUAL_REVIEW",
            route_id: ticket.route_id,
          },
        });
        const { blocks, fallbackText } = manualReviewDmBlocks(
          updated,
          `Route \`${ticket.route_id}\` is no longer in the routes sheet — cannot determine the approval chain.`,
        );
        await dmUser(
          client,
          config.FINANCIAL_MANAGER_USER_ID,
          blocks,
          fallbackText,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          "[interactivity] route-lost MANUAL_REVIEW handling failed:",
          err,
        );
      }
      try {
        if (channelId) {
          await postEphemeral(
            client,
            channelId,
            clickerId,
            "This ticket's route is no longer configured. The financial manager has been notified.",
          );
        }
      } catch {
        // ignore
      }
      return;
    }

    const isFinal = ticket.current_step === route.approvers.length;

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

    // Compute ticket patch. Non-final approve advances current_step and
    // current_approver_user_id; final approve only flips status.
    const advanceEffect = result.sideEffects.find(
      (e) => e.type === "ADVANCE_TO_STEP",
    );
    let patch: Partial<Ticket> = { status: result.next };
    let nextApproverId: string | null = null;
    if (advanceEffect && advanceEffect.type === "ADVANCE_TO_STEP") {
      const idx = advanceEffect.step_number - 1;
      const candidate = route.approvers[idx];
      if (!candidate) {
        // Shouldn't happen — is_final_step computed off the same route — but
        // guard so we don't write a corrupt ticket.
        // eslint-disable-next-line no-console
        console.error(
          `[interactivity] ADVANCE_TO_STEP ${advanceEffect.step_number} has no approver in route ${route.route_id}`,
        );
        return;
      }
      nextApproverId = candidate;
      patch = {
        ...patch,
        current_step: advanceEffect.step_number,
        current_approver_user_id: candidate,
      };
    }

    // Update ticket (single source of truth = state machine).
    let updatedTicket: Ticket;
    try {
      updatedTicket = await updateTicket(trackingId, ticket.row_version, patch);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[interactivity] updateTicket(${result.next}) failed:`,
        err,
      );
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
        ...(nextApproverId
          ? { advance_to_step: updatedTicket.current_step, next_approver: nextApproverId }
          : {}),
      },
    });

    // Edit the approver DM to remove the button.
    if (channelId && messageTs) {
      try {
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

    if (nextApproverId) {
      // Non-final: DM the next approver and append a fresh approval row.
      try {
        const { blocks, fallbackText } = approverDmBlocks(updatedTicket);
        const dm = await dmUser(client, nextApproverId, blocks, fallbackText);
        const nextApproverName = await fetchUserName(client, nextApproverId);
        await appendApproval({
          approval_id: uuidv4(),
          tracking_id: trackingId,
          step_number: updatedTicket.current_step,
          approver_user_id: nextApproverId,
          approver_name: nextApproverName,
          decision: "PENDING",
          decided_at: null,
          comment: "",
          delegated_to_user_id: null,
          dm_channel_id: dm.channel,
          message_ts: dm.ts,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          "[interactivity] DM to next approver failed:",
          err,
        );
        // The previous step is already recorded as APPROVED and the ticket's
        // current_step has advanced — re-DMing is the financial manager's job
        // via /expense-resume once that lands. For now, surface to FM.
        try {
          const { blocks, fallbackText } = manualReviewDmBlocks(
            updatedTicket,
            `Failed to DM next approver <@${nextApproverId}> at step ${updatedTicket.current_step}: ${(err as Error).message}`,
          );
          await dmUser(
            client,
            config.FINANCIAL_MANAGER_USER_ID,
            blocks,
            fallbackText,
          );
        } catch {
          // ignore — already logged
        }
      }
      return;
    }

    // Final approve: DM the financial manager with "Mark as Paid".
    // Re-fetch approvals so the just-approved current step is included.
    let approverIdsForFm: string[] = [];
    try {
      const fresh = await listApprovalsForTicket(trackingId);
      approverIdsForFm = collectStepApproverIds(fresh);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[interactivity] could not load approvals for FM DM tagging:",
        err,
      );
      // Fall back to at least the current clicker so the FM sees who acted.
      approverIdsForFm = [clickerId];
    }
    try {
      const { blocks, fallbackText } = financialManagerDmBlocks(
        updatedTicket,
        approverIdsForFm,
      );
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

// ---------- clarify (Phase 1.2) ----------

/**
 * Clarify button handler. Mirrors the reject button: re-authorize, open the
 * question modal. The modal-submit handler does the real work.
 */
function makeClarifyButtonHandler() {
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
      console.warn("[interactivity] expense_clarify: missing tracking_id value");
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
          action: "expense_clarify",
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

    if (!body.trigger_id) {
      // eslint-disable-next-line no-console
      console.warn("[interactivity] expense_clarify: missing trigger_id");
      return;
    }
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        view: clarificationQuestionModal(trackingId) as any,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[interactivity] views.open(clarify modal) failed:", err);
    }
  };
}

/**
 * Clarify modal submission handler. Re-fetches the ticket, re-authorizes,
 * runs the state machine (CLARIFY → NEEDS_CLARIFICATION), updates the
 * approval row to CLARIFICATION_REQUESTED with the question as comment,
 * edits the approver DM to show the question, posts in the requester's
 * source thread tagging them, and DMs the financial manager with a
 * `/expense-resume` hint.
 */
function makeClarifyModalSubmitHandler({ config }: Deps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any): Promise<void> => {
    await args.ack();

    const view = args.body.view;
    const clickerId = args.body.user.id;
    const trackingId: string = view.private_metadata ?? "";
    const questionRaw: string =
      view.state?.values?.[CLARIFY_QUESTION_BLOCK_ID]?.[
        CLARIFY_QUESTION_ACTION_ID
      ]?.value ?? "";
    const question = questionRaw.trim();

    if (!trackingId || !question) {
      // eslint-disable-next-line no-console
      console.warn(
        "[interactivity] clarify modal submit: missing tracking_id or question",
      );
      return;
    }

    const client: WebClient = args.client;

    const ticket = await getTicketByTrackingId(trackingId);
    if (!ticket) {
      // eslint-disable-next-line no-console
      console.warn(
        `[interactivity] clarify modal submit: ticket ${trackingId} not found`,
      );
      return;
    }

    if (clickerId !== ticket.current_approver_user_id) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: clickerId,
        event_type: AUDIT_EVENTS.AUTHORIZATION_REJECTED,
        details: {
          action: "expense_clarify_submit",
          expected: ticket.current_approver_user_id,
          got: clickerId,
        },
      });
      return;
    }

    const result = transition(ticket, {
      type: "CLARIFY",
      step: ticket.current_step,
      approver_user_id: clickerId,
      question,
    });
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[interactivity] expense_clarify illegal: ${result.error}`,
      );
      return;
    }

    // Find the pending approval row for the current step.
    const approvals = await listApprovalsForTicket(trackingId);
    const pending = approvals.find(
      (a) =>
        a.step_number === ticket.current_step && a.decision === "PENDING",
    );

    const askedAt = new Date();
    const askedAtIso = askedAt.toISOString();

    if (pending) {
      try {
        await updateApprovalDecision(pending.approval_id, {
          decision: "CLARIFICATION_REQUESTED",
          decided_at: askedAtIso,
          comment: question,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          "[interactivity] updateApprovalDecision(CLARIFY) failed:",
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
      console.error(
        "[interactivity] updateTicket(NEEDS_CLARIFICATION) failed:",
        err,
      );
      return;
    }

    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: clickerId,
      event_type: AUDIT_EVENTS.CLARIFICATION_REQUESTED,
      details: { step: ticket.current_step, question, asked_at: askedAtIso },
    });
    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: clickerId,
      event_type: AUDIT_EVENTS.STATE_TRANSITION,
      details: {
        event: "CLARIFY",
        from: ticket.status,
        to: result.next,
        question,
      },
    });

    // Edit the approver DM to remove buttons and surface the question.
    if (pending?.dm_channel_id && pending?.message_ts) {
      try {
        const approverName = pending.approver_name ?? `<@${clickerId}>`;
        const { blocks, fallbackText } = approverDmAfterClarify(
          updatedTicket,
          askedAt,
          approverName,
          question,
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
        console.warn(
          "[interactivity] approver DM update (clarify) failed:",
          err,
        );
      }
    }

    // Notify the requester in the source thread.
    try {
      await client.chat.postMessage({
        channel: updatedTicket.source_channel_id,
        thread_ts: updatedTicket.source_message_ts,
        text: `Hi <@${updatedTicket.requester_user_id}>, <@${clickerId}> needs more info on \`${updatedTicket.tracking_id}\`.\n*Question:* ${question}\n\nReply here when you can. The financial manager will resume the approval once you answer.`,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[interactivity] thread notify (clarify) failed:",
        err,
      );
    }

    // DM the financial manager with the resume hint.
    try {
      const { blocks, fallbackText } = financialManagerClarifyHintBlocks(
        updatedTicket,
        clickerId,
        question,
      );
      await dmUser(
        client,
        config.FINANCIAL_MANAGER_USER_ID,
        blocks,
        fallbackText,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[interactivity] FM clarify-hint DM failed:",
        err,
      );
    }
  };
}

// ---------- delegate (Phase 1.3) ----------

/**
 * Delegate button handler. Mirrors the reject/clarify buttons: re-authorize
 * (only the current approver may delegate), open the user-picker modal.
 * The modal-submit handler does the real work.
 */
function makeDelegateButtonHandler() {
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
      console.warn(
        "[interactivity] expense_delegate: missing tracking_id value",
      );
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
          action: "expense_delegate",
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

    if (!body.trigger_id) {
      // eslint-disable-next-line no-console
      console.warn("[interactivity] expense_delegate: missing trigger_id");
      return;
    }
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        view: delegateUserPickerModal(trackingId) as any,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[interactivity] views.open(delegate modal) failed:", err);
    }
  };
}

/**
 * Delegate modal submission handler. Re-fetches the ticket, re-authorizes,
 * marks the existing PENDING approval row as DELEGATED (with the new
 * approver in `delegated_to_user_id`), appends a fresh PENDING approval row
 * for the chosen delegate, updates ticket.current_approver_user_id, edits
 * the original approver's DM to "Delegated to <@new>", and DMs the new
 * approver. State stays AWAITING_APPROVAL — delegation is not a state
 * transition.
 */
function makeDelegateModalSubmitHandler() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (args: any): Promise<void> => {
    const view = args.body.view;
    const clickerId = args.body.user.id;
    const trackingId: string = view.private_metadata ?? "";
    const newApproverId: string =
      view.state?.values?.[DELEGATE_USER_BLOCK_ID]?.[DELEGATE_USER_ACTION_ID]
        ?.selected_user ?? "";

    if (!trackingId || !newApproverId) {
      await args.ack({
        response_action: "errors",
        errors: {
          [DELEGATE_USER_BLOCK_ID]:
            "Pick a user to delegate the approval to.",
        },
      });
      return;
    }

    if (newApproverId === clickerId) {
      await args.ack({
        response_action: "errors",
        errors: {
          [DELEGATE_USER_BLOCK_ID]:
            "You can't delegate the approval to yourself.",
        },
      });
      return;
    }

    await args.ack();

    const client: WebClient = args.client;

    const ticket = await getTicketByTrackingId(trackingId);
    if (!ticket) {
      // eslint-disable-next-line no-console
      console.warn(
        `[interactivity] delegate modal submit: ticket ${trackingId} not found`,
      );
      return;
    }

    if (clickerId !== ticket.current_approver_user_id) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: clickerId,
        event_type: AUDIT_EVENTS.AUTHORIZATION_REJECTED,
        details: {
          action: "expense_delegate_submit",
          expected: ticket.current_approver_user_id,
          got: clickerId,
        },
      });
      return;
    }

    // Find the pending approval row for the current step (the one being
    // delegated AWAY from).
    const approvals = await listApprovalsForTicket(trackingId);
    const pending = approvals.find(
      (a) =>
        a.step_number === ticket.current_step && a.decision === "PENDING",
    );

    const delegatedAt = new Date();
    const delegatedAtIso = delegatedAt.toISOString();

    // Step 1: flip the original PENDING row to DELEGATED. The
    // `delegated_to_user_id` field on this row records who the approval
    // was handed to.
    if (pending) {
      try {
        await updateApprovalDecision(pending.approval_id, {
          decision: "DELEGATED",
          decided_at: delegatedAtIso,
          comment: `delegated to <@${newApproverId}>`,
          delegated_to_user_id: newApproverId,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          "[interactivity] updateApprovalDecision(DELEGATE) failed:",
          err,
        );
      }
    }

    // Step 2: update ticket.current_approver_user_id. Status stays
    // AWAITING_APPROVAL — delegation is not a state transition.
    let updatedTicket: Ticket;
    try {
      updatedTicket = await updateTicket(trackingId, ticket.row_version, {
        current_approver_user_id: newApproverId,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[interactivity] updateTicket(delegate) failed:",
        err,
      );
      return;
    }

    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: clickerId,
      event_type: AUDIT_EVENTS.DELEGATED,
      details: {
        step: ticket.current_step,
        from: clickerId,
        to: newApproverId,
        decided_at: delegatedAtIso,
      },
    });

    // Step 3: DM the new approver and append a fresh PENDING approval row.
    let dm: { channel: string; ts: string };
    try {
      const { blocks, fallbackText } = approverDmBlocks(updatedTicket);
      dm = await dmUser(client, newApproverId, blocks, fallbackText);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[interactivity] DM to delegate failed:",
        err,
      );
      return;
    }

    try {
      const newApproverName = await fetchUserName(client, newApproverId);
      await appendApproval({
        approval_id: uuidv4(),
        tracking_id: trackingId,
        step_number: updatedTicket.current_step,
        approver_user_id: newApproverId,
        approver_name: newApproverName,
        decision: "PENDING",
        decided_at: null,
        // delegated_to_user_id on the NEW row records provenance: this row
        // is the result of a delegation FROM clickerId. The old row's
        // delegated_to_user_id points the other way (TO newApproverId).
        delegated_to_user_id: clickerId,
        comment: `delegated from <@${clickerId}>`,
        dm_channel_id: dm.channel,
        message_ts: dm.ts,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[interactivity] appendApproval(delegate) failed:",
        err,
      );
      // The DM was sent — without a row we can't track button clicks
      // cleanly. Leave the warning; manual recovery is possible.
    }

    // Step 4: edit the original approver's DM to remove buttons and show
    // "Delegated to <@new>".
    if (pending?.dm_channel_id && pending?.message_ts) {
      try {
        const fromName = pending.approver_name ?? `<@${clickerId}>`;
        const { blocks, fallbackText } = approverDmAfterDelegate(
          updatedTicket,
          delegatedAt,
          fromName,
          newApproverId,
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
        console.warn(
          "[interactivity] approver DM update (delegate) failed:",
          err,
        );
      }
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

    // Load approvals once: used for both the FM DM rebuild (approver tags)
    // and sentinel upkeep below.
    let approvals: Approval[] = [];
    try {
      approvals = await listApprovalsForTicket(trackingId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[interactivity] listApprovalsForTicket(mark_paid) failed:",
        err,
      );
    }
    const approverIdsForFm = collectStepApproverIds(approvals);

    // Edit the FM DM to remove the button + show the prompt (preserve the
    // approver tags so the FM still sees who approved).
    if (channelId && messageTs) {
      try {
        const { blocks, fallbackText } = financialManagerDmAfterMarkPaid(
          updatedTicket,
          approverIdsForFm,
        );
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
  const clarifyButtonHandler = makeClarifyButtonHandler();
  const clarifyModalSubmitHandler = makeClarifyModalSubmitHandler(deps);
  const delegateButtonHandler = makeDelegateButtonHandler();
  const delegateModalSubmitHandler = makeDelegateModalSubmitHandler();
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
    "expense_clarify",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      const action = args.action as ButtonAction;
      await clarifyButtonHandler({
        ack: args.ack,
        body: args.body as BlockAction,
        client: args.client as WebClient,
        action,
      });
    },
  );

  app.view(
    MODAL_CLARIFY_CALLBACK_ID,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      await clarifyModalSubmitHandler(args);
    },
  );

  app.action(
    "expense_delegate",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      const action = args.action as ButtonAction;
      await delegateButtonHandler({
        ack: args.ack,
        body: args.body as BlockAction,
        client: args.client as WebClient,
        action,
      });
    },
  );

  app.view(
    MODAL_DELEGATE_CALLBACK_ID,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      await delegateModalSubmitHandler(args);
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
