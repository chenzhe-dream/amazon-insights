import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { sorftimeReviewAnalysisMeta } from "../../app/seller-sprite-review-analysis";
import { reviewEmptyMessage } from "../../app/lib/voc-review-display";
import type { AuthenticatedWebSession } from "../../app/auth-session-gate";
import type { VocRunObservation } from "../../app/lib/voc-run-browser";
import type { User } from "../../shared/agent-contracts";

// Node SSR verifies markup, not CSS; the built-browser tests exercise styling.
const requireForMarkup = createRequire(import.meta.url);
const previousCssLoader = requireForMarkup.extensions[".css"];
requireForMarkup.extensions[".css"] = module => { module.exports = {}; };
let pageComponents: typeof import("../../app/page");
try {
  pageComponents = requireForMarkup("../../app/page.tsx");
} finally {
  if (previousCssLoader) requireForMarkup.extensions[".css"] = previousCssLoader;
  else delete requireForMarkup.extensions[".css"];
}
const { AuthenticatedAmazonOpportunityApp, ReviewAnalysisMatrixSection, VocRunStatusSummary } = pageComponents;

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
    sessionIdentity: "A".repeat(43),
    canViewUserPresence: false,
    revokeUserPresenceAccess: () => {},
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

test("VOC page hides the unused agent card when no run or saved report is present", () => {
  const html = renderBuilder(user("member@example.com", "member"), "voc");

  assert.doesNotMatch(html, /VOC Agent/);
  assert.doesNotMatch(html, /<section class="card launch-block"/);
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

test("Sorftime ready-empty review cells render their truthful status and independent source", () => {
  const asin = "B0G5N593D6";
  const statusMessage = "Sorftime product_detail 已确认该 ASIN 评论数为 0";
  const record = { asin, marketplace: "US", sampledReviews: 0, mentionTopics: 0, fetchedAt: "2026-09-02", status: "ready" as const, statusMessage, blocks: [] };
  const html = renderToStaticMarkup(createElement(ReviewAnalysisMatrixSection, {
    title: "智能评论分析",
    description: "Sorftime MCP · Customers Say 主题 + 近一年评论样本",
    badge: "Sorftime MCP",
    data: { [asin]: record },
    dataMeta: { source: "Sorftime MCP", updatedAt: "2026-09-02" },
    configMeta: sorftimeReviewAnalysisMeta,
    pendingSteps: null,
    products: [{ asin, brand: "Fixture", image: "", synced: true } as never],
    market: "US",
  }));

  assert.ok(html.includes(reviewEmptyMessage(record)));
  assert.doesNotMatch(html, /暂无匹配主题/);
  assert.match(html, /来源：Sorftime · 评论样本：0 · Customers Say 主题：0/);
  assert.doesNotMatch(html, /来源：Alexa|Manual Alexa/);
});
