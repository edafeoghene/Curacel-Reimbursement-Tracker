"use client";

import { useState } from "react";

interface Props {
  src: string;
  alt: string;
  /**
   * Inline-style aspect ratio reserved before the image loads. Defaults
   * to 3 / 4 (portrait, typical for receipt photos). Prevents the
   * right-side column from reflowing when the image arrives, and keeps
   * a meaningful empty state if the file 404s.
   */
  aspectRatio?: string;
}

/**
 * Receipt / payment-proof preview with an explicit aspect-ratio
 * placeholder (kills layout shift) and an onError fallback (kills the
 * broken-image icon for non-image files like PDFs). On error we render
 * a small "Couldn't preview — open in new tab" card pointing at the
 * same src; the parent already renders an "Open" link in its header,
 * but having a fallback action right where the image was makes the
 * empty state actionable.
 *
 * Plain <img> on purpose: the proxy streams arbitrary Slack mime types
 * and we don't want Next.js's optimizer touching them. The
 * @next/next/no-img-element lint warning is suppressed.
 */
export function FilePreview({ src, alt, aspectRatio = "3 / 4" }: Props) {
  const [errored, setErrored] = useState(false);

  if (errored) {
    return (
      <div
        style={{ aspectRatio }}
        className="mt-3 flex w-full flex-col items-center justify-center gap-2 rounded border border-dashed border-zinc-200 bg-zinc-50 p-4 text-center text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
      >
        <p>Couldn&apos;t preview this file inline.</p>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="text-zinc-900 underline underline-offset-4 dark:text-zinc-50"
        >
          Open in a new tab →
        </a>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      style={{ aspectRatio }}
      onError={() => setErrored(true)}
      className="mt-3 w-full rounded border border-zinc-100 bg-zinc-50 object-contain dark:border-zinc-800 dark:bg-zinc-900"
    />
  );
}
