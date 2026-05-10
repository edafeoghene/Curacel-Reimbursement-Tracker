// PDF → PNG page-1 extractor for the classifier vision input.
//
// Phase 1.0 / 1.1: extract page 1 only and pass to the classifier as a
// PNG image. PLAN.md §8 documents this as a known limitation — multi-page
// PDFs still only contribute page 1 to the model. The caller (collectImages
// in slack/events.ts) is responsible for logging an audit warning when a
// PDF had more than one page.
//
// Implementation: pdf-to-png-converter wraps pdfjs-dist + @napi-rs/canvas,
// both of which ship pre-built binaries (darwin-arm64, linux-x64-gnu, …).
// No system dependencies (libcairo, etc.) needed for Railway Nixpacks.

import { pdfToPng } from "pdf-to-png-converter";

import type { ClassifierImage } from "@curacel/shared";

export class PdfExtractFailed extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "PdfExtractFailed";
  }
}

/**
 * Render page 1 of a PDF buffer to a PNG and return it as a ClassifierImage
 * (base64-encoded, mime `image/png`). Always asks the renderer for page 1
 * only so multi-page PDFs don't pay the rendering cost for pages we won't
 * use.
 *
 * Multi-page detection is intentionally NOT done here: per PLAN.md §8, page 1
 * only is a known limitation, and detecting page count requires a second
 * pdfjs pass that isn't worth the complexity for an audit-log warning.
 *
 * Throws `PdfExtractFailed` on any rendering error so the caller can fall
 * back to text-only classification with an audit warning.
 */
export async function extractPdfPage1AsImage(
  pdfBuffer: Buffer,
): Promise<ClassifierImage> {
  let pages;
  try {
    pages = await pdfToPng(pdfBuffer, {
      // Only render the first page — saves work on long PDFs.
      pagesToProcess: [1],
      // Scale 2x so small text in receipts is legible to vision.
      viewportScale: 2.0,
    });
  } catch (err) {
    throw new PdfExtractFailed(
      `pdf-to-png-converter failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  if (!pages || pages.length === 0) {
    throw new PdfExtractFailed("PDF contained no renderable pages");
  }

  const page1 = pages[0]!;
  if (!page1.content || page1.content.length === 0) {
    throw new PdfExtractFailed("PDF page 1 rendered to an empty buffer");
  }

  return {
    mime: "image/png",
    base64: page1.content.toString("base64"),
  };
}
