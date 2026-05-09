// Express health endpoint per PLAN.md §17.
//
// Returns 200 "ok" once the Slack socket is connected, 503 "socket not
// connected" before that and during shutdown. Railway's health check uses
// this to decide whether to route traffic / restart the container.

import express, { type Express } from "express";

export interface HealthState {
  setSocketReady(ready: boolean): void;
  isSocketReady(): boolean;
}

export function createHealthApp(): { app: Express; state: HealthState } {
  let socketReady = false;

  const state: HealthState = {
    setSocketReady(ready: boolean) {
      socketReady = ready;
    },
    isSocketReady() {
      return socketReady;
    },
  };

  const app = express();

  app.get("/health", (_req, res) => {
    if (!socketReady) {
      res.status(503).type("text/plain").send("socket not connected");
      return;
    }
    res.status(200).type("text/plain").send("ok");
  });

  return { app, state };
}
