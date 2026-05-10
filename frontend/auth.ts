import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import type { GoogleProfile } from "@auth/core/providers/google";

import { decideSignIn, parseAllowlist } from "@/lib/allowlist";

// Public routes — listed once so middleware (`authorized` callback) and
// the rejection page agree. /not-allowed exists for users who passed
// Google OAuth but failed the allowlist gate; /login is the unauthed
// landing page; /api/auth/* is the NextAuth route handler itself.
const PUBLIC_PATHS = new Set(["/login", "/not-allowed"]);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      // The user's Google Cloud project uses GOOGLE_CLIENT_ID /
      // GOOGLE_CLIENT_SECRET (matches frontend/.env.example). Pass them
      // explicitly so we don't depend on Auth.js v5's AUTH_GOOGLE_*
      // auto-inference convention.
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          // hd is a hint, not enforcement — we re-verify in signIn via
          // profile.hd. prompt=select_account always shows the account
          // chooser so users on shared machines don't accidentally sign
          // in as the wrong identity.
          hd: "curacel.ai",
          prompt: "select_account",
        },
      },
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/not-allowed",
  },
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ user, profile }) {
      const decision = decideSignIn({
        email: user.email,
        hd: (profile as GoogleProfile | undefined)?.hd ?? null,
        allowlist: parseAllowlist(process.env.ALLOWED_FM_EMAILS),
      });

      if (decision.allowed) return true;

      // Redirect to a static rejection page rather than the default
      // /api/auth/error?error=AccessDenied so the message is friendly.
      // We deliberately don't leak the *reason* — same page for
      // wrong-domain / wrong-hd / not-on-allowlist so attackers can't
      // enumerate who's on the allowlist.
      return "/not-allowed";
    },
    authorized({ auth: session, request: { nextUrl } }) {
      const isLoggedIn = !!session?.user;
      const path = nextUrl.pathname;
      if (PUBLIC_PATHS.has(path)) return true;
      return isLoggedIn;
    },
  },
});
