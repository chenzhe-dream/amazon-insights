import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { AuthenticatedAmazonOpportunityApp } from "../../app/page";
import type { BuilderNotice } from "../../app/lib/primary-admin";
import type { AuthenticatedWebSession } from "../../app/auth-session-gate";
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
  tab: "overview" | "keywords" | "traffic",
  initialBuilderNotice?: BuilderNotice,
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
          createElement(AuthenticatedAmazonOpportunityApp, { authSession: session, initialBuilderNotice }),
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

test("business notices remain rendered with each tab's existing error rule for every account", () => {
  const accounts = [
    user("admin@example.com", "admin"),
    user("test-admin@amazon-insights.local", "admin"),
    user("member@example.com", "member"),
    user("admin@example.com", "member"),
  ];
  const cases = [
    { tab: "overview" as const, text: "请至少输入 3 个竞品 ASIN", className: "builder-message error" },
    { tab: "keywords" as const, text: "同步失败，请重试", className: "builder-message error" },
    { tab: "traffic" as const, text: "已保存到收藏夹", className: "builder-message" },
  ];

  for (const account of accounts) {
    for (const item of cases) {
      const html = renderBuilder(account, item.tab, { kind: "business", text: item.text });
      assert.match(html, new RegExp(`<span class="${item.className}">${item.text}</span>`));
    }
  }
});
