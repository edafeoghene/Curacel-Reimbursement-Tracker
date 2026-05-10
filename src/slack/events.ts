// Slack `message` event handler. The entry point for the entire submission
// flow: filter, gate, classify, write ticket, ack, DM the approver.
//
// PLAN.md §7 message filters and §13.1 happy-path are encoded literally here.
// Phase 1.0 only — multi-expense splitting, full chain traversal, and modal
// branches are explicitly deferred.

import type { App, KnownEventFromType, SayFn } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

import type { Config } from "../config.js";
import { generateTrackingId, isValidTrackingId } from "../id.js";
import { ClassifierParseError, classifyExpense } from "../llm/classify.js";
import { LLMCallFailed } from "../llm/client.js";
import {
  appendApproval,
  listApprovalsForTicket,
  updateApprovalDecision,
} from "../sheets/approvals.js";
import { safeAudit } from "../sheets/audit.js";
import {
  appendTicket,
  getTicketBySourceMessageTs,
  getTicketByTrackingId,
  listNonTerminalTickets,
  updateTicket,
} from "../sheets/tickets.js";
import { resolveRoute } from "../state/routing.js";
import { transition } from "../state/machine.js";
import { getCachedRoutes } from "../sheets/routes.js";
import {
  AUDIT_EVENTS,
  PAYMENT_STEP_SENTINEL,
  type Approval,
  type ClassifierImage,
  type ClassifierItem,
  type ClassifierResult,
  type Status,
  type Ticket,
} from "../types.js";
import { v4 as uuidv4 } from "uuid";

import { downloadSlackFile, isPdf, isSupportedImage } from "./files.js";
import { extractPdfPage1AsImage } from "../llm/pdf.js";
import { postFeedLine } from "./feed.js";
import { ackInThread, dmUser, postEphemeral } from "./messaging.js";
import { fetchUserName } from "./users.js";
import { approverDmBlocks, manualReviewDmBlocks } from "./views.js";

const AMOUNT_REGEX =
  /(?:[₦$€£]\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:NGN|USD|EUR|GBP)\b)/i;

function hasParseableAmount(text: string | undefined): boolean {
  if (!text) return false;
  return AMOUNT_REGEX.test(text);
}

// Cheap heuristic: words that strongly suggest the user is trying to log an
// expense or invoice. Used for the smart pre-classify gate so that pure
// chatter ("hello") is silently dropped without an LLM call AND without an
// ephemeral nudge. Keep this regex tight — false positives here cost a
// (visible to one user) ephemeral; false negatives mean a real expense
// without amount/receipt is silently dropped (the user must add one).
const EXPENSE_KEYWORD_REGEX = new RegExp(
  String.raw`\b(uber|bolt|taxi|cab|ride|fare|paid|spent|bought|purchas(?:e[ds]?|ing)|expens(?:e|ing|es)|invoice|reimburs|refund|trip|travel|fuel|petrol|airfare|flight|hotel|airbnb|meal|lunch|dinner|breakfast|catering|subscription|saas|domain|hosting|tool(?:ing)?|repair(?:ed|s|ing)?|fix(?:ed|ing)?|equipment|laptop|monitor|keyboard|courier|dispatch|delivery|payment|fee|cost|bill|receipt|expense)\b`,
  "i",
);
export function hasExpenseKeywords(text: string | undefined): boolean {
  if (!text) return false;
  return EXPENSE_KEYWORD_REGEX.test(text);
}

// In-memory store of source-message timestamps that triggered an ephemeral
// "looks like an expense?" nudge. When the user later edits the original
// message OR replies in thread with a receipt/amount, we re-enter the
// classification pipeline using those new inputs and anchor the ticket on
// the original ts. PLAN.md §3 carve-out: this is the ONLY path through
// which message_changed and thread replies are allowed to create tickets.
//
// State is intentionally in-memory — bot restart loses pending nudges,
// which the user can resolve by re-posting. PLAN.md §4 forbids persistent
// state outside Sheets, and pending nudges aren't load-bearing data.
interface PendingNudge {
  source_message_ts: string;
  channel_id: string;
  requester_user_id: string;
  parent_text: string;
  posted_at_ms: number;
}
const pendingNudges = new Map<string, PendingNudge>();
const NUDGE_TTL_MS = 30 * 60 * 1000; // 30 min
const NUDGE_MAX = 200; // defensive cap

/** Lazy GC — runs at the top of every message handler invocation. */
function gcNudges(now = Date.now()): void {
  if (pendingNudges.size === 0) return;
  for (const [ts, n] of pendingNudges) {
    if (now - n.posted_at_ms > NUDGE_TTL_MS) pendingNudges.delete(ts);
  }
  if (pendingNudges.size > NUDGE_MAX) {
    const sorted = [...pendingNudges.entries()].sort(
      (a, b) => a[1].posted_at_ms - b[1].posted_at_ms,
    );
    while (sorted.length > NUDGE_MAX) {
      const next = sorted.shift();
      if (next) pendingNudges.delete(next[0]);
    }
  }
}

