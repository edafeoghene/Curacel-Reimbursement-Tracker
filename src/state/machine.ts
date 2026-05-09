// Pure state-transition function for the expense ticket lifecycle.
// No I/O. No external SDKs. The only inputs are (currentTicket, event).
// All side effects required by the plan (DMs, thread posts, etc.) are
// returned as data in `sideEffects` for the caller to execute.

import type {
  Ticket,
  StateEvent,
  TransitionResult,
  SideEffect,
  Status,
} from "../types.js";

/**
 * Apply a state event to a ticket and produce the next status + side effects.
 * Illegal transitions return `{ ok: false, error }` with a message naming the
 * current status and the event type — no exceptions are thrown.
 *
 * Per PLAN.md §4 (#10): no code path may write `status` to the sheet without
 * going through this function.
 */
export function transition(
  ticket: Ticket,
  event: StateEvent,
): TransitionResult {
  const status: Status = ticket.status;

  switch (event.type) {
    case "CLASSIFIED": {
      // CLASSIFIED is only legal as the first step out of SUBMITTED.
      if (status !== "SUBMITTED") {
        return illegal(status, event.type);
      }
      if (event.confidence < 0.7) {
        return ok("MANUAL_REVIEW", [
          {
            type: "DM_FINANCIAL_MANAGER_MANUAL_REVIEW",
            reason: `Low classifier confidence (${event.confidence.toFixed(2)})`,
          },
        ]);
      }
      // Confident classification: stay in SUBMITTED until the first DM is
      // actually delivered. The plan models the "DM sent" boundary explicitly
      // so a crash between classify and DM doesn't lose tickets.
      return ok("SUBMITTED", []);
    }

    case "FIRST_DM_SENT": {
      if (status !== "SUBMITTED") {
        return illegal(status, event.type);
      }
      return ok("AWAITING_APPROVAL", []);
    }

    case "APPROVE": {
      if (status !== "AWAITING_APPROVAL") {
        return illegal(status, event.type);
      }
      if (event.is_final_step) {
        return ok("APPROVED", [{ type: "DM_FINANCIAL_MANAGER_FOR_PAYMENT" }]);
      }
      // More steps remain — stay AWAITING_APPROVAL but emit DM for next step.
      // Caller is responsible for resolving who the next approver is and
      // updating ticket.current_step / current_approver_user_id in the sheet.
      // The state machine reports the *next* step as current+1.
      const nextStep = ticket.current_step + 1;
      return ok("AWAITING_APPROVAL", [
        {
          type: "DM_NEXT_APPROVER",
          // approver_user_id is filled in by the caller from the route chain;
          // the state machine cannot know it. We pass empty string so the type
          // shape is honored — see SideEffect type. Callers MUST overwrite.
          approver_user_id: "",
          step_number: nextStep,
        },
      ]);
    }

    case "REJECT": {
      if (status !== "AWAITING_APPROVAL") {
        return illegal(status, event.type);
      }
      return ok("REJECTED", [
        {
          type: "POST_REJECTION_TO_THREAD",
          reason: event.reason,
          rejected_by: event.approver_user_id,
        },
      ]);
    }

    case "CLARIFY": {
      if (status !== "AWAITING_APPROVAL") {
        return illegal(status, event.type);
      }
      return ok("NEEDS_CLARIFICATION", [
        {
          type: "POST_CLARIFICATION_TO_THREAD",
          question: event.question,
          asked_by: event.approver_user_id,
        },
        {
          type: "DM_FINANCIAL_MANAGER_CLARIFICATION",
          requester_user_id: ticket.requester_user_id,
        },
      ]);
    }

    case "RESUME_AFTER_CLARIFY": {
      if (status !== "NEEDS_CLARIFICATION") {
        return illegal(status, event.type);
      }
      return ok("AWAITING_APPROVAL", [
        {
          type: "DM_NEXT_APPROVER",
          // Re-DM the same approver at the same step.
          approver_user_id: ticket.current_approver_user_id,
          step_number: ticket.current_step,
        },
      ]);
    }

    case "MARK_AS_PAID": {
      if (status !== "APPROVED") {
        return illegal(status, event.type);
      }
      return ok("AWAITING_PAYMENT", [{ type: "REQUEST_PAYMENT_PROOF_DM" }]);
    }

    case "PAYMENT_CONFIRMED": {
      if (status !== "AWAITING_PAYMENT") {
        return illegal(status, event.type);
      }
      return ok("PAID", [
        { type: "POST_PAYMENT_PROOF_TO_THREAD", file_id: event.file_id },
      ]);
    }

    case "CANCEL": {
      if (isTerminal(status)) {
        return illegal(status, event.type);
      }
      return ok("CANCELLED", [
        {
          type: "POST_CANCELLATION_TO_THREAD",
          cancelled_by: event.actor_user_id,
        },
      ]);
    }

    default: {
      // Exhaustiveness guard — if a new StateEvent variant is added and not
      // handled above, TypeScript will complain here.
      const _exhaustive: never = event;
      void _exhaustive;
      return { ok: false, error: `Unknown event type` };
    }
  }
}

function ok(next: Status, sideEffects: SideEffect[]): TransitionResult {
  return { ok: true, next, sideEffects };
}

function illegal(current: Status, eventType: string): TransitionResult {
  return {
    ok: false,
    error: `Illegal transition: cannot apply event "${eventType}" while status is "${current}"`,
  };
}

function isTerminal(status: Status): boolean {
  return status === "PAID" || status === "REJECTED" || status === "CANCELLED";
}
