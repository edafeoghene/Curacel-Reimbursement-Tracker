import Link from "next/link";
import { notFound } from "next/navigation";

import {
  type Approval,
  type Ticket,
} from "@curacel/shared";

import { FilePreview } from "@/components/file-preview";
import { StatusBadge } from "@/components/status-badge";
import { listApprovalsForTicket } from "@/lib/sheets/approvals";
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

  const [ticket, approvals] = await Promise.all([
    getTicketByTrackingId(trackingId),
    listApprovalsForTicket(trackingId),
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

      <div className="space-y-6">
        <HeaderCard ticket={ticket} />
        <DescriptionCard ticket={ticket} />
        {approvals.length > 0 ? <ApprovalTimeline approvals={approvals} /> : null}
        <FilesSection ticket={ticket} />
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
                <p className="whitespace-pre-wrap rounded-md bg-zinc-50 px-2 py-1 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
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

function FilesSection({ ticket }: { ticket: Ticket }) {
  const hasReceipt = Boolean(ticket.receipt_file_id);
  const hasPayment = Boolean(ticket.payment_confirmation_file_id);
  if (!hasReceipt && !hasPayment) return null;

  // Side-by-side when both exist (prevents the page from extending
  // unnecessarily); single column when only one exists so the lone
  // card uses the full row rather than sitting half-empty.
  const cols = hasReceipt && hasPayment ? "md:grid-cols-2" : "md:grid-cols-1";

  return (
    <div className={`grid grid-cols-1 gap-6 ${cols}`}>
      {hasReceipt ? (
        <FileCard
          title="Expense receipt"
          subtitle="Submitted with the original ticket."
          fileId={ticket.receipt_file_id}
        />
      ) : null}
      {hasPayment && ticket.payment_confirmation_file_id ? (
        <FileCard
          title="Payment proof"
          subtitle="Uploaded after Mark as Paid."
          fileId={ticket.payment_confirmation_file_id}
        />
      ) : null}
    </div>
  );
}

function FileCard({
  title,
  subtitle,
  fileId,
}: {
  title: string;
  subtitle: string;
  fileId: string;
}) {
  const src = `/api/files/${encodeURIComponent(fileId)}`;
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>
        </div>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-xs text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
        >
          Open ↗
        </a>
      </div>
      <FilePreview src={src} alt={title} />
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

function DecisionPill({ decision }: { decision: Approval["decision"] }) {
  const tone = DECISION_TONES[decision];
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {decision}
    </span>
  );
}

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