/** Test-only escape hatch for resetting in-memory pending state between cases. */
export function __resetPendingNudgesForTests(): void {
  pendingNudges.clear();
}

/** Test-only: seed a pending nudge so the edit/thread paths can be exercised. */
export function __seedPendingNudgeForTests(n: PendingNudge): void {
  pendingNudges.set(n.source_message_ts, n);
}

interface SlackFilePartial {
  id?: string;
  url_private?: string;
  url_private_download?: string;
  mimetype?: string;
  filetype?: string;
  name?: string;
}

/**
 * Resolved submission shape — what events.ts pipeline operates on after
 * the dispatch stage figures out whether this is a brand-new top-level
 * message, an edit completing a pending nudge, or a thread reply
 * completing a pending nudge.
 *
 * `source_message_ts` is always the parent ts (the one a ticket should
 * anchor on), so thread replies and edits both produce a submission
 * keyed on the original message — never on the reply/edit event itself.
 */
interface ResolvedSubmission {
  kind: "new" | "edit-completion" | "thread-completion";
  source_message_ts: string;
  channel_id: string;
  user_id: string;
  text: string;
  files: SlackFilePartial[];
  /** True when this submission consumes a pending nudge entry. */
  consumes_nudge_ts: string | null;
}

interface RawMsg {
  channel?: string;
  subtype?: string;
  bot_id?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
  text?: string;
  files?: SlackFilePartial[];
  message?: {
    ts?: string;
    text?: string;
    files?: SlackFilePartial[];
    user?: string;
  };
  previous_message?: { ts?: string };
}

/**
 * Pure dispatch logic. Decides whether the incoming Slack message becomes
 * a submission to the pipeline, and if so, what its effective inputs are.
 *
 * This is the single place where PLAN.md §7's filter rules and the
 * §3 nudge-completion carve-out coexist:
 *   - message_changed → only allowed when the parent ts is in pendingNudges
 *   - thread reply    → only allowed when the parent ts is in pendingNudges
 *                        AND the reply is from the original requester
 *   - everything else (edits/threads on logged tickets, bots, deletes) → drop
 *
 * Exported for unit testing.
 */
export function resolveSubmission(
  raw: RawMsg,
  expensesChannelId: string,
  nudges: Map<string, PendingNudge>,
):
  | { ok: true; submission: ResolvedSubmission }
  | { ok: false; reason: string } {
  if (raw.channel !== expensesChannelId)
    return { ok: false, reason: "wrong channel" };
  if (raw.bot_id) return { ok: false, reason: "bot message" };
  if (raw.subtype === "message_deleted") return { ok: false, reason: "deleted" };

  // Edit path — only valid as a completion of a pending nudge.
  if (raw.subtype === "message_changed") {
    const inner = raw.message;
    const parentTs = inner?.ts ?? raw.previous_message?.ts;
    if (!parentTs) return { ok: false, reason: "edit without parent ts" };
    const pending = nudges.get(parentTs);
    if (!pending) {
      return {
        ok: false,
        reason: "edit on non-nudged message — ignored per PLAN.md §14",
      };
    }
    return {
      ok: true,
      submission: {
        kind: "edit-completion",
        source_message_ts: parentTs,
        channel_id: pending.channel_id,
        user_id: pending.requester_user_id,
        text: (inner?.text ?? pending.parent_text).trim(),
        files: inner?.files ?? [],
        consumes_nudge_ts: parentTs,
      },
    };
  }

  // Thread reply — only valid as a completion of a pending nudge,
  // and only from the original requester.
  if (raw.thread_ts && raw.thread_ts !== raw.ts) {
    const pending = nudges.get(raw.thread_ts);
    if (!pending) {
      return {
        ok: false,
        reason: "thread reply on non-nudged message — ignored per PLAN.md §7",
      };
    }
    if (raw.user && raw.user !== pending.requester_user_id) {
      return {
        ok: false,
        reason: "thread reply not from the original requester",
      };
    }
    // Combine parent text + reply text so amount/keywords from either count.
    const replyText = raw.text ?? "";
    const combined = `${pending.parent_text}\n${replyText}`.trim();
    return {
      ok: true,
      submission: {
        kind: "thread-completion",
        source_message_ts: raw.thread_ts,
        channel_id: pending.channel_id,
        user_id: pending.requester_user_id,
        text: combined,
        files: raw.files ?? [],
        consumes_nudge_ts: raw.thread_ts,
      },
    };
  }

  // Top-level path. Allow no-subtype and file_share; reject anything else
  // (e.g. channel_join, channel_topic — chatter that isn't an expense).
  if (raw.subtype && raw.subtype !== "file_share") {
    return { ok: false, reason: `subtype ${raw.subtype}` };
  }
  if (!raw.user || !raw.ts) {
    return { ok: false, reason: "missing user or ts" };
  }
  return {
    ok: true,
    submission: {
      kind: "new",
      source_message_ts: raw.ts,
      channel_id: raw.channel,
      user_id: raw.user,
      text: raw.text ?? "",
      files: raw.files ?? [],
      consumes_nudge_ts: null,
    },
  };
}

