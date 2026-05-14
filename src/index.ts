// Boot wiring: dotenv -> config -> Bolt + Express -> sheets bootstrap ->
// reconciliation -> handler registration -> start.
//
// Phase 1.0 spine. PLAN.md §15 module layout, §17 health & operations.

import "dotenv/config";

// @slack/bolt is CommonJS — namespace import + destructure works in both ESM
// runtime (tsx/node) and TypeScript type checking under esModuleInterop.
import bolt from "@slack/bolt";
const { App, LogLevel } = bolt;

import { loadConfig } from "./config.js";
import { createHealthApp } from "./health.js";
import {
  loadEmployees,
  startEmployeesRefresh,
  stopEmployeesRefresh,
} from "./sheets/employees.js";
import { listNonTerminalTickets } from "./sheets/tickets.js";
import { registerMessageHandler } from "./slack/events.js";
import { registerInteractivity } from "./slack/interactivity.js";
import { registerSlashCommands } from "./slack/slash.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Bolt app — Socket Mode.
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel:
      config.LOG_LEVEL === "debug"
        ? LogLevel.DEBUG
        : config.LOG_LEVEL === "warn"
          ? LogLevel.WARN
          : config.LOG_LEVEL === "error"
            ? LogLevel.ERROR
            : LogLevel.INFO,
  });

  // Health.
  const { app: healthApp, state: healthState } = createHealthApp();
  const httpServer = healthApp.listen(config.PORT, () => {
    // eslint-disable-next-line no-console
    console.info(`[health] listening on :${config.PORT}`);
  });

  // Employee directory — drives team-lead approval routing. Bad rows are
  // skipped with a warning rather than crashing boot (loader logs them).
  // eslint-disable-next-line no-console
  console.info("[boot] loading employees from sheet...");
  let employees;
  try {
    employees = await loadEmployees();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[boot] loadEmployees failed:", err);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.info(`[boot] loaded ${employees.length} employee(s).`);
  startEmployeesRefresh();

  // Boot reconciliation — inventory non-terminal tickets, no auto-fix.
  try {
    const inflight = await listNonTerminalTickets();
    if (inflight.length === 0) {
      // eslint-disable-next-line no-console
      console.info("[boot] no in-flight tickets.");
    } else {
      // eslint-disable-next-line no-console
      console.info(`[boot] ${inflight.length} non-terminal ticket(s):`);
      for (const t of inflight) {
        // eslint-disable-next-line no-console
        console.info(
          `  - ${t.tracking_id} status=${t.status} step=${t.current_step} approver=${t.current_approver_user_id} amount=${t.currency} ${t.amount}`,
        );
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[boot] reconciliation read failed (continuing):", err);
  }

  // Handlers.
  registerMessageHandler(app, { config });
  registerInteractivity(app, { config });
  registerSlashCommands(app, { config });

  // Start.
  await app.start();
  healthState.setSocketReady(true);

  // eslint-disable-next-line no-console
  console.info(
    `[boot] expense bot online — listening to channel ${config.EXPENSES_CHANNEL_ID}, financial manager ${config.FINANCIAL_MANAGER_USER_ID}.`,
  );

  // Graceful shutdown.
  const shutdown = async (sig: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.info(`[boot] ${sig} received — shutting down...`);
    healthState.setSocketReady(false);
    try {
      stopEmployeesRefresh();
    } catch {
      // ignore
    }
    try {
      await app.stop();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[boot] app.stop() error:", err);
    }
    try {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[boot] fatal:", err);
  process.exit(1);
});
