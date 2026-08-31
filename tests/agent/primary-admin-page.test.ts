import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { AuthenticatedAmazonOpportunityApp, VocRunStatusSummary } from "../../app/page";
import type { AuthenticatedWebSession } from "../../app/auth-session-gate";
import type { VocRunObservation } from "../../app/lib/voc-run-browser";
import type { User } from "../../shared/agent-contracts";

const ROOT_PATH_DIAGNOSTIC =
  "根路径不再混合展示全部底库。请输入一批同类 ASIN，或点下方工作区进入 /p/floor-lamps、/p/kick-scooters";

const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

function user(email: string, role: User["role"]): User {
  return {
    id: "018f1f5c-60f0-4b7a-8000-000000000001",
    organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
    email,
    displayName: "Fixture",
    role,
    status: "active",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function renderBuilder(
  account: User,
  tab: "overview" | "keywords" | "traffic" | "voc",
) {
  const session: AuthenticatedWebSession = {
    user: account,
    logout: async () => {},
    logoutPending: false,
    logoutError: null,
  };
  const searchParams = new URLSearchParams(tab === "overview" ? "" : `tab=${tab}`);

  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(
        PathnameContext.Provider,
        { value: "/" },
        createElement(
          SearchParamsContext.Provider,
          { value: searchParams },
          createElement(AuthenticatedAmazonOpportunityApp, { authSession: session }),
        ),
      ),
    ),
  );
}

test("primary admin renders the root diagnostic at every builder tab", () => {
  const primary = user("admin@example.com", "admin");

  for (const tab of ["overview", "keywords", "traffic"] as const) {
    const html = renderBuilder(primary, tab);
    assert.match(html, new RegExp(`<span class="builder-message error">${ROOT_PATH_DIAGNOSTIC}</span>`));
  }
});

test("non-primary accounts render no root-diagnostic builder message node", () => {
  const nonPrimaryAccounts = [
    user("test-admin@amazon-insights.local", "admin"),
    user("member@example.com", "member"),
    user("admin@example.com", "member"),
  ];

  for (const account of nonPrimaryAccounts) {
    for (const tab of ["overview", "keywords", "traffic"] as const) {
      const html = renderBuilder(account, tab);
      assert.doesNotMatch(html, /builder-message/);
      assert.doesNotMatch(html, new RegExp(ROOT_PATH_DIAGNOSTIC));
    }
  }
});

test("VOC page reports that its dedicated run has not started when no run is present", () => {
  const html = renderBuilder(user("member@example.com", "member"), "voc");

  assert.match(html, /VOC Agent · 尚未开始/);
  assert.doesNotMatch(html, /Stage: queued · 0%/);
});

test("VOC observations without a real stage never render a queued zero-percent fallback", () => {
  for (const kind of ["not-started", "failed", "waiting-input", "offline"] as const) {
    const observation: VocRunObservation = {
      kind,
      runId: "11111111-1111-4111-8111-111111111111",
      stage: null,
      report: null,
      reports: [],
      message: `VOC ${kind}`,
    };
    const html = renderToStaticMarkup(createElement(VocRunStatusSummary, { observation }));

    assert.doesNotMatch(html, /Stage:/, kind);
    assert.doesNotMatch(html, /queued · 0%/, kind);
  }
});

test("VOC observation renders stage status and progress when a real stage exists", () => {
  const observation: VocRunObservation = {
    kind: "active",
    runId: "11111111-1111-4111-8111-111111111111",
    stage: { status: "running", progress: 42 },
    report: null,
    reports: [],
    message: "VOC running",
  };
  const html = renderToStaticMarkup(createElement(VocRunStatusSummary, { observation }));

  assert.match(html, /Stage: running · 42%/);
});

test("failed VOC observation with a malformed empty stage renders only its truthful terminal status", () => {
  const observation: VocRunObservation = {
    kind: "failed",
    runId: "11111111-1111-4111-8111-111111111111",
    stage: {},
    report: null,
    reports: [],
    message: "VOC failed",
  };
  const html = renderToStaticMarkup(createElement(VocRunStatusSummary, { observation }));

  assert.match(html, /VOC Agent · failed/);
  assert.doesNotMatch(html, /Stage:/);
  assert.doesNotMatch(html, /queued/);
});