/**
 * Best-effort image collection for the classifier. PNG/JPG are downloaded
 * directly. PDFs are downloaded and have page 1 extracted to PNG via
 * src/llm/pdf.ts. Per PLAN.md §8, multi-page PDFs only contribute page 1
 * to the model — this is a known limitation, not flagged per ticket.
 *
 * Acquisition failures (download or PDF extraction) are surfaced via
 * `downloadFailures` and do not abort classification — the classifier runs
 * on text only as a fallback. The audit log captures the failures for
 * later inspection.
 */
async function collectImages(
  files: SlackFilePartial[] | undefined,
  trackingHintId: string | null,
): Promise<{
  images: ClassifierImage[];
  primary: SlackFilePartial | null;
  downloadFailures: string[];
}> {
  const images: ClassifierImage[] = [];
  const downloadFailures: string[] = [];
  let primary: SlackFilePartial | null = null;
  const tag = trackingHintId ?? "(no-id)";

  for (const f of files ?? []) {
    if (!f.url_private) continue;

    // PDF: download, extract page 1 as PNG.
    if (isPdf(f)) {
      try {
        const dl = await downloadSlackFile(f.url_private);
        const img = await extractPdfPage1AsImage(dl.buffer);
        images.push(img);
        if (!primary) primary = f;
      } catch (err) {
        downloadFailures.push(
          `[${tag}] PDF acquisition failed for ${f.id ?? f.name ?? "<file>"}: ${(err as Error).message}`,
        );
      }
      continue;
    }

    // PNG/JPG: download as-is.
    if (!isSupportedImage(f)) continue;
    try {
      const dl = await downloadSlackFile(f.url_private);
      images.push({ mime: dl.mime, base64: dl.buffer.toString("base64") });
      if (!primary) primary = f;
    } catch (err) {
      downloadFailures.push(
        `[${tag}] failed to download ${f.id ?? f.name ?? "<file>"}: ${(err as Error).message}`,
      );
    }
  }

  return { images, primary, downloadFailures };
}

/**
 * Try up to 3 times to find a fresh tracking_id that doesn't collide with an
 * existing ticket. Returns null if all 3 attempts collided (extremely rare).
 */
async function generateUniqueTrackingId(): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    const id = generateTrackingId();
    if (!isValidTrackingId(id)) continue;
    const existing = await getTicketByTrackingId(id);
    if (!existing) return id;
  }
  return null;
}

// Result of processing a single classified item. Multi-expense splitting
// (Phase 1.4): one classifier call can produce several tickets; the thread
// ack summarizes all of them at the end.
export type ItemOutcome =
  | { kind: "ok"; trackingId: string; approverId: string; routeId: string; item: ClassifierItem }
  | { kind: "manual"; trackingId: string | null; reason: string; item: ClassifierItem };

/**
 * Compose the single thread-ack message after all items in a multi-expense
 * submission are processed. Single-item case stays terse so it reads the
 * same as before. Multi-item case bullets each ticket with its summary +
 * destination (approver, manual review, or failed-to-allocate).
 */
export function formatMultiItemAck(outcomes: ItemOutcome[]): string {
  if (outcomes.length === 1) {
    const o = outcomes[0]!;
    if (o.kind === "ok") {
      return `Logged as \`${o.trackingId}\`. Routing to <@${o.approverId}> for approval.`;
    }
    if (o.trackingId) {
      return `Logged \`${o.trackingId}\` for manual review (${o.reason}).`;
    }
    return `Could not log this expense (${o.reason}).`;
  }
  const lines: string[] = [];
  lines.push(`Logged ${outcomes.length} expenses from this message:`);
  for (const o of outcomes) {
    const summary = `${o.item.currency} ${formatAmount(o.item.amount)} · ${o.item.category}`;
    if (o.kind === "ok") {
      lines.push(`• \`${o.trackingId}\` — ${summary} → <@${o.approverId}>`);
    } else if (o.trackingId) {
      lines.push(
        `• \`${o.trackingId}\` — ${summary} → manual review (${o.reason})`,
      );
    } else {
      lines.push(`• ${summary} → could not log (${o.reason})`);
    }
  }
  return lines.join("\n");
}

