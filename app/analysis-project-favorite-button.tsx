"use client";
import { useRef, useState } from "react";
import type { AnalysisProjectFavorites } from "./use-analysis-project-favorites";

export function AnalysisProjectFavoriteButton({ projectId, favorites, beforeFavorite }: {
  projectId: string | null; favorites: AnalysisProjectFavorites;
  beforeFavorite?: () => Promise<boolean> | boolean;
}) {
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const selected = Boolean(projectId && favorites.projectIds.includes(projectId));
  return <span>
    <button type="button" className="ghost-btn" aria-pressed={selected}
      title={projectId ? (selected ? "取消收藏，历史项目与分析结果会保留" : "收藏此项目，团队成员均可查看") : "请先选择或创建项目"}
      disabled={!projectId || !favorites.ready || favorites.pending || favorites.loading || preparing}
      onClick={async () => {
        if (!projectId || busy.current) return;
        busy.current = true; setPreparing(true); setError(null);
        try {
          if (!selected && beforeFavorite && !await beforeFavorite()) return;
          await favorites.setFavorite(projectId, !selected);
        } catch (failure) { setError(failure instanceof Error ? failure.message : "保存细分名称失败，请重试"); }
        finally { busy.current = false; setPreparing(false); }
      }}>
      {preparing || favorites.pending ? "保存收藏中…" : selected ? "★ 已收藏" : "☆ 收藏项目"}
    </button>
    {error ? <span role="alert" className="project-panel-error">{error}</span> : null}
    {favorites.error ? <span role="alert" className="project-panel-error">{favorites.error}
      <button type="button" className="ghost-btn" disabled={favorites.loading || favorites.pending} onClick={() => void favorites.refresh()}>刷新收藏</button>
    </span> : null}
  </span>;
}
