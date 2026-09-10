"use client";
import type { AnalysisProjectFavorites } from "./use-analysis-project-favorites";

export function AnalysisProjectFavoriteButton({ projectId, favorites }: {
  projectId: string | null; favorites: AnalysisProjectFavorites;
}) {
  const selected = Boolean(projectId && favorites.projectIds.includes(projectId));
  return <span>
    <button type="button" className="ghost-btn" aria-pressed={selected}
      title={projectId ? (selected ? "取消收藏，历史项目与分析结果会保留" : "收藏此项目，团队成员均可查看") : "请先选择或创建项目"}
      disabled={!projectId || !favorites.ready || favorites.pending || favorites.loading}
      onClick={() => { if (projectId) void favorites.setFavorite(projectId, !selected); }}>
      {favorites.pending ? "保存收藏中…" : selected ? "★ 已收藏" : "☆ 收藏项目"}
    </button>
    {favorites.error ? <span role="alert" className="project-panel-error">{favorites.error}
      <button type="button" className="ghost-btn" disabled={favorites.loading || favorites.pending} onClick={() => void favorites.refresh()}>刷新收藏</button>
    </span> : null}
  </span>;
}