function formatAmount(amount: number): string {
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

interface HandlerDeps {
  config: Config;
}

/** Make the message handler. Bolt registers this as `app.message(...)`. */
export function makeMessageHandler(deps: HandlerDeps) {
  const { config } = deps;

  return async ({
    message,
    client,
  }: {
    message: KnownEventFromType<"message">;
    client: WebClient;
    say: SayFn;
  }): Promise<void> => {
    gcNudges();

    const raw = message as unknown as RawMsg;

    // Breadcrumb: one line per delivered event so we can tell from logs
    // whether Slack is delivering and what shape we got.
    // eslint-disable-next-line no-console
    console.info(
      `[events] message received channel=${raw.channel ?? "?"} subtype=${raw.subtype ?? "(none)"} user=${raw.user ?? "?"} ts=${raw.ts ?? "?"} thread_ts=${raw.thread_ts ?? ""} files=${(raw.files ?? []).length}`,
    );

    // First-branch dispatch: payment-proof file_shares from the FM in the
    // FM's DM channel. Owns the AWAITING_PAYMENT → PAID transition. We
    // short-circuit out of the normal expense-submission flow when this
    // matches, so a payment proof can't be misclassified as an expense.
    const proofMessage = raw as unknown as PaymentProofMessage;
    if (looksLikePaymentProof(proofMessage, config.FINANCIAL_MANAGER_USER_ID)) {
      await processPaymentProofFromFile({
        client,
        config,
        message: proofMessage,
      });
      return;
    }

    const dispatch = resolveSubmission(
      raw,
      config.EXPENSES_CHANNEL_ID,
      pendingNudges,
    );
    if (!dispatch.ok) {
      // eslint-disable-next-line no-console
      console.info(`[events] dropped: ${dispatch.reason}`);
      return;
    }

    const sub = dispatch.submission;
    const sourceTs = sub.source_message_ts;
    const userId = sub.user_id;
    const text = sub.text;
    const files = sub.files;

    // ---- Smart pre-classification gate ----
    // Tightened from "no files AND no amount → nudge" to
    // "no files AND no amount AND text looks expense-shaped → nudge."
    // Pure chatter ("hello") is silently dropped now.
    const hasFiles = files.length > 0;
    const hasAmount = hasParseableAmount(text);
    if (!hasFiles && !hasAmount) {
      // Don't nudge twice for the same parent — the user is in a state where
      // we already asked them to add something.
      if (sub.kind !== "new") {
        // eslint-disable-next-line no-console
        console.info(
          `[events] ${sub.kind} for ${sourceTs} arrived without files/amount; staying silent (waiting for further input).`,
        );
        return;
      }
      if (!hasExpenseKeywords(text)) {
        // eslint-disable-next-line no-console
        console.info(
          `[events] ${sourceTs} dropped: no files, no amount, no expense-shaped keywords (chatter)`,
        );
        return;
      }
      // Looks like an expense intent that's missing a piece — nudge AND
      // register so we pick up the user's edit/thread-reply when they
      // complete the message.
      try {
        await postEphemeral(
          client,
          config.EXPENSES_CHANNEL_ID,
          userId,
          "Looks like an expense — please attach a receipt or include the amount. Edit the message or reply in this thread with the missing piece and I'll log it.",
        );
        pendingNudges.set(sourceTs, {
          source_message_ts: sourceTs,
          channel_id: config.EXPENSES_CHANNEL_ID,
          requester_user_id: userId,
          parent_text: text,
          posted_at_ms: Date.now(),
        });
        // eslint-disable-next-line no-console
        console.info(
          `[events] nudged ${sourceTs}; pending nudges = ${pendingNudges.size}`,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[events] postEphemeral nudge failed:", err);
      }
      return;
    }

    // We're going to attempt to create a ticket — consume any pending nudge
    // for this parent ts so future edits/replies don't keep re-triggering.
    if (sub.consumes_nudge_ts) {
      pendingNudges.delete(sub.consumes_nudge_ts);
    }

    // ---- Idempotency: skip if a ticket already exists for this ts ----
    try {
      const existing = await getTicketBySourceMessageTs(sourceTs);
      if (existing) {
        // eslint-disable-next-line no-console
        console.info(
          `[events] duplicate delivery for ts=${sourceTs} (ticket ${existing.tracking_id}); skipping.`,
        );
        return;
      }
    } catch (err) {
      // Read failure on idempotency check shouldn't block — log and proceed.
      // eslint-disable-next-line no-console
      console.warn("[events] idempotency check failed:", err);
    }

    // ---- Download images (PNG/JPG) and extract PDF page 1 ----
    const { images, primary, downloadFailures } = await collectImages(
      files,
      null,
    );

    // ---- Classify ----
    let classifier: ClassifierResult;
    try {
      classifier = await classifyExpense({ text, images });
    } catch (err) {
      if (err instanceof LLMCallFailed || err instanceof ClassifierParseError) {
        const reason =
          err instanceof LLMCallFailed
            ? `LLM call failed: ${err.message}`
            : `Classifier output unparseable: ${err.message}`;
        const id = await routeToManualReview({
          client,
          config,
          sourceTs,
          channelId: config.EXPENSES_CHANNEL_ID,
          userId,
          text,
          primary,
          reason,
        });
        // Emit LLM_FAILED specifically for genuine classifier failures so
        // future grep on LLM-call health is meaningful.
        if (id) {
          await safeAudit({
            tracking_id: id,
            actor_user_id: "system",
            event_type: AUDIT_EVENTS.LLM_FAILED,
            details: { reason, kind: err.constructor.name },
          });
        }
        return;
      }
      throw err;
    }

    // is_expense:false → silent no-op (PLAN.md §14)
    if (!classifier.is_expense) return;

    // No usable items (defensive) → manual review
    if (!classifier.items || classifier.items.length === 0) {
      await routeToManualReview({
        client,
        config,
        sourceTs,
        channelId: config.EXPENSES_CHANNEL_ID,
        userId,
        text,
        primary,
        reason: "Classifier returned is_expense:true but no items",
      });
      return;
    }

    // ---- Per-item loop (Phase 1.4: multi-expense splitting) ----
    // Each item becomes its own ticket with its own tracking_id, route
    // resolution, approval row, and DM. Confidence is per-classification
    // (single LLM call), so a low confidence routes ALL items to manual
    // review uniformly.
    const requesterName = await fetchUserName(client, userId);
    const outcomes: ItemOutcome[] = [];
    const allTrackingIds: string[] = [];

    for (let itemIdx = 0; itemIdx < classifier.items.length; itemIdx++) {
      const item = classifier.items[itemIdx]!;
      const outcome = await processOneItem({
        client,
        config,
        sourceTs,
        userId,
        requesterName,
        text,
        primary,
        item,
        classifier,
        downloadFailures,
        itemIdx,
        // siblings filled in once the loop's done so each item knows the
        // others. We patch outcomes[i].sibling refs after the loop.
      });
      outcomes.push(outcome);
      if (outcome.trackingId) allTrackingIds.push(outcome.trackingId);
    }

    // Cross-link siblings in the audit trail so each ticket can be traced
    // back to the original multi-item submission.
    if (allTrackingIds.length > 1) {
      for (const tid of allTrackingIds) {
        await safeAudit({
          tracking_id: tid,
          actor_user_id: "system",
          event_type: AUDIT_EVENTS.LLM_CLASSIFIED,
          details: {
            siblings: allTrackingIds.filter((s) => s !== tid),
            total_items: classifier.items.length,
          },
        });
      }
    }

    // ---- Single thread ack summarising every item ----
    if (outcomes.length === 0) return;
    try {
      await ackInThread(
        client,
        config.EXPENSES_CHANNEL_ID,
        sourceTs,
        formatMultiItemAck(outcomes),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[events] thread ack failed:", err);
      // Continue — ack is nice-to-have, the DMs are the load-bearing
      // notifications.
    }
  };
}

interface ProcessOneItemArgs {
  client: WebClient;
  config: Config;
  sourceTs: string;
  userId: string;
  requesterName: string;
  text: string;
  primary: SlackFilePartial | null;
  item: ClassifierItem;
  classifier: ClassifierResult;
  downloadFailures: string[];
  itemIdx: number;
}

/**
 * Process a single classified item: resolve its route, allocate a tracking
 * id, write the ticket row, audit, DM the approver, append the approval
 * row, run CLASSIFIED + FIRST_DM_SENT through the state machine. On any
 * recoverable failure (no route, DM failure, etc.) the item gets a
 * MANUAL_REVIEW ticket so the financial manager has visibility.
 */
async function processOneItem(
  args: ProcessOneItemArgs,
): Promise<ItemOutcome> {
  const {
    client,
    config,
    sourceTs,
    userId,
    requesterName,
    text,
    primary,
    item,
    classifier,
    downloadFailures,
    itemIdx,
  } = args;

  // Confidence gate (per-classification, applied per-item so each item gets
  // its own MANUAL_REVIEW ticket when the classifier wasn't sure).
  if (classifier.confidence < 0.7) {
    const reason = `Classifier confidence ${classifier.confidence.toFixed(2)} below 0.7`;
    const id = await routeToManualReview({
      client,
      config,
      sourceTs,
      channelId: config.EXPENSES_CHANNEL_ID,
      userId,
      text,
      primary,
      reason,
      classifierItem: item,
      confidence: classifier.confidence,
    });
    return { kind: "manual", trackingId: id, reason, item };
  }

  // Resolve route.
  let routes;
  try {
    routes = getCachedRoutes();
  } catch {
    const reason = "Routes cache not loaded";
    const id = await routeToManualReview({
      client,
      config,
      sourceTs,
      channelId: config.EXPENSES_CHANNEL_ID,
      userId,
      text,
      primary,
      reason,
      classifierItem: item,
      confidence: classifier.confidence,
    });
    return { kind: "manual", trackingId: id, reason, item };
  }

  const route = resolveRoute(routes, item.amount, item.currency, item.category);
  if (!route) {
    const reason = `No matching route for ${item.currency} ${item.amount} (${item.category})`;
    const id = await routeToManualReview({
      client,
      config,
      sourceTs,
      channelId: config.EXPENSES_CHANNEL_ID,
      userId,
      text,
      primary,
      reason,
      classifierItem: item,
      confidence: classifier.confidence,
    });
    return { kind: "manual", trackingId: id, reason, item };
  }

  // First approver of the chain — multi-step routing (Phase 1.5) handles
  // the rest of the chain after each Approve.
  const approverId = route.approvers[0];
  if (!approverId) {
    const reason = `Route ${route.route_id} has no approvers`;
    const id = await routeToManualReview({
      client,
      config,
      sourceTs,
      channelId: config.EXPENSES_CHANNEL_ID,
      userId,
      text,
      primary,
      reason,
      classifierItem: item,
      confidence: classifier.confidence,
    });
    return { kind: "manual", trackingId: id, reason, item };
  }

  const trackingId = await generateUniqueTrackingId();
  if (!trackingId) {
    const reason = "Failed to allocate unique tracking ID after 3 attempts";
    const id = await routeToManualReview({
      client,
      config,
      sourceTs,
      channelId: config.EXPENSES_CHANNEL_ID,
      userId,
      text,
      primary,
      reason,
      classifierItem: item,
      confidence: classifier.confidence,
    });
    return { kind: "manual", trackingId: id, reason, item };
  }

  const nowIso = new Date().toISOString();
  const ticket: Ticket = {
    tracking_id: trackingId,
    created_at: nowIso,
    source_message_ts: sourceTs,
    source_channel_id: config.EXPENSES_CHANNEL_ID,
    requester_user_id: userId,
    requester_name: requesterName,
    description: item.description,
    category: item.category,
    amount: item.amount,
    currency: item.currency,
    receipt_file_id: primary?.id ?? "",
    receipt_file_url: primary?.url_private ?? "",
    status: "SUBMITTED",
    route_id: route.route_id,
    current_step: 1,
    current_approver_user_id: approverId,
    payment_confirmation_file_id: null,
    updated_at: nowIso,
    row_version: 1,
  };

  try {
    await appendTicket(ticket);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[events] appendTicket failed:", err);
    // The sheet isn't writable; we can't even record this for manual review.
    return {
      kind: "manual",
      trackingId: null,
      reason: "Sheet not writable",
      item,
    };
  }

  await safeAudit({
    tracking_id: trackingId,
    actor_user_id: userId,
    event_type: AUDIT_EVENTS.TICKET_CREATED,
    details: {
      route_id: route.route_id,
      amount: item.amount,
      currency: item.currency,
      category: item.category,
      confidence: classifier.confidence,
      item_index: itemIdx,
      total_items: classifier.items.length,
    },
  });

  await safeAudit({
    tracking_id: trackingId,
    actor_user_id: "system",
    event_type: AUDIT_EVENTS.LLM_CLASSIFIED,
    details: {
      confidence: classifier.confidence,
      items_count: classifier.items.length,
      notes: classifier.notes,
      item,
      item_index: itemIdx,
    },
  });

  if (downloadFailures.length > 0) {
    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: "system",
      event_type: AUDIT_EVENTS.RECEIPT_PARSED,
      details: {
        warning:
          "image acquisition failure(s) — classifier ran with available inputs",
        failures: downloadFailures,
      },
    });
  }

  // CLASSIFIED transition. High-confidence stays in SUBMITTED, so we only
  // emit a STATE_TRANSITION row when the status actually changes — the
  // LLM_CLASSIFIED audit row above already records the classification
  // outcome, so a same-status STATE_TRANSITION is dead weight.
  const classifiedResult = transition(ticket, {
    type: "CLASSIFIED",
    confidence: classifier.confidence,
  });
  if (classifiedResult.ok && classifiedResult.next !== ticket.status) {
    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: "system",
      event_type: AUDIT_EVENTS.STATE_TRANSITION,
      details: {
        event: "CLASSIFIED",
        from: ticket.status,
        to: classifiedResult.next,
      },
    });
  }

  // DM the approver.
  let dm: { channel: string; ts: string };
  try {
    const { blocks, fallbackText } = approverDmBlocks(ticket);
    dm = await dmUser(client, approverId, blocks, fallbackText);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[events] approver DM failed:", err);
    const reason = `Failed to DM approver <@${approverId}>: ${(err as Error).message}`;
    await escalateToManualReview({
      client,
      config,
      ticket,
      reason,
      fromStatus: ticket.status,
    });
    return {
      kind: "manual",
      trackingId,
      reason: `DM to <@${approverId}> failed`,
      item,
    };
  }

  // Append the approval row.
  const approverName = await fetchUserName(client, approverId);
  try {
    await appendApproval({
      approval_id: uuidv4(),
      tracking_id: trackingId,
      step_number: 1,
      approver_user_id: approverId,
      approver_name: approverName,
      decision: "PENDING",
      decided_at: null,
      comment: "",
      delegated_to_user_id: null,
      dm_channel_id: dm.channel,
      message_ts: dm.ts,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[events] appendApproval failed:", err);
    await escalateToManualReview({
      client,
      config,
      ticket,
      reason: `Approval row could not be written for step 1: ${(err as Error).message}`,
      fromStatus: ticket.status,
    });
    return {
      kind: "manual",
      trackingId,
      reason: "Could not append approval row",
      item,
    };
  }

  // FIRST_DM_SENT transition.
  const firstDmResult = transition(ticket, { type: "FIRST_DM_SENT" });
  if (firstDmResult.ok) {
    try {
      await updateTicket(trackingId, ticket.row_version, {
        status: firstDmResult.next,
      });
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: "system",
        event_type: AUDIT_EVENTS.STATE_TRANSITION,
        details: {
          event: "FIRST_DM_SENT",
          from: "SUBMITTED",
          to: firstDmResult.next,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[events] updateTicket(AWAITING_APPROVAL) failed:",
        err,
      );
    }
  }

  await postFeedLine(
    client,
    config,
    `:inbox_tray: New: \`${trackingId}\` from <@${userId}> — ${item.currency} ${formatAmount(item.amount)} (${item.category}) → <@${approverId}>`,
  );

  return {
    kind: "ok",
    trackingId,
    approverId,
    routeId: route.route_id,
    item,
  };
}

/** Wire up the message handler on a Bolt App instance. */
export function registerMessageHandler(app: App, deps: HandlerDeps): void {
  app.message(makeMessageHandler(deps));
}

// ---------- helpers ----------

interface EscalateArgs {
  client: WebClient;
  config: Config;
  ticket: Ticket;
  reason: string;
  fromStatus: Status;
}

/**
 * Push a ticket already in the sheet to MANUAL_REVIEW via the state machine
 * (PLAN.md §4 #10: every status mutation must go through transition()). Used
 * when a recoverable failure leaves a ticket in a state that can't proceed
 * via the happy path — e.g. DM rejected, route deleted, approval row write
 * failed. Sends the configured side effects (FM DM with the reason) and
 * audits the transition with the canonical event name. Errors during the
 * recovery path itself are logged; we don't recurse.
 */
export async function escalateToManualReview(
  args: EscalateArgs,
): Promise<void> {
  const { client, config, ticket, reason, fromStatus } = args;
  const result = transition(ticket, {
    type: "ESCALATE_TO_MANUAL_REVIEW",
    reason,
  });
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.error(
      `[events] escalateToManualReview illegal: ${result.error}`,
    );
    return;
  }
  let updated: Ticket;
  try {
    updated = await updateTicket(ticket.tracking_id, ticket.row_version, {
      status: result.next,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[events] escalateToManualReview updateTicket failed:",
      err,
    );
    return;
  }
  await safeAudit({
    tracking_id: ticket.tracking_id,
    actor_user_id: "system",
    event_type: AUDIT_EVENTS.STATE_TRANSITION,
    details: {
      event: "ESCALATE_TO_MANUAL_REVIEW",
      from: fromStatus,
      to: result.next,
      reason,
    },
  });
  // Side effect: DM the FM with the reason.
  for (const effect of result.sideEffects) {
    if (effect.type !== "DM_FINANCIAL_MANAGER_MANUAL_REVIEW") continue;
    try {
      const { blocks, fallbackText } = manualReviewDmBlocks(
        updated,
        effect.reason,
      );
      await dmUser(
        client,
        config.FINANCIAL_MANAGER_USER_ID,
        blocks,
        fallbackText,
      );
    } catch (dmErr) {
      // eslint-disable-next-line no-console
      console.error(
        "[events] escalate manual-review DM failed:",
        dmErr,
      );
    }
  }
}

// ---------- payment-proof watcher (relocated from interactivity.ts) ----------

interface PaymentProofFile {
  id?: string;
  permalink?: string;
  url_private?: string;
}

interface PaymentProofMessage {
  channel?: string;
  user?: string;
  files?: PaymentProofFile[];
  ts?: string;
  subtype?: string;
}

/**
 * Should the FM-DM file_share watcher try to claim this message? Pure-ish
 * predicate so the dispatcher in makeMessageHandler can branch without
 * duplicating logic.
 */
function looksLikePaymentProof(
  msg: PaymentProofMessage,
  fmUserId: string,
): boolean {
  if (msg.subtype !== "file_share") return false;
  if (!msg.channel || !msg.user) return false;
  if (msg.user !== fmUserId) return false;
  if (!msg.files || msg.files.length === 0) return false;
  return true;
}

/**
 * Match a file_share from the financial manager to an AWAITING_PAYMENT
 * ticket via its sentinel approval row, then run PAYMENT_CONFIRMED through
 * the state machine, mark the sentinel as approved, post the proof in the
 * source thread, and emit the feed line. Owner of the entire payment
 * confirmation flow.
 *
 * Lives in events.ts so there's one Bolt `app.message(...)` registration in
 * the codebase — see PLAN.md / NEXT.md note about consolidating dispatch.
 */
async function processPaymentProofFromFile(args: {
  client: WebClient;
  config: Config;
  message: PaymentProofMessage;
}): Promise<void> {
  const { client, config, message } = args;
  const file = (message.files ?? [])[0];
  if (!file?.id) return;

  let candidates: Ticket[];
  try {
    candidates = await listNonTerminalTickets();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[events] listNonTerminalTickets failed:", err);
    return;
  }
  const awaiting = candidates.filter(
    (t) => t.status === "AWAITING_PAYMENT",
  );
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
        a.dm_channel_id === message.channel,
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
    console.warn(`[events] PAYMENT_CONFIRMED illegal: ${result.error}`);
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
    console.error("[events] updateTicket(PAID) failed:", err);
    return;
  }

  await safeAudit({
    tracking_id: ticket.tracking_id,
    actor_user_id: message.user!,
    event_type: AUDIT_EVENTS.PAYMENT_CONFIRMED,
    details: { file_id: file.id, permalink: file.permalink },
  });
  await safeAudit({
    tracking_id: ticket.tracking_id,
    actor_user_id: message.user!,
    event_type: AUDIT_EVENTS.STATE_TRANSITION,
    details: {
      event: "PAYMENT_CONFIRMED",
      from: ticket.status,
      to: result.next,
    },
  });

  // Close the sentinel approval row (idempotent on retry).
  try {
    await updateApprovalDecision(matched.sentinel.approval_id, {
      decision: "APPROVED",
      decided_at: new Date().toISOString(),
      comment: "payment confirmed",
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[events] sentinel approval close failed:", err);
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
      "[events] forwarding payment proof to thread failed:",
      err,
    );
  }

  await postFeedLine(
    client,
    config,
    `:dollar: Paid: \`${updated.tracking_id}\` (proof attached)`,
  );
}

interface ManualReviewArgs {
  client: WebClient;
  config: Config;
  sourceTs: string;
  channelId: string;
  userId: string;
  text: string;
  primary: SlackFilePartial | null;
  reason: string;
  classifierItem?: ClassifierItem;
  confidence?: number;
}

async function routeToManualReview(
  args: ManualReviewArgs,
): Promise<string | null> {
  const { client, config, sourceTs, channelId, userId, primary, reason } = args;
  const trackingId = await generateUniqueTrackingId();
  if (!trackingId) {
    // eslint-disable-next-line no-console
    console.error(
      "[events] manual-review path: failed to allocate tracking ID; aborting.",
    );
    return null;
  }

  const requesterName = await fetchUserName(client, userId);
  const nowIso = new Date().toISOString();
  const item = args.classifierItem;

  const ticket: Ticket = {
    tracking_id: trackingId,
    created_at: nowIso,
    source_message_ts: sourceTs,
    source_channel_id: channelId,
    requester_user_id: userId,
    requester_name: requesterName,
    description: item?.description ?? "(unclassified — manual review)",
    category: item?.category ?? "other",
    amount: item?.amount ?? 0,
    // NGN is the operating currency for this workspace; default in if the
    // classifier didn't pull one. Per user preference (overrides audit §11
    // suggestion) — see memory/feedback_currency_default.md.
    currency: item?.currency ?? "NGN",
    receipt_file_id: primary?.id ?? "",
    receipt_file_url: primary?.url_private ?? "",
    status: "MANUAL_REVIEW",
    route_id: "",
    current_step: 0,
    current_approver_user_id: "",
    payment_confirmation_file_id: null,
    updated_at: nowIso,
    row_version: 1,
  };

  try {
    await appendTicket(ticket);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[events] manual-review appendTicket failed:", err);
    return null;
  }

  await safeAudit({
    tracking_id: trackingId,
    actor_user_id: "system",
    event_type: AUDIT_EVENTS.TICKET_CREATED,
    details: { reason, status: "MANUAL_REVIEW", confidence: args.confidence },
  });
  // Generic umbrella event — distinct from LLM_FAILED, which is emitted by
  // the caller iff the reason is genuinely an LLM failure (LLMCallFailed /
  // ClassifierParseError). "No matching route", "no approvers", "tracking
  // ID collision", etc. produce only MANUAL_REVIEW_OPENED.
  await safeAudit({
    tracking_id: trackingId,
    actor_user_id: "system",
    event_type: AUDIT_EVENTS.MANUAL_REVIEW_OPENED,
    details: { reason },
  });

  try {
    const { blocks, fallbackText } = manualReviewDmBlocks(ticket, reason);
    await dmUser(client, config.FINANCIAL_MANAGER_USER_ID, blocks, fallbackText);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[events] manual-review DM failed:", err);
  }

  await postFeedLine(
    client,
    config,
    `:mag: Manual review: \`${trackingId}\` — ${reason}`,
  );

  return trackingId;
}

