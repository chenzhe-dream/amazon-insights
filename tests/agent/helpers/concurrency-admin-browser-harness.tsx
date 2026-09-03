import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "../../../app/globals.css";
import "../../../app/comparison-layout.css";
import { ConcurrencyAdminPanel } from "../../../app/concurrency-admin-panel";

declare global {
  interface Window {
    __networkMethods: string[];
    __networkCalls: Array<{ url: string; method: string; body: string | null }>;
  }
}

window.__networkMethods = [];
window.__networkCalls = [];

const credentialStates = [
  { connectorId: "sellerSprite", configured: false, managed: false, source: "none", version: null, updatedAt: null },
  { connectorId: "sif", configured: true, managed: false, source: "environment", version: null, updatedAt: null },
  { connectorId: "sorftime", configured: true, managed: true, source: "managed", version: 1, updatedAt: "2026-08-22T08:00:00.000Z" },
] as const;

const adminSnapshot = {
  schemaVersion: "1.0.0",
  organizationId: "20000000-0000-4000-8000-000000000001",
  queue: { queued: 0, running: 0, paused: 0, terminal: 12 },
  policy: {
    version: "standard-v1",
    profile: "standard",
    limits: { wholeJob: 4, sellerSprite: 2, sif: 1, sorftime: 1, model: 2, image: 2 },
    sellerSpriteRolling: { maxAttempts: 30, windowMs: 60_000 },
  },
  connectors: {
    sellerSprite: { configured: false, available: false, reason: "SellerSprite credential is not configured", checkedAt: "2026-08-22T08:00:00.000Z", circuit: { paused: false, manualHold: false, reason: null, updatedAt: null } },
    sif: { configured: true, available: true, reason: null, checkedAt: "2026-08-22T08:00:00.000Z", circuit: { paused: false, manualHold: false, reason: null, updatedAt: null } },
    sorftime: { configured: true, available: true, reason: null, checkedAt: "2026-08-22T08:00:00.000Z", circuit: { paused: false, manualHold: false, reason: null, updatedAt: null } },
  },
  sellerSpriteQuota: { total: null, totalLabel: "总额度未知", remaining: null, used: null, localObservedAttempts: 0, source: "local-observed", status: "unknown", checkedAt: null, ageSeconds: null, warning: null },
} as const;

const legacyRepairPreview = {
  jobId: "legacy-job",
  version: "opaque-version",
  candidates: [{
    asin: "B0CCYMV1T1",
    module: "keywords",
    connectorId: "sif",
    nextStatus: "pending",
    reason: "LEGACY_UNVERIFIED",
  }],
} as const;

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const method = (init?.method ?? "GET").toUpperCase();
  const url = String(input);
  window.__networkMethods.push(method);
  window.__networkCalls.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
  if (url.includes("/legacy-repair/")) return Response.json(legacyRepairPreview);
  if (url.endsWith("/v1/local-data/sync-asins/legacy-job")) return Response.json({
    jobId: "legacy-job",
    asins: ["B0CCYMV1T1"],
    marketplace: "US",
    status: "completed",
    message: "Completed with gaps",
    currentStageId: "build",
    stages: [],
    asinProgress: { B0CCYMV1T1: { keywords: { status: "pending", reason: "LEGACY_UNVERIFIED", updatedAt: "2026-08-23T08:00:00.000Z" } } },
    createdAt: "2026-08-22T08:00:00.000Z",
    updatedAt: "2026-08-23T08:00:00.000Z",
  });
  if (url.endsWith("/v1/connectors")) return Response.json({ connectors: credentialStates });
  if (url.endsWith("/v1/admin/concurrency")) return Response.json(adminSnapshot);
  if (url.endsWith("/probe")) return Response.json({ connectorId: "sif", configured: true, available: true, reason: null, checkedAt: "2026-08-23T08:00:00.000Z" });
  if (url.endsWith("/credential")) return Response.json({ ...credentialStates[0], configured: true, managed: true, source: "managed", version: 1, updatedAt: "2026-08-23T08:00:00.000Z" });
  return Response.json({ error: { message: "unexpected request" } }, { status: 404 });
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
    initialSnapshot: adminSnapshot,
    initialCredentialStates: credentialStates,
    initialLegacyRepairPreview: legacyRepairPreview,
  }),
);
