// NextAuth v5 route handler. The actual config lives in /auth.ts at the
// frontend root; this file only re-exports the GET/POST handlers.
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
