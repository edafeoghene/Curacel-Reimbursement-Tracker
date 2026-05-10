// Slack file proxy primitives. The frontend reuses the bot's
// SLACK_BOT_TOKEN to fetch private file URLs server-side, then streams
// the bytes back to the browser. The bot token is never exposed to the
// client.

const ALLOWED_FILE_URL_PREFIXES = [
  "https://files.slack.com/",
  "https://slack-files.com/",
];

export function isAllowedSlackFileUrl(url: string): boolean {
  return ALLOWED_FILE_URL_PREFIXES.some((p) => url.startsWith(p));
}

interface SlackFilesInfoResponse {
  ok: boolean;
  error?: string;
  file?: {
    id: string;
    url_private?: string;
    url_private_download?: string;
    mimetype?: string;
    name?: string;
    size?: number;
  };
}

/**
 * Look up `file_id` via Slack's files.info API and return the metadata.
 * Returns null if Slack reports `ok: false` or the file is missing —
 * caller decides how to surface (404, etc.).
 */
export async function getSlackFileInfo(fileId: string): Promise<SlackFilesInfoResponse["file"] | null> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN is not set; cannot resolve Slack files.");
  }

  const url = `https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    // Don't cache file metadata — files can be deleted, and a stale
    // url_private cached at the edge would leak after deletion.
    cache: "no-store",
  });
  if (!res.ok) return null;
  const body = (await res.json()) as SlackFilesInfoResponse;
  if (!body.ok || !body.file) return null;
  return body.file;
}

/**
 * Stream a Slack-hosted file. Returns the live `Response` from Slack so
 * the caller can pipe `body` straight into the Next.js Response.
 *
 * Throws if SLACK_BOT_TOKEN is missing or the URL host isn't on the
 * allow-list — defense-in-depth so a malformed Slack response can't
 * trick us into sending the token to a foreign host.
 */
export async function streamSlackFile(urlPrivate: string): Promise<Response> {
  if (!isAllowedSlackFileUrl(urlPrivate)) {
    throw new Error(`Refusing to fetch non-Slack URL: ${urlPrivate}`);
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN is not set; cannot download Slack files.");
  }
  return fetch(urlPrivate, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
