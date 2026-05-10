import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/auth";
import { listAllTickets } from "@/lib/sheets/tickets";
import { getSlackFileInfo, streamSlackFile } from "@/lib/slack/files";

// Slack file proxy. Streams a receipt or payment-proof image back to the
// browser using the bot token server-side. The token never leaves the
// server; the browser sees same-origin /api/files/<id> URLs.
//
// Authorization layers, in order:
//  1. proxy.ts (Next 16 middleware) requires a session for any non-public
//     route. /api/files/* is matched, so unauthed requests are bounced
//     to /login by NextAuth's authorized callback.
//  2. We re-check session here as belt-and-suspenders. If the proxy ever
//     misroutes, this still rejects.
//  3. We require the requested file_id to be referenced by SOME ticket in
//     the sheet (as receipt_file_id or payment_confirmation_file_id).
//     This prevents an authenticated user from proxying arbitrary Slack
//     files the bot has access to — they can only read files the
//     dashboard is meant to surface.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { fileId } = await params;
  if (!fileId) {
    return NextResponse.json({ error: "Missing fileId" }, { status: 400 });
  }

  // Authorization gate: the file must belong to a ticket. O(n) scan over
  // the tickets sheet — acceptable at our scale (~hundreds of rows). If
  // this becomes a hot path we can build an index.
  const tickets = await listAllTickets();
  const referenced = tickets.some(
    (t) => t.receipt_file_id === fileId || t.payment_confirmation_file_id === fileId,
  );
  if (!referenced) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const info = await getSlackFileInfo(fileId);
  const urlPrivate = info?.url_private;
  if (!urlPrivate) {
    return NextResponse.json({ error: "File not available" }, { status: 404 });
  }

  let upstream: Response;
  try {
    upstream = await streamSlackFile(urlPrivate);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `Upstream returned ${upstream.status}` },
      { status: 502 },
    );
  }

  // Stream straight through. Preserve content-type from Slack so <img>
  // and inline PDF viewers work without sniffing.
  const contentType = info.mimetype ?? upstream.headers.get("content-type") ?? "application/octet-stream";
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  // Short browser-side cache: the file content for a given Slack file_id
  // is immutable, but we still want the auth gate to re-evaluate after
  // session expiry. 5 min is the common middle ground.
  headers.set("Cache-Control", "private, max-age=300");
  const safeFilename = sanitizeFilenameForContentDisposition(info.name);
  if (safeFilename) {
    headers.set("Content-Disposition", `inline; filename="${safeFilename}"`);
  }
  return new Response(upstream.body, { status: 200, headers });
}

/**
 * Sanitize a Slack-uploader-supplied filename before embedding it in a
 * Content-Disposition header. Slack file names are uploader-controlled,
 * and a name containing CR / LF could in theory inject a new header
 * (HTTP response splitting). Defense in depth — modern fetch APIs
 * typically reject control chars too, but stripping at the source costs
 * nothing.
 *
 * Strips: ASCII control chars (\x00–\x1f, \x7f), double quotes (break
 * the quoted-string form), backslashes (escape character). Caps at 200
 * chars to keep the header sane.
 */
function sanitizeFilenameForContentDisposition(name: string | undefined | null): string {
  if (!name) return "";
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f"\\]/g, "").slice(0, 200);
}
