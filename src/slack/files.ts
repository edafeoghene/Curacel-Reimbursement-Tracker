// Auth'd Slack file download.
//
// Slack's `url_private` requires a Bearer token (the bot token). The download
// itself is mime-agnostic; the helpers below classify a file as a supported
// image (PNG/JPG) or a PDF (Phase 1.1+: page 1 is extracted and converted to
// PNG by `src/llm/pdf.ts` so the classifier can use it as a vision input).

const MAX_BYTES = 20 * 1024 * 1024; // 20MB — Slack's default file limit

const SUPPORTED_MIMES = new Set(["image/png", "image/jpeg", "image/jpg"]);
const SUPPORTED_FILETYPES = new Set(["png", "jpg", "jpeg"]);

export class SlackFileTooLargeError extends Error {
  constructor(
    public readonly size: number,
    public readonly limit: number = MAX_BYTES,
  ) {
    super(`Slack file exceeds ${limit} bytes (got ${size})`);
    this.name = "SlackFileTooLargeError";
  }
}

export class SlackFileDownloadFailed extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SlackFileDownloadFailed";
  }
}

/**
 * Download a Slack-hosted file. The caller is responsible for picking only
 * URLs they consider safe and trusted (from a Slack event payload).
 */
export async function downloadSlackFile(
  urlPrivate: string,
): Promise<{ buffer: Buffer; mime: string; size: number }> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new SlackFileDownloadFailed(
      "SLACK_BOT_TOKEN is not set; cannot download Slack files.",
    );
  }

  const res = await fetch(urlPrivate, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new SlackFileDownloadFailed(
      `Slack file download returned non-2xx (${res.status} ${res.statusText})`,
      res.status,
    );
  }

  // Pre-check Content-Length so we can reject huge files before buffering.
  const lenHeader = res.headers.get("content-length");
  if (lenHeader) {
    const declared = Number(lenHeader);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      throw new SlackFileTooLargeError(declared);
    }
  }

  const arrayBuf = await res.arrayBuffer();
  if (arrayBuf.byteLength > MAX_BYTES) {
    throw new SlackFileTooLargeError(arrayBuf.byteLength);
  }

  const buffer = Buffer.from(arrayBuf);
  const mime = res.headers.get("content-type") ?? "application/octet-stream";
  return { buffer, mime, size: buffer.length };
}

/**
 * True iff the file is a PNG or JPG that the classifier vision pass can
 * accept. PDFs and others return false in Phase 1.0.
 */
export function isSupportedImage(file: {
  mimetype?: string;
  filetype?: string;
}): boolean {
  const mt = (file.mimetype ?? "").toLowerCase();
  if (mt && SUPPORTED_MIMES.has(mt)) return true;
  const ft = (file.filetype ?? "").toLowerCase();
  if (ft && SUPPORTED_FILETYPES.has(ft)) return true;
  return false;
}

/**
 * True iff the file is specifically a PDF (so the handler can warn in audit
 * but skip it). Kept as a small helper to avoid scattering string checks.
 */
export function isPdf(file: {
  mimetype?: string;
  filetype?: string;
}): boolean {
  if ((file.mimetype ?? "").toLowerCase() === "application/pdf") return true;
  if ((file.filetype ?? "").toLowerCase() === "pdf") return true;
  return false;
}
