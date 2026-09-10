"use client";

import { type RuntimeAnalysisDataSnapshot, createRuntimeAnalysisScopeGuard, readAndCommitRuntimeAnalysisData } from "../../lib/runtime-analysis-data";
import { useState, useRef, useLayoutEffect, useCallback, useEffect } from "react";
import { baseSyncRunIdFromSearch } from "../../lib/voc-run-browser";
import { refreshedCatalog } from "../../competitor-data";
import { syncJobIdFromSearch } from "../../lib/asin-sync-session";
import { useAnalysisProjectFavorites } from "../projects/use-analysis-project-favorites";
import { type Product } from "../catalog/product-contracts";
import { type RuntimeAnalysisRefreshResult, RUNTIME_ANALYSIS_REFRESH_FAILED } from "./workspace-runtime-contracts";
import type { useWorkspaceLocation } from "./workspace-location";
import type { useVocRunState } from "./workspace-voc-run";
import type { useWorkspaceInput } from "./workspace-input";
import type { useProjectState } from "./project-state";
import type { AuthenticatedWebSession } from "../../auth-session-gate";
import type { useSyncSessionState } from "./sync-session-state";

export function useRuntimeDataState() {
  const [catalogItems, setCatalogItems] = useState<Product[]>(() => refreshedCatalog as Product[]);

  const [runtimeAnalysisData, setRuntimeAnalysisData] = useState<RuntimeAnalysisDataSnapshot | null>(null);

  const [runtimeAnalysisDataScope, setRuntimeAnalysisDataScope] = useState<string | null>(null);

  const runtimeAnalysisRequest = useRef(0);

  const runtimeCommitGuard = useRef(createRuntimeAnalysisScopeGuard());

  return {
    catalogItems, setCatalogItems, runtimeAnalysisData, setRuntimeAnalysisData, runtimeAnalysisDataScope,
    setRuntimeAnalysisDataScope, runtimeAnalysisRequest, runtimeCommitGuard,
  };
}

type useRuntimeRefreshInputs = Pick<ReturnType<typeof useWorkspaceLocation>, "searchParams">
  & Pick<ReturnType<typeof useVocRunState>, "setVocRun" | "vocRestoreController" | "restoringVocRun">
  & Pick<ReturnType<typeof useWorkspaceInput>, "activeAsins" | "market" | "setMessage">
  & Pick<ReturnType<typeof useProjectState>, "currentProjectId">
  & Pick<ReturnType<typeof useRuntimeDataState>, "runtimeCommitGuard" | "runtimeAnalysisRequest" | "setRuntimeAnalysisData" | "setRuntimeAnalysisDataScope" | "setCatalogItems">
  & { authSession: AuthenticatedWebSession };

