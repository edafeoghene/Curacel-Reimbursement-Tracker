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

async function fetchUserName(
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
 * Best-effort image collection for the classifier. PNG/JPG only; PDFs are
 * skipped with an audit warning per the brief; download failures are logged
 * but do not abort classification (text-only fallback works).
 */
async function collectImages(
  files: SlackFilePartial[] | undefined,
  trackingHintId: string | null,
): Promise<{
  images: ClassifierImage[];
  primary: SlackFilePartial | null;
  pdfFound: boolean;
  downloadFailures: string[];
}> {
  const images: ClassifierImage[] = [];
  const downloadFailures: string[] = [];
  let primary: SlackFilePartial | null = null;
  let pdfFound = false;

  for (const f of files ?? []) {
    if (isPdf(f)) {
      pdfFound = true;
      continue;
    }
    if (!isSupportedImage(f)) continue;
    if (!f.url_private) continue;
    try {
      const dl = await downloadSlackFile(f.url_private);
      images.push({ mime: dl.mime, base64: dl.buffer.toString("base64") });
      if (!primary) primary = f;
    } catch (err) {
      const tag = trackingHintId ?? "(no-id)";
      downloadFailures.push(
        `[${tag}] failed to download ${f.id ?? f.name ?? "<file>"}: ${(err as Error).message}`,
      );
    }
  }

  return { images, primary, pdfFound, downloadFailures };
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
    // ---- Filter: PLAN.md §7 ----
    // Only the source channel.
    const anyMsg = message as unknown as {
      channel?: string;
      subtype?: string;
      bot_id?: string;
      thread_ts?: string;
      ts?: string;
      user?: string;
      text?: string;
      files?: SlackFilePartial[];
    };

    if (anyMsg.channel !== config.EXPENSES_CHANNEL_ID) return;
    if (anyMsg.subtype === "message_changed") return;
    if (anyMsg.subtype === "message_deleted") return;
    if (anyMsg.bot_id) return;
    if (anyMsg.thread_ts && anyMsg.thread_ts !== anyMsg.ts) return;
    if (!anyMsg.user || !anyMsg.ts) return;

    const sourceTs = anyMsg.ts;
    const userId = anyMsg.user;
    const text = anyMsg.text ?? "";
    const files = anyMsg.files ?? [];

    // ---- Pre-classification gate ----
    const hasFiles = files.length > 0;
    const hasAmount = hasParseableAmount(text);
    if (!hasFiles && !hasAmount) {
      try {
        await postEphemeral(
          client,
          config.EXPENSES_CHANNEL_ID,
          userId,
          "Looks like an expense? Please attach a receipt or include the amount.",
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[events] postEphemeral nudge failed:", err);
      }
      return;
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

    // ---- Download images (PNG/JPG); warn on PDF ----
    const { images, primary, pdfFound, downloadFailures } = await collectImages(
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

    if (pdfFound) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: "system",
        event_type: AUDIT_EVENTS.RECEIPT_PARSED,
        details: { warning: "PDF receipt(s) skipped (Phase 1.0 limitation)" },
      });
    }
    if (downloadFailures.length > 0) {
      await safeAudit({
        tracking_id: trackingId,
        actor_user_id: "system",
        event_type: AUDIT_EVENTS.RECEIPT_PARSED,
        details: { warning: "file download failure(s)", failures: downloadFailures },
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
