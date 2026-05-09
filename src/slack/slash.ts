// Slash command registration — stub for Phase 1.0.
//
// TODO Phase 1.2: register `/expense-resume` (clarification resume).
// TODO Phase 1.6: register `/expense-cancel` (cancellation by requester or
// financial manager).
//
// Phase 1.0 ships no slash commands. This file exists so `index.ts` can call
// `registerSlashCommands(app)` unconditionally and we get a clear hook to
// extend in 1.2 / 1.6 without restructuring the boot path.

import type { App } from "@slack/bolt";

export function registerSlashCommands(_app: App): void {
  // No-op in Phase 1.0. Future phases register here.
}