export function useRuntimeRefresh({
    searchParams, authSession, setVocRun, vocRestoreController: vocRestoreControllerRef, restoringVocRun: restoringVocRunRef,
    activeAsins, currentProjectId, market, runtimeCommitGuard: runtimeCommitGuardRef,
    runtimeAnalysisRequest: runtimeAnalysisRequestRef, setRuntimeAnalysisData, setRuntimeAnalysisDataScope, setCatalogItems,
    setMessage,
  }: useRuntimeRefreshInputs) {
  const syncJobId = syncJobIdFromSearch(searchParams.toString());

  const baseSyncRunId = baseSyncRunIdFromSearch(searchParams.toString());

  const runtimeSessionKey = `${authSession.sessionIdentity}:${authSession.user.organizationId}`;

  const projectFavorites = useAnalysisProjectFavorites(authSession.logoutPending ? null : runtimeSessionKey);

  useLayoutEffect(() => {
    setVocRun(null);
    return () => {
      vocRestoreControllerRef.current?.abort();
      vocRestoreControllerRef.current = null;
      restoringVocRunRef.current = null;
    };
  }, [runtimeSessionKey, authSession.logoutPending, restoringVocRunRef, setVocRun, vocRestoreControllerRef]);

  const runtimeAsinKey = [...activeAsins].sort().join(",");

  const runtimeScopeKey = `${runtimeSessionKey}:${currentProjectId}:${market}:${runtimeAsinKey}:${syncJobId}:${baseSyncRunId}`;

  const runtimeScope = useRef<{ sessionKey: string; projectId: string | null; asins: string; enabled: boolean } | null>(null);

  useLayoutEffect(() => {
    const guard = runtimeCommitGuardRef.current;
    guard.activate(authSession.logoutPending ? null : runtimeScopeKey);
    runtimeScope.current = { sessionKey: runtimeSessionKey, projectId: currentProjectId, asins: runtimeAsinKey, enabled: !authSession.logoutPending };
    return () => { runtimeScope.current = null; guard.activate(null); };
  }, [runtimeSessionKey, runtimeScopeKey, currentProjectId, runtimeAsinKey, authSession.logoutPending, runtimeCommitGuardRef]);

  const refreshRuntimeAnalysisData = useCallback(async (
    projectId: string,
    asins: readonly string[],
    signal?: AbortSignal,
    isCurrent?: () => boolean,
  ): Promise<RuntimeAnalysisRefreshResult> => {
    const request = ++runtimeAnalysisRequestRef.current;
    const captured = runtimeCommitGuardRef.current.capture();
    const sessionKey = runtimeScope.current?.sessionKey;
    const asinKey = [...asins].sort().join(",");
    try {
      const snapshot = await readAndCommitRuntimeAnalysisData(projectId, asins, {
        signal,
        isCurrent: () => runtimeCommitGuardRef.current.isCurrent(captured) && request === runtimeAnalysisRequestRef.current && (!isCurrent || isCurrent())
          && runtimeScope.current?.enabled === true && runtimeScope.current.sessionKey === sessionKey
          && runtimeScope.current.projectId === projectId && runtimeScope.current.asins === asinKey,
        commit: snapshot => { setRuntimeAnalysisData(snapshot); setRuntimeAnalysisDataScope(captured!.key); setCatalogItems(snapshot.catalog as Product[]); },
      });
      if (!snapshot) {
        return { ok: false, reason: "superseded", message: RUNTIME_ANALYSIS_REFRESH_FAILED };
      }
      return { ok: true, snapshot };
    } catch {
      return {
        ok: false,
        reason: request === runtimeAnalysisRequestRef.current ? "failed" : "superseded",
        message: RUNTIME_ANALYSIS_REFRESH_FAILED,
      };
    }
  }, [runtimeAnalysisRequestRef, runtimeCommitGuardRef, setCatalogItems, setRuntimeAnalysisData, setRuntimeAnalysisDataScope]);

  const refreshRuntimeAfterSync = useCallback(async (successMessage: string): Promise<boolean> => {
    if (!currentProjectId) {
      setMessage(RUNTIME_ANALYSIS_REFRESH_FAILED);
      return false;
    }
    const result = await refreshRuntimeAnalysisData(currentProjectId, activeAsins);
    if (!result.ok) {
      if (result.reason === "failed") setMessage(result.message);
      return false;
    }
    setMessage(successMessage);
    return true;
  }, [activeAsins, currentProjectId, refreshRuntimeAnalysisData, setMessage]);

  return { syncJobId, baseSyncRunId, runtimeSessionKey, projectFavorites, runtimeScopeKey, refreshRuntimeAnalysisData, refreshRuntimeAfterSync };
}

type useCatalogRefreshInputs = Pick<ReturnType<typeof useRuntimeDataState>, "setCatalogItems">
  & Pick<ReturnType<typeof useSyncSessionState>, "workspaceKey">;

export function useCatalogRefresh({ setCatalogItems, workspaceKey }: useCatalogRefreshInputs) {
  const refreshCatalog = useCallback(async () => {
    try {
      const response = await fetch("/api/catalog");
      if (!response.ok) return;
      const payload = (await response.json()) as { items?: Product[] };
      if (Array.isArray(payload.items) && payload.items.length) {
        setCatalogItems(payload.items);
      }
    } catch {
      // 保留打包快照
    }
  }, [setCatalogItems]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && !workspaceKey) void refreshCatalog();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshCatalog, workspaceKey]);

  return {  };
}
