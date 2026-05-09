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
import { appendApproval } from "../sheets/approvals.js";
import { appendAuditLog } from "../sheets/audit.js";
import {
  appendTicket,
  getTicketBySourceMessageTs,
  getTicketByTrackingId,
  updateTicket,
} from "../sheets/tickets.js";
import { resolveRoute } from "../state/routing.js";
import { transition } from "../state/machine.js";
import { getCachedRoutes } from "../sheets/routes.js";
import {
  AUDIT_EVENTS,
  type ClassifierImage,
  type ClassifierItem,
  type ClassifierResult,
  type Ticket,
} from "../types.js";
import { v4 as uuidv4 } from "uuid";

import { downloadSlackFile, isPdf, isSupportedImage } from "./files.js";
import { extractPdfPage1AsImage } from "../llm/pdf.js";
import { ackInThread, dmUser, postEphemeral } from "./messaging.js";
import { approverDmBlocks, manualReviewDmBlocks } from "./views.js";

// Sentinel step_number for the financial-manager "payment" approval row.
// See Wave 2 final report — we cannot add fields to Ticket so the DM coords
// for the Mark-as-Paid message ride on an approval row.
export const PAYMENT_STEP_SENTINEL = 99;

// Per-process cache for users.info lookups.
const userNameCache = new Map<string, string>();

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

export async function fetchUserName(
  client: WebClient,
  userId: string,
): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;
  try {
    const res = await client.users.info({ user: userId });
    const name =
      res.user?.profile?.display_name ||
      res.user?.profile?.real_name ||
      res.user?.real_name ||
      res.user?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
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
        await routeToManualReview({
          client,
          config,
          sourceTs,
          channelId: config.EXPENSES_CHANNEL_ID,
          userId,
          text,
          primary,
          reason:
            err instanceof LLMCallFailed
              ? `LLM call failed: ${err.message}`
              : `Classifier output unparseable: ${err.message}`,
        });
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

    // Phase 1.0: take items[0]; warn in audit if there were more.
    const item = classifier.items[0]!;
    const droppedItems = classifier.items.slice(1);

    // Confidence gate → manual review (still uses state machine via stub flow).
    if (classifier.confidence < 0.7) {
      await routeToManualReview({
        client,
        config,
        sourceTs,
        channelId: config.EXPENSES_CHANNEL_ID,
        userId,
        text,
        primary,
        reason: `Classifier confidence ${classifier.confidence.toFixed(2)} below 0.7`,
        classifierItem: item,
        confidence: classifier.confidence,
      });
      return;
    }

    // ---- Resolve route ----
    let routes;
    try {
      routes = getCachedRoutes();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[events] routes cache not loaded:", err);
      await routeToManualReview({
        client,
        config,
        sourceTs,
        channelId: config.EXPENSES_CHANNEL_ID,
        userId,
        text,
        primary,
        reason: "Routes cache not loaded",
        classifierItem: item,
        confidence: classifier.confidence,
      });
      return;
    }

    const route = resolveRoute(routes, item.amount, item.currency, item.category);
    if (!route) {
      await routeToManualReview({
        client,
        config,
        sourceTs,
        channelId: config.EXPENSES_CHANNEL_ID,
        userId,
        text,
        primary,
        reason: `No matching route for ${item.currency} ${item.amount} (${item.category})`,
        classifierItem: item,
        confidence: classifier.confidence,
      });
      return;
    }

    // Phase 1.0 single-step routing — first approver only.
    const approverId = route.approvers[0];
    if (!approverId) {
      await routeToManualReview({
        client,
        config,
        sourceTs,
        channelId: config.EXPENSES_CHANNEL_ID,
        userId,
        text,
        primary,
        reason: `Route ${route.route_id} has no approvers`,
        classifierItem: item,
        confidence: classifier.confidence,
      });
      return;
    }

    // ---- Allocate tracking ID ----
    const trackingId = await generateUniqueTrackingId();
    if (!trackingId) {
      await routeToManualReview({
        client,
        config,
        sourceTs,
        channelId: config.EXPENSES_CHANNEL_ID,
        userId,
        text,
        primary,
        reason: "Failed to allocate unique tracking ID after 3 attempts",
        classifierItem: item,
        confidence: classifier.confidence,
      });
      return;
    }

    // ---- Build & write ticket row ----
    const requesterName = await fetchUserName(client, userId);
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
      // Can't even log a manual-review ticket because the sheet isn't writable.
      return;
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
      },
    });

    // Audit the LLM classification result.
    await safeAudit({
      tracking_id: trackingId,
      actor_user_id: "system",
      event_type: AUDIT_EVENTS.LLM_CLASSIFIED,
      details: {
        confidence: classifier.confidence,
        items_count: classifier.items.length,
        notes: classifier.notes,
        primary_item: item,
        dropped_items: droppedItems.length > 0 ? droppedItems : undefined,
      },
    });

    if (downloadFailures.length > 0) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: "system",
        event_type: AUDIT_EVENTS.RECEIPT_PARSED,
        details: {
          warning: "image acquisition failure(s) — classifier ran with available inputs",
          failures: downloadFailures,
        },
      });
    }
    if (droppedItems.length > 0) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: "system",
        event_type: AUDIT_EVENTS.RECEIPT_PARSED,
        details: {
          warning: `Classifier returned ${classifier.items.length} items; Phase 1.0 took items[0] only.`,
          dropped_items: droppedItems,
        },
      });
    }

    // ---- State machine: CLASSIFIED ----
    const classifiedResult = transition(ticket, {
      type: "CLASSIFIED",
      confidence: classifier.confidence,
    });
    if (classifiedResult.ok) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: "system",
        event_type: AUDIT_EVENTS.STATE_TRANSITION,
        details: {
          event: "CLASSIFIED",
          from: "SUBMITTED",
          to: classifiedResult.next,
        },
      });
    }

    // ---- Thread ack ----
    try {
      await ackInThread(
        client,
        config.EXPENSES_CHANNEL_ID,
        sourceTs,
        `Logged as \`${trackingId}\`. Routing to <@${approverId}> for approval.`,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[events] thread ack failed:", err);
      // Continue — ack is nice-to-have, the DM is the load-bearing notification.
    }

    // ---- DM the approver ----
    let dm: { channel: string; ts: string };
    try {
      const { blocks, fallbackText } = approverDmBlocks(ticket);
      dm = await dmUser(client, approverId, blocks, fallbackText);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[events] approver DM failed:", err);
      // Roll the ticket into MANUAL_REVIEW; financial manager handles.
      try {
        const updated = await updateTicket(trackingId, ticket.row_version, {
          status: "MANUAL_REVIEW",
        });
        await safeAudit({
          tracking_id: trackingId,
          actor_user_id: "system",
          event_type: AUDIT_EVENTS.STATE_TRANSITION,
          details: {
            event: "DM_FAILED",
            from: "SUBMITTED",
            to: "MANUAL_REVIEW",
            error: (err as Error).message,
          },
        });
        try {
          const { blocks, fallbackText } = manualReviewDmBlocks(
            updated,
            `Failed to DM approver <@${approverId}>: ${(err as Error).message}`,
          );
          await dmUser(client, config.FINANCIAL_MANAGER_USER_ID, blocks, fallbackText);
        } catch (dmErr) {
          // eslint-disable-next-line no-console
          console.error("[events] manual-review DM failed:", dmErr);
        }
      } catch (upErr) {
        // eslint-disable-next-line no-console
        console.error("[events] failed to roll ticket to MANUAL_REVIEW:", upErr);
      }
      return;
    }

    // ---- Append approval row ----
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
      // The DM was sent but we can't track it. Manual review.
      try {
        await updateTicket(trackingId, ticket.row_version, {
          status: "MANUAL_REVIEW",
        });
      } catch (upErr) {
        // eslint-disable-next-line no-console
        console.error("[events] rollback to MANUAL_REVIEW failed:", upErr);
      }
      return;
    }

    // ---- State machine: FIRST_DM_SENT → AWAITING_APPROVAL ----
    const firstDmResult = transition(ticket, { type: "FIRST_DM_SENT" });
    if (!firstDmResult.ok) {
      // eslint-disable-next-line no-console
      console.error("[events] FIRST_DM_SENT illegal:", firstDmResult.error);
      return;
    }

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
      console.error("[events] updateTicket(AWAITING_APPROVAL) failed:", err);
    }
  };
}

