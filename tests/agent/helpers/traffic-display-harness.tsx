import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AuthenticatedAmazonOpportunityApp } from "../../../app/page";
import type { AuthenticatedWebSession } from "../../../app/auth-session-gate";
import "../../../app/globals.css";
import "../../../app/warm-theme.css";
import "../../../app/comparison-layout.css";

const initialSession: AuthenticatedWebSession = {
  user: { id: "018f1f5c-60f0-4b7a-8000-000000000001", organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
    email: "fixture@example.test", displayName: "本地测试", role: "admin", status: "active",
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
  sessionIdentity: "A".repeat(43), logoutPending: false, logoutError: null,
  canViewUserPresence: false, revokeUserPresenceAccess() {}, async logout() {},
};

declare global {
  interface Window {
    setTrafficFixtureSession?: (patch: { sessionIdentity?: string; organizationId?: string; logoutPending?: boolean }) => void;
    navigateTrafficFixture?: (search: string) => void;
    remountTrafficFixture?: () => void;
  }
}

function Harness() {
  const controls = new URLSearchParams(window.location.search);
  const [location, setLocation] = useState({ pathname: "/p/traffic-fixture", search: controls.get("appSearch") ?? "" });
  const [session, setSession] = useState(initialSession);
  const [mount, setMount] = useState(0);
  const adopt = useCallback((href: string) => {
    const url = new URL(href, window.location.origin);
    setLocation({ pathname: url.pathname, search: url.search.slice(1) });
  }, []);
  useEffect(() => {
    const original = window.history.replaceState;
    window.history.replaceState = (state, unused, url) => { original.call(window.history, state, unused, url); if (url) adopt(String(url)); };
    return () => { window.history.replaceState = original; };
  }, [adopt]);
  const router = useMemo(() => ({ back() {}, forward() {}, refresh: () => setMount(value => value + 1), push: adopt, replace: adopt, prefetch() {} }), [adopt]);
  useEffect(() => {
    window.setTrafficFixtureSession = patch => flushSync(() => setSession(previous => ({
      ...previous, sessionIdentity: patch.sessionIdentity ?? previous.sessionIdentity,
      logoutPending: patch.logoutPending ?? previous.logoutPending,
      user: { ...previous.user, organizationId: patch.organizationId ?? previous.user.organizationId },
    })));
    window.navigateTrafficFixture = search => flushSync(() => adopt(`/p/traffic-fixture?${search}`));
    window.remountTrafficFixture = () => setMount(value => value + 1);
    return () => { delete window.setTrafficFixtureSession; delete window.navigateTrafficFixture; delete window.remountTrafficFixture; };
  }, [adopt]);
  return <AppRouterContext.Provider value={router}><PathnameContext.Provider value={location.pathname}>
    <SearchParamsContext.Provider value={new URLSearchParams(location.search)}>
      <AuthenticatedAmazonOpportunityApp key={mount} authSession={session} />
    </SearchParamsContext.Provider>
  </PathnameContext.Provider></AppRouterContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
