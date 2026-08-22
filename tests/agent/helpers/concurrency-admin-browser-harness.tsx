import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "../../../app/globals.css";
import "../../../app/comparison-layout.css";
import { ConcurrencyAdminPanel } from "../../../app/concurrency-admin-panel";

declare global {
  interface Window {
    __networkMethods: string[];
  }
}

window.__networkMethods = [];
window.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  window.__networkMethods.push((init?.method ?? "GET").toUpperCase());
  throw new Error("network is disabled in the concurrency panel harness");
}) as typeof window.fetch;

createRoot(document.getElementById("root")!).render(
  createElement(ConcurrencyAdminPanel, {
    user: {
      id: "10000000-0000-4000-8000-000000000001",
      organizationId: "20000000-0000-4000-8000-000000000001",
      email: "admin@example.com",
      displayName: "Admin",
      role: "admin",
      status: "active",
      createdAt: "2026-08-22T08:00:00.000Z",
      updatedAt: "2026-08-22T08:00:00.000Z",
    },
    initialSnapshot: {
      schemaVersion: "1.0.0",
      organizationId: "20000000-0000-4000-8000-000000000001",
      queue: { queued: 0, running: 0, paused: 0, terminal: 12 },
      policy: {
        version: "standard-v1",
        profile: "standard",
        limits: {
          wholeJob: 4,
          sellerSprite: 2,
          sif: 1,
          sorftime: 1,
          model: 2,
          image: 2,
        },
        sellerSpriteRolling: { maxAttempts: 30, windowMs: 60_000 },
      },
      connectors: {
        sellerSprite: {
          configured: false,
          available: false,
          reason: "SellerSprite credential is not configured",
          checkedAt: "2026-08-22T08:00:00.000Z",
          circuit: {
            paused: false,
            manualHold: false,
            reason: null,
            updatedAt: null,
          },
        },
        sif: {
          configured: true,
          available: true,
          reason: null,
          checkedAt: "2026-08-22T08:00:00.000Z",
          circuit: {
            paused: false,
            manualHold: false,
            reason: null,
            updatedAt: null,
          },
        },
        sorftime: {
          configured: true,
          available: true,
          reason: null,
          checkedAt: "2026-08-22T08:00:00.000Z",
          circuit: {
            paused: false,
            manualHold: false,
            reason: null,
            updatedAt: null,
          },
        },
      },
      sellerSpriteQuota: {
        total: null,
        totalLabel: "总额度未知",
        remaining: null,
        used: null,
        localObservedAttempts: 0,
        source: "local-observed",
        status: "unknown",
        checkedAt: null,
        ageSeconds: null,
        warning: null,
      },
    },
  }),
);