/** Wire up the message handler on a Bolt App instance. */
export function registerMessageHandler(app: App, deps: HandlerDeps): void {
  app.message(makeMessageHandler(deps));
}

// ---------- helpers ----------

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

async function routeToManualReview(args: ManualReviewArgs): Promise<void> {
  const { client, config, sourceTs, channelId, userId, primary, reason } = args;
  const trackingId = await generateUniqueTrackingId();
  if (!trackingId) {
    // eslint-disable-next-line no-console
    console.error(
      "[events] manual-review path: failed to allocate tracking ID; aborting.",
    );
    return;
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
    return;
  }

  await safeAudit({
    tracking_id: trackingId,
    actor_user_id: "system",
    event_type: AUDIT_EVENTS.TICKET_CREATED,
    details: { reason, status: "MANUAL_REVIEW", confidence: args.confidence },
  });
  await safeAudit({
    tracking_id: trackingId,
    actor_user_id: "system",
    event_type: AUDIT_EVENTS.LLM_FAILED,
    details: { reason },
  });

  try {
    const { blocks, fallbackText } = manualReviewDmBlocks(ticket, reason);
    await dmUser(client, config.FINANCIAL_MANAGER_USER_ID, blocks, fallbackText);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[events] manual-review DM failed:", err);
  }
}

interface AuditPayload {
  tracking_id: string;
  actor_user_id: string;
  event_type: string;
  details: unknown;
}

async function safeAudit(p: AuditPayload): Promise<void> {
  try {
    await appendAuditLog({
      log_id: uuidv4(),
      tracking_id: p.tracking_id,
      timestamp: new Date().toISOString(),
      actor_user_id: p.actor_user_id,
      event_type: p.event_type,
      details_json: JSON.stringify(p.details ?? {}),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[audit] append failed for ${p.event_type}:`, err);
  }
}

// Re-export the audit helper so interactivity.ts doesn't have to repeat the
// `appendAuditLog` boilerplate.
export { safeAudit };
