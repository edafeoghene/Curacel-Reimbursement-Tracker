// Next 16 renamed `middleware.ts` -> `proxy.ts` (file convention deprecated
// in favor of `proxy`). Re-exports NextAuth's `auth()` as the proxy entry —
// the `authorized` callback in /auth.ts decides per-path whether the
// request is allowed.
//
// The matcher excludes /api/auth/* (NextAuth's own callbacks must run
// unauthed) and Next's static asset paths. Everything else passes through
// `authorized`.
export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
