import Link from "next/link";
import { notFound } from "next/navigation";

import {
  type Approval,
  type AuditLogEntry,
  type Status,
  type Ticket,
} from "@curacel/shared";

import { listApprovalsForTicket } from "@/lib/sheets/approvals";
import { listAuditEntriesForTicket } from "@/lib/sheets/audit";
import { getTicketByTrackingId } from "@/lib/sheets/tickets";

export const revalidate = 30;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ trackingId: string }>;
}) {
  const { trackingId } = await params;
  return { title: `${trackingId} — Curacel Expense Dashboard` };
}

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ trackingId: string }>;
}) {
  const { trackingId } = await params;

  const [ticket, approvals, auditEntries] = await Promise.all([
    getTicketByTrackingId(trackingId),
    listApprovalsForTicket(trackingId),
    listAuditEntriesForTicket(trackingId),
  ]);

  if (!ticket) notFound();

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/tickets"
          className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
        >
          ← All tickets
        </Link>
        <div className="mt-2 flex items-baseline gap-3">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{ticket.tracking_id}</h1>
          <StatusBadge status={ticket.status} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <HeaderCard ticket={ticket} />
          <DescriptionCard ticket={ticket} />
          {approvals.length > 0 ? <ApprovalTimeline approvals={approvals} /> : null}
          {auditEntries.length > 0 ? <AuditLog entries={auditEntries} /> : null}
        </div>
        <div className="space-y-6">
          {ticket.receipt_file_id ? (
            <FileCard
              title="Receipt"
              fileId={ticket.receipt_file_id}
            />
          ) : null}
          {ticket.payment_confirmation_file_id ? (
            <FileCard
              title="Payment proof"
              fileId={ticket.payment_confirmation_file_id}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function HeaderCard({ ticket }: { ticket: Ticket }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <Row label="Amount">
          <span className="font-mono">
            {ticket.currency} {ticket.amount.toLocaleString()}
          </span>
        </Row>
        <Row label="Requester">
          {ticket.requester_name}
          <span className="ml-1 font-mono text-xs text-zinc-500">({ticket.requester_user_id})</span>
        </Row>
        <Row label="Category">{ticket.category || "—"}</Row>
        <Row label="Route">
          <span className="font-mono text-xs">{ticket.route_id || "—"}</span>
        </Row>
        <Row label="Current step">
          {ticket.current_step}
          {ticket.current_approver_user_id ? (
            <span className="ml-1 font-mono text-xs text-zinc-500">→ {ticket.current_approver_user_id}</span>
          ) : null}
        </Row>
        <Row label="Created">{formatDateTime(ticket.created_at)}</Row>
        <Row label="Updated">{formatDateTime(ticket.updated_at)}</Row>
        <Row label="Row version">{ticket.row_version}</Row>
      </dl>
    </div>
  );
}

function DescriptionCard({ ticket }: { ticket: Ticket }) {
  if (!ticket.description) return null;
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Description</h2>
      <p className="mt-2 whitespace-pre-wrap text-sm">{ticket.description}</p>
    </div>
  );
}

function ApprovalTimeline({ approvals }: { approvals: Approval[] }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Approval timeline</h2>
      <ol className="mt-4 space-y-4">
        {approvals.map((a) => (
          <li key={a.approval_id} className="flex gap-4">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {a.step_number}
            </div>
            <div className="flex-1 space-y-1 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{a.approver_name || a.approver_user_id}</span>
                <span className="font-mono text-xs text-zinc-500">{a.approver_user_id}</span>
                <DecisionPill decision={a.decision} />
                {a.decided_at ? (
                  <span className="text-xs text-zinc-500">{formatDateTime(a.decided_at)}</span>
                ) : null}
              </div>
              {a.delegated_to_user_id ? (
                <p className="text-xs text-zinc-500">
                  delegated to{" "}
                  <span className="font-mono">{a.delegated_to_user_id}</span>
                </p>
              ) : null}
              {a.comment ? (
                <p className="whitespace-pre-wrap rounded bg-zinc-50 px-2 py-1 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  {a.comment}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function AuditLog({ entries }: { entries: AuditLogEntry[] }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Audit log</h2>
      <ol className="mt-4 space-y-3 text-sm">
        {entries.map((e) => (
          <li key={e.log_id} className="grid grid-cols-[140px_1fr] gap-3">
            <span className="font-mono text-xs text-zinc-500">{formatDateTime(e.timestamp)}</span>
            <div>
              <span className="font-medium">{e.event_type}</span>
              {e.actor_user_id ? (
                <span className="ml-1 font-mono text-xs text-zinc-500">by {e.actor_user_id}</span>
              ) : null}
              {renderDetails(e.details_json)}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function renderDetails(detailsJson: string): React.ReactNode {
  if (!detailsJson) return null;
  try {
    const parsed = JSON.parse(detailsJson);
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
      return (
        <pre className="mt-1 overflow-x-auto rounded bg-zinc-50 px-2 py-1 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    }
    return null;
  } catch {
    // Malformed JSON — show raw so we don't hide data, but in a quiet style.
    return (
      <p className="mt-1 break-all text-xs text-zinc-500">{detailsJson}</p>
    );
  }
}

function FileCard({ title, fileId }: { title: string; fileId: string }) {
  const src = `/api/files/${encodeURIComponent(fileId)}`;
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
        >
          Open
        </a>
      </div>
      {/* Plain <img> is intentional: the proxy returns whatever Slack's
          mimetype is, which for receipts is usually image/png or image/jpeg.
          Non-image files (PDF) will fail to render and the user can click
          "Open" to view in a new tab. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={title}
        className="mt-3 max-h-96 w-full rounded border border-zinc-100 object-contain dark:border-zinc-800"
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const tone = STATUS_TONES[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status}
    </span>
  );
}

function DecisionPill({ decision }: { decision: Approval["decision"] }) {
  const tone = DECISION_TONES[decision];
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {decision}
    </span>
  );
}

const STATUS_TONES: Record<Status, string> = {
  SUBMITTED: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  AWAITING_APPROVAL: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  NEEDS_CLARIFICATION: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  APPROVED: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  AWAITING_PAYMENT: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  PAID: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  REJECTED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  CANCELLED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  MANUAL_REVIEW: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
};

const DECISION_TONES: Record<Approval["decision"], string> = {
  PENDING: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  APPROVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  REJECTED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  CLARIFICATION_REQUESTED: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  DELEGATED: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
};

function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}
