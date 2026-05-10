import type { Status } from "@curacel/shared";

import { STATUS_BADGE_CLASSES } from "@/lib/status-palette";

/**
 * The one StatusBadge used everywhere (homepage, queue, detail page).
 * Previously each page rolled its own copy with a duplicated STATUS_TONES
 * table — when one of those tables drifted, the others didn't.
 */
export function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[status]}`}
    >
      {status}
    </span>
  );
}
