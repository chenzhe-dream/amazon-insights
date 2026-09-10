"use client";

import { type TabId } from "../../lib/app-tabs";
import { navigationEntries, type NavGroup, isNavGroup } from "../shell/navigation";
import type { useFlyoutState } from "./workspace-flyout";
import type { useWorkspaceLocation } from "./workspace-location";

type createWorkspaceNavigationInputs = Pick<ReturnType<typeof useFlyoutState>, "flyoutGroupId">
  & Pick<ReturnType<typeof useWorkspaceLocation>, "activeTab">;

export function createWorkspaceNavigation({ flyoutGroupId, activeTab }: createWorkspaceNavigationInputs) {
  const nav = navigationEntries;

  const activeFlyoutGroup = flyoutGroupId
    ? nav.find((entry): entry is NavGroup => isNavGroup(entry) && entry.id === flyoutGroupId) ?? null
    : null;

  const flyoutOpen = Boolean(activeFlyoutGroup);

  const activeLeaf = (() => {
    for (const entry of nav) {
      if (isNavGroup(entry)) {
        const child = entry.children.find(item => item.id === activeTab);
        if (child) return { parent: entry.label, ...child };
      } else if (entry.id === activeTab) {
        return { parent: null as string | null, ...entry };
      }
    }
    return { parent: null as string | null, id: "overview" as TabId, label: "竞品概览", sub: "" };
  })();

  const pageTitle = activeLeaf.parent ? `${activeLeaf.parent} · ${activeLeaf.label}` : activeLeaf.label;

  return { nav, activeFlyoutGroup, flyoutOpen, activeLeaf, pageTitle };
}
