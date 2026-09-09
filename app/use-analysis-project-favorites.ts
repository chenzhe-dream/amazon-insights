"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnalysisFavoriteResponseSchema, AnalysisFavoritesResponseSchema } from "../shared/analysis-project-favorite-contracts";
import { localAgentFetch, localAgentErrorMessage } from "./lib/local-agent-browser";

type State = { scope: string | null; projectIds: string[]; ready: boolean; loading: boolean; pending: boolean; error: string | null };
const empty = (scope: string | null): State => ({ scope, projectIds: [], ready: false, loading: false, pending: false, error: null });

export function useAnalysisProjectFavorites(scope: string | null) {
  const [state, setState] = useState<State>(() => empty(scope));
  const lifecycle = useRef({ epoch: 0, request: 0, busy: false, controller: null as AbortController | null });
  useLayoutEffect(() => {
    const current = lifecycle.current;
    current.epoch++; current.busy = false; current.controller?.abort();
    setState(empty(scope));
    return () => { current.epoch++; current.busy = false; current.controller?.abort(); };
  }, [scope]);

  const refresh = useCallback(async () => {
    const current = lifecycle.current;
    if (!scope || current.busy) return;
    current.controller?.abort();
    const controller = new AbortController(); current.controller = controller;
    const epoch = current.epoch, request = ++current.request;
    const live = () => current.epoch === epoch && current.request === request && !controller.signal.aborted;
    setState(previous => ({ ...previous, scope, loading: true, error: null }));
    try {
      const response = await localAgentFetch("/v1/local-data/project-favorites", { signal: controller.signal, cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(localAgentErrorMessage(payload, "收藏加载失败，请刷新重试"));
      const data = AnalysisFavoritesResponseSchema.parse(payload);
      if (live()) setState({ scope, projectIds: data.projectIds, ready: true, loading: false, pending: false, error: null });
    } catch (error) {
      if (live()) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "收藏加载失败" }));
    }
  }, [scope]);
  useEffect(() => { void refresh(); }, [refresh]);

  const setFavorite = useCallback(async (projectId: string, favorited: boolean) => {
    const current = lifecycle.current;
    if (!scope || state.scope !== scope || !state.ready || current.busy) return false;
    current.busy = true; current.controller?.abort();
    const controller = new AbortController(); current.controller = controller;
    const epoch = current.epoch, request = ++current.request;
    const live = () => current.epoch === epoch && current.request === request && !controller.signal.aborted;
    setState(previous => ({ ...previous, pending: true, loading: false, error: null }));
    try {
      const response = await localAgentFetch(`/v1/local-data/projects/${encodeURIComponent(projectId)}/favorite`,
        { method: favorited ? "PUT" : "DELETE", signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(localAgentErrorMessage(payload, "收藏保存失败，请重试"));
      const data = AnalysisFavoriteResponseSchema.parse(payload);
      if (data.projectId !== projectId || data.favorited !== favorited) throw new Error("收藏状态不一致，请刷新重试");
      if (!live()) return false;
      setState(previous => ({ ...previous, pending: false, projectIds: favorited
        ? [...new Set([...previous.projectIds, projectId])] : previous.projectIds.filter(id => id !== projectId) }));
      return true;
    } catch (error) {
      if (live()) setState(previous => ({ ...previous, pending: false, error: error instanceof Error ? error.message : "收藏保存失败" }));
      return false;
    } finally { if (live()) current.busy = false; }
  }, [scope, state.scope, state.ready]);
  return { ...(state.scope === scope ? state : empty(scope)), refresh, setFavorite };
}
export type AnalysisProjectFavorites = ReturnType<typeof useAnalysisProjectFavorites>;
