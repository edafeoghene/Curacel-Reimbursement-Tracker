// Next 16 renamed `middleware.ts` -> `proxy.ts` (file convention deprecated
// in favor of `proxy`). Re-exports NextAuth's `auth()` as the proxy entry —
// the `authorized` callback in /auth.ts decides per-path whether the
// request is allowed.
//
// The matcher excludes:
//   - /api/auth/*       NextAuth's own callbacks must run unauthed.
//   - /_next/static     Static build output.
//   - /_next/image      Image optimizer (its internal source fetches must
//                       not be redirected to /login or the browser sees
//                       an opaque 400 from the optimizer).
//   - favicon.ico       Browser auto-fetch.
//   - *.png|jpg|...     Anything with a recognised static-asset extension
//                       in /public/. Without this, requests for
//                       /curacel-logo.png etc. are 307'd to /login when
//                       the user has no session, the optimizer can't
//                       follow the redirect, and images fail to load.
//
// Everything else passes through `authorized` in /auth.ts.
export { auth as proxy } from "@/auth";

export const config = {
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon.ico|.+\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|css|js)$).*)",
  ],
};
