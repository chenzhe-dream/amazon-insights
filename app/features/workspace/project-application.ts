"use client";

import { clearVocRunFromSearch } from "../../lib/voc-run-browser";
import { type AnalysisProject } from "../projects/project-library-panel";
import { workspaceHref } from "../../lib/workspace-url";
import { markets, type MarketCode } from "../catalog/product-contracts";
import type { useProjectState } from "./project-state";
import type { useWorkspaceInput } from "./workspace-input";
import type { useWorkspaceResume } from "./workspace-resume";
import type { useVocRunState } from "./workspace-voc-run";
import type { useSyncSessionState } from "./sync-session-state";
import type { useWorkspaceLocation } from "./workspace-location";

type createProjectApplicationInputs = Pick<ReturnType<typeof useProjectState>, "currentProjectId" | "setCurrentProjectId" | "setCurrentProjectName">
  & Pick<ReturnType<typeof useWorkspaceInput>, "setMarket" | "setActiveAsins" | "replaceInputAsins" | "setMessage">
  & Pick<ReturnType<typeof useWorkspaceResume>, "setWorkspaceLabel">
  & Pick<ReturnType<typeof useVocRunState>, "restoringVocRun" | "setVocRun" | "setSelectedReportIds">
  & Pick<ReturnType<typeof useSyncSessionState>, "setSyncAsins" | "setSyncRunContext" | "setTerminalSyncJob" | "setTerminalPointerRetained" | "setStageOutputReceipt">
  & Pick<ReturnType<typeof useWorkspaceLocation>, "router">;

export function createProjectApplication({
    currentProjectId, setMarket, setActiveAsins, replaceInputAsins, setCurrentProjectId, setCurrentProjectName,
    setWorkspaceLabel, restoringVocRun: restoringVocRunRef, setVocRun, setSelectedReportIds, setSyncAsins, setSyncRunContext,
    setTerminalSyncJob, setTerminalPointerRetained, setStageOutputReceipt, router, setMessage,
  }: createProjectApplicationInputs) {
  const applyProject = (
    project: AnalysisProject,
    options?: { announce?: boolean; normalizeInput?: boolean; replace?: boolean },
  ) => {
    const changingWorkspace = project.id !== currentProjectId;
    const nextMarket = (project.marketplace in markets ? project.marketplace : "US") as MarketCode;
    setMarket(nextMarket);
    setActiveAsins(project.asins);
    if (options?.normalizeInput !== false) replaceInputAsins(project.asins);
    setCurrentProjectId(project.id);
    setCurrentProjectName(project.name);
    if (project.name && project.categoryLabel && project.name !== project.categoryLabel && !project.name.startsWith(`${project.categoryLabel} ·`)) {
      setWorkspaceLabel(project.name);
    } else {
      setWorkspaceLabel("");
    }
    let params = new URLSearchParams(window.location.search);
    params.delete("asins");
    params.delete("project");
    if (changingWorkspace) {
      params.delete("run");
      params = clearVocRunFromSearch(params);
      params.delete("syncJob");
      restoringVocRunRef.current = null;
      setVocRun(null);
      setSelectedReportIds({});
      setSyncAsins(null);
      setSyncRunContext(null);
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      setStageOutputReceipt(null);
    }
    if (!project.slug) {
      params.set("asins", project.asins.join(","));
      params.set("project", project.id);
    }
    const href = workspaceHref(project.slug, params);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== href) {
      if (options?.replace) router.replace(href);
      else router.push(href);
    }
    if (options?.announce !== false) {
      setMessage(`已加载项目「${project.name}」· ${project.asins.length} 个 ASIN · ${project.slug ? `/p/${project.slug}` : ""}`);
    }
  };

  return { applyProject };
}
