"use client";

import Link from "next/link";
import type { AnalysisProject } from "./project-library-panel";

export function selectWorkspaceSections(
  workspaces: AnalysisProject[],
  currentProjectId: string | null,
  recentLimit = 5,
): { visible: AnalysisProject[]; history: AnalysisProject[] } {
  const sorted = [...workspaces].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id),
  );
  const current = currentProjectId
    ? sorted.find(workspace => workspace.id === currentProjectId)
    : undefined;
  const recent = sorted
    .filter(workspace => workspace.id !== currentProjectId)
    .slice(0, recentLimit);
  const visible = current ? [current, ...recent] : recent;
  const visibleIds = new Set(visible.map(workspace => workspace.id));

  return {
    visible,
    history: sorted.filter(workspace => !visibleIds.has(workspace.id)),
  };
}

export function WorkspaceHistoryStrip({
  workspaces,
  currentProjectId,
  buildHref,
}: {
  workspaces: AnalysisProject[];
  currentProjectId: string | null;
  buildHref: (project: AnalysisProject) => string;
}) {
  const { visible, history } = selectWorkspaceSections(workspaces, currentProjectId);
  const links = (items: AnalysisProject[]) =>
    items.map(workspace => (
      <Link
        key={workspace.id}
        href={buildHref(workspace)}
        className={`workspace-chip${workspace.id === currentProjectId ? " active" : ""}`}
      >
        {workspace.categoryLabel || workspace.name}
        <small>
          /p/{workspace.slug}
          {workspace.marketplace ? ` · ${workspace.marketplace}` : ""}
        </small>
      </Link>
    ));

  return (
    <div className="workspace-switcher" aria-label="已保存的分析工作区">
      {links(visible)}
      {history.length ? (
        <details className="workspace-history">
          <summary>历史项目（{history.length}）</summary>
          <div className="workspace-history-items">{links(history)}</div>
        </details>
      ) : null}
    </div>
  );
}
