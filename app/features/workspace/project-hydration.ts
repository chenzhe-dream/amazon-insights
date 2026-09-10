"use client";

import { useEffect } from "react";
import { localAgentFetch } from "../../lib/local-agent-browser";
import { type AnalysisProject } from "../projects/project-library-panel";
import { workspaceHref } from "../../lib/workspace-url";
import { readHistoricalSyncPointer } from "../projects/historical-sync-pointer";
import { parseAsinsParam } from "../projects/workspace-navigation";
import { markets, type MarketCode } from "../catalog/product-contracts";
import type { useWorkspaceLocation } from "./workspace-location";
import type { useProjectState } from "./project-state";
import type { useSyncSessionState } from "./sync-session-state";
import type { useRuntimeDataState } from "./workspace-runtime";
import type { useWorkspaceInput } from "./workspace-input";
import type { useWorkspaceResume } from "./workspace-resume";
import type { useRuntimeRefresh } from "./workspace-runtime";

type useProjectHydrationInputs = Pick<ReturnType<typeof useWorkspaceLocation>, "slugParam" | "projectParam" | "asinsParam" | "appLocationRef" | "router">
  & Pick<ReturnType<typeof useProjectState>, "setCurrentProjectId" | "setCurrentProjectName">
  & Pick<ReturnType<typeof useSyncSessionState>, "workspaceKey" | "setHydratedWorkspaceKey" | "setSyncAsins" | "setSyncRunContext" | "setTerminalSyncJob" | "setTerminalPointerRetained" | "setStageOutputReceipt">
  & Pick<ReturnType<typeof useRuntimeDataState>, "setRuntimeAnalysisData" | "runtimeAnalysisRequest">
  & Pick<ReturnType<typeof useWorkspaceInput>, "setMessage" | "setMarket" | "setActiveAsins" | "replaceInputAsins" | "activeAsins">
  & Pick<ReturnType<typeof useWorkspaceResume>, "setWorkspaceLabel" | "workspaceReady">
  & Pick<ReturnType<typeof useRuntimeRefresh>, "refreshRuntimeAnalysisData" | "syncJobId">;

export function useProjectHydration({
    slugParam, projectParam, asinsParam, setCurrentProjectId, setCurrentProjectName, workspaceKey, setHydratedWorkspaceKey,
    setSyncAsins, setSyncRunContext, setTerminalSyncJob, setTerminalPointerRetained, setStageOutputReceipt,
    setRuntimeAnalysisData, runtimeAnalysisRequest: runtimeAnalysisRequestRef, setMessage, setMarket, setActiveAsins,
    replaceInputAsins, setWorkspaceLabel, appLocationRef, router, refreshRuntimeAnalysisData, syncJobId, workspaceReady,
    activeAsins,
  }: useProjectHydrationInputs) {
  useEffect(() => {
    const key = slugParam || projectParam;
    if (!key) {
      if (!parseAsinsParam(asinsParam)) {
        let cancelled = false;
        queueMicrotask(() => {
          if (cancelled) return;
          setCurrentProjectId(null);
          setCurrentProjectName(null);
        });
        return () => {
          cancelled = true;
        };
      }
      return;
    }
    let cancelled = false;
    if (workspaceKey) {
      setHydratedWorkspaceKey(null);
      setSyncAsins(null);
      setSyncRunContext(null);
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      setStageOutputReceipt(null);
    }
    setRuntimeAnalysisData(null);
    runtimeAnalysisRequestRef.current += 1;
    localAgentFetch(`/v1/local-data/projects/${encodeURIComponent(key)}`)
      .then(res => res.json())
      .then(payload => {
        if (cancelled) return;
        if (!payload.project) {
          setMessage(`找不到工作区 /p/${key}，请从项目收藏打开或重新分析`);
          return;
        }
        const project = payload.project as AnalysisProject;
        const nextMarket = (project.marketplace in markets ? project.marketplace : "US") as MarketCode;
        setMarket(nextMarket);
        setActiveAsins(project.asins);
        replaceInputAsins(project.asins);
        setCurrentProjectId(project.id);
        setCurrentProjectName(project.name);
        if (project.name && project.categoryLabel && project.name !== project.categoryLabel && !project.name.startsWith(`${project.categoryLabel} ·`)) {
          setWorkspaceLabel(project.name);
        } else {
          setWorkspaceLabel("");
        }
        void readHistoricalSyncPointer(project).then(pointer => {
          if (cancelled) return;
          const currentLocation = appLocationRef.current;
          const params = new URLSearchParams(currentLocation.search);
          params.delete("asins");
          params.delete("project");
          if (pointer) {
            params.set("run", pointer.runId);
            params.set("syncJob", pointer.jobId);
            setSyncRunContext({ projectId: pointer.projectId, runId: pointer.runId });
          } else {
            setSyncRunContext(null);
          }
          const href = workspaceHref(project.slug, params);
          const current = `${currentLocation.pathname}${currentLocation.search ? `?${currentLocation.search}` : ""}`;
          if (current !== href) router.replace(href);
          if (workspaceKey) setHydratedWorkspaceKey(workspaceKey);
        });
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentProjectName(null);
          if (workspaceKey) setHydratedWorkspaceKey(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slugParam, projectParam, router, asinsParam, refreshRuntimeAnalysisData, replaceInputAsins, setMessage, workspaceKey, appLocationRef, runtimeAnalysisRequestRef, setActiveAsins, setCurrentProjectId, setCurrentProjectName, setHydratedWorkspaceKey, setMarket, setRuntimeAnalysisData, setStageOutputReceipt, setSyncAsins, setSyncRunContext, setTerminalPointerRetained, setTerminalSyncJob, setWorkspaceLabel]);

  useEffect(() => {
    if (!syncJobId || !workspaceReady || activeAsins.length === 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setMessage(`基础/MCP同步已启动，${activeAsins.length}个VOC待手工录入`);
    });
    return () => {
      cancelled = true;
    };
  }, [activeAsins.length, setMessage, syncJobId, workspaceReady]);

  return {  };
}
