import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { AuthenticatedAmazonOpportunityApp } from "../../../app/page";

const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

const searchParams = new URLSearchParams(window.location.search);
const authSession = {
  user: {
    id: "018f1f5c-60f0-4b7a-8000-000000000001",
    organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
    email: "test-admin@amazon-insights.local",
    displayName: "Test admin",
    role: "admin" as const,
    status: "active" as const,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  },
  logout: async () => {},
  logoutPending: false,
  logoutError: null,
};

createRoot(document.getElementById("root")!).render(
  createElement(
    AppRouterContext.Provider,
    { value: router },
    createElement(
      PathnameContext.Provider,
      { value: window.location.pathname },
      createElement(
        SearchParamsContext.Provider,
        { value: searchParams },
        createElement(AuthenticatedAmazonOpportunityApp, { authSession }),
      ),
    ),
  ),
);
