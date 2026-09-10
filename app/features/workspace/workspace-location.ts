"use client";

import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { useRef, useEffect } from "react";
import { type TabId, tabFromParam } from "../../lib/app-tabs";
import { buildTabHref, resolveActiveAsins } from "../projects/workspace-navigation";

export function useWorkspaceLocation() {
  const searchParams = useSearchParams();

  const pathname = usePathname();

  const router = useRouter();

  const appSearch = searchParams.toString();

  const appLocationRef = useRef({ pathname, search: appSearch });

  useEffect(() => {
    appLocationRef.current = { pathname, search: appSearch };
  }, [appSearch, pathname]);

  const tabParam = searchParams.get("tab");

  const asinsParam = searchParams.get("asins");

  const projectParam = searchParams.get("project");

  const slugParam = pathname.match(/^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)$/)?.[1] ?? null;

  const workspacePath = slugParam ? `/p/${slugParam}` : "/";

  const tabHref = (tabId: TabId) => buildTabHref(tabId, searchParams, workspacePath);

  const initialAsins = resolveActiveAsins(slugParam ? null : asinsParam);

  const activeTab = tabFromParam(tabParam);

  return {
    searchParams, router, appSearch, appLocationRef, asinsParam, projectParam, slugParam, workspacePath, tabHref,
    initialAsins, activeTab,
  };
}
