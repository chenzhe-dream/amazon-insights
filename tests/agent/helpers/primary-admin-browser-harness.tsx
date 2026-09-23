import { createElement, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { AuthenticatedAmazonOpportunityApp } from "../../../app/page";
import { AuthIdentityControl, AuthSessionGate } from "../../../app/auth-session-gate";
import type { AuthenticatedWebSession } from "../../../app/auth-session-gate";
import { localAgentFetch } from "../../../app/lib/local-agent-browser";

const nativeHistoryReplaceState = window.history.replaceState.bind(window.history);

const authSession = {
  user: {
    id: "018f1f5c-60f0-4b7a-8000-000000000001",
    organizationId: window.__fixtureOrganizationId ?? "018f1f5c-60f0-4b7a-8000-000000000002",
    email: "test-admin@amazon-insights.local",
    displayName: "Test admin",
    role: "admin" as const,
    status: "active" as const,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  },
  sessionIdentity: "A".repeat(43),
  canViewUserPresence: false,
  revokeUserPresenceAccess: () => {},
  logout: async () => {},
  logoutPending: false,
  logoutError: null,
};

declare global {
  interface Window {
    __fixtureOrganizationId?: string;
    appLocation?: string;
    navigateAuthenticatedApp?: (href: string) => void;
    remountAuthenticatedApp?: () => void;
    routerReplacements?: string[];
    staleRouterDrops?: string[];
    dropNextRouterReplace?: boolean;
    routerRefreshes?: number;
    triggerAuthSessionExpiryRace?: () => Promise<void>;
    __VINEXT_RSC_NAVIGATE__?: (
      href: string,
      redirectDepth?: number,
      navigationKind?: string,
      historyUpdateMode?: "push" | "replace",
    ) => Promise<void>;
  }
}

function ExpiryRaceProtectedSession({ session }: { session: AuthenticatedWebSession }) {
  useEffect(() => {
    const revokeCapturedSession = () => {
      session.revokeUserPresenceAccess(session.sessionIdentity);
    };
    window.triggerAuthSessionExpiryRace = async () => {
      await localAgentFetch("/v1/auth-expiry-race");
      revokeCapturedSession();
    };
    return () => {
      delete window.triggerAuthSessionExpiryRace;
    };
  }, [session]);

  return createElement(
    "main",
    { "data-testid": "protected-session-content" },
    createElement("p", null, "受保护内容"),
    createElement(AuthIdentityControl, { session }),
  );
}

function AuthSessionExpiryRaceHarness() {
  return (
    <AuthSessionGate>
      {(session: AuthenticatedWebSession) => <ExpiryRaceProtectedSession session={session} />}
    </AuthSessionGate>
  );
}

function BrowserHarness() {
  const controls = new URLSearchParams(window.location.search);
  const controlledPath = controls.get("__appPath");
  const controlledSearch = controls.get("__appSearch");
  const [location, setLocation] = useState(() => ({
    pathname: controlledPath || window.location.pathname,
    search: controlledPath ? controlledSearch || "" : window.location.search.replace(/^\?/, ""),
  }));
  const [mount, setMount] = useState(0);
  const adoptLocation = useCallback((href: string) => {
    const next = new URL(href, window.location.origin);
    const value = `${next.pathname}${next.search}`;
    window.appLocation = value;
    setLocation({ pathname: next.pathname, search: next.search.replace(/^\?/, "") });
  }, []);
  const navigate = useCallback((href: string, replace = false) => {
    const next = new URL(href, window.location.origin);
    const value = `${next.pathname}${next.search}`;
    if (replace) nativeHistoryReplaceState(window.history.state, "", value);
    else window.history.pushState(window.history.state, "", value);
    adoptLocation(value);
  }, [adoptLocation]);
  useEffect(() => {
    const original = window.history.replaceState;
    window.history.replaceState = (state, unused, url) => {
      nativeHistoryReplaceState(state, unused, url);
      if (url !== undefined && url !== null) adoptLocation(String(url));
    };
    return () => {
      window.history.replaceState = original;
    };
  }, [adoptLocation]);
  const router = useMemo(() => ({
    back() {},
    forward() {},
    refresh() {
      window.routerRefreshes = (window.routerRefreshes ?? 0) + 1;
      setMount(value => value + 1);
    },
    push(href: string) { navigate(href); },
    replace(href: string) {
      window.routerReplacements = [...(window.routerReplacements ?? []), href];
      if (window.dropNextRouterReplace) {
        window.dropNextRouterReplace = false;
        window.staleRouterDrops = [...(window.staleRouterDrops ?? []), href];
        return;
      }
      navigate(href, true);
    },
    prefetch() {},
  }), [navigate]);
  window.__VINEXT_RSC_NAVIGATE__ = async (
    href,
    _redirectDepth,
    _navigationKind,
    historyUpdateMode,
  ) => {
    router[historyUpdateMode === "replace" ? "replace" : "push"](href);
  };
  window.appLocation = `${location.pathname}${location.search ? `?${location.search}` : ""}`;
  window.routerRefreshes ??= 0;
  window.navigateAuthenticatedApp = href => navigate(href);
  window.remountAuthenticatedApp = () => setMount(value => value + 1);

  return createElement(
    AppRouterContext.Provider,
    { value: router },
    createElement(
      PathnameContext.Provider,
      { value: location.pathname },
      createElement(
        SearchParamsContext.Provider,
        { value: new URLSearchParams(location.search) },
        createElement(AuthenticatedAmazonOpportunityApp, { authSession, key: `${location.pathname}:${mount}` }),
      ),
    ),
  );
}

const rootComponent = new URLSearchParams(window.location.search).get("authGateRace") === "1"
  ? AuthSessionExpiryRaceHarness
  : BrowserHarness;
createRoot(document.getElementById("root")!).render(createElement(rootComponent));
