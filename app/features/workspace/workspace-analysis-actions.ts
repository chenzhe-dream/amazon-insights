"use client";

import { clearVocRunFromSearch } from "../../lib/voc-run-browser";
import { localAgentFetch, localAgentErrorMessage } from "../../lib/local-agent-browser";
import { clearSyncJobFromSearch, searchWithSyncJobId } from "../../lib/asin-sync-session";
import { type AnalysisProject } from "../projects/project-library-panel";
import { projectWorkspacePath, workspaceHref } from "../../lib/workspace-url";
import { inferAmazonMajorCategory } from "../../amazon-major-categories";
import { replaceAppUrl, setProjectParam, sameAsinSet, PROJECT_REGISTRATION_FAILURE } from "../projects/workspace-navigation";
import { type Product } from "../catalog/product-contracts";
import type { useProjectState } from "./project-state";
import type { useWorkspaceLocation } from "./workspace-location";
import type { useRuntimeDataState } from "./workspace-runtime";
import type { useWorkspaceResume } from "./workspace-resume";
import type { useWorkspaceInput } from "./workspace-input";
import type { useSyncSessionState } from "./sync-session-state";
import type { useVocRunState } from "./workspace-voc-run";
import type { createProjectApplication } from "./project-application";
import type { AuthenticatedWebSession } from "../../auth-session-gate";

type createAnalysisWorkspaceInputs = Pick<ReturnType<typeof useProjectState>, "currentProjectId">
  & Pick<ReturnType<typeof useWorkspaceLocation>, "slugParam" | "workspacePath">
  & Pick<ReturnType<typeof useRuntimeDataState>, "catalogItems">
  & Pick<ReturnType<typeof useWorkspaceResume>, "workspaceLabel">
  & Pick<ReturnType<typeof useWorkspaceInput>, "market">;

export function createAnalysisWorkspace({ currentProjectId, slugParam, workspacePath, catalogItems, workspaceLabel, market }: createAnalysisWorkspaceInputs) {
  const persistAsins = (values: string[], projectId: string | null = currentProjectId) => {
    const params = new URLSearchParams(window.location.search);
    if (slugParam) {
      params.delete("asins");
      params.delete("project");
      replaceAppUrl(params, workspacePath);
      return;
    }
    params.set("asins", values.join(","));
    setProjectParam(params, projectId);
    replaceAppUrl(params, "/");
  };

  const ensureAnalysisWorkspace = async (asins: string[]) => {
    const pool = asins
      .map(asin => catalogItems.find(item => item.asin === asin))
      .filter((item): item is Product => Boolean(item));
    const categoryHint =
      pool.find(item => item.subRankCategory && item.subRankCategory !== "等待同步")?.subRankCategory ?? "竞品分析";
    const alias = workspaceLabel.trim();

    if (currentProjectId) {
      try {
        const response = await localAgentFetch(`/v1/local-data/projects/${encodeURIComponent(currentProjectId)}`);
        const existing = ((await response.json()) as { project?: AnalysisProject }).project;
        if (
          response.ok &&
          existing &&
          (existing.marketplace || "US") === market &&
          sameAsinSet(existing.asins, asins)
        ) return existing;
      } catch {
        // 精确复用失败后走 list/create；绝不修改旧项目。
      }
    }

    try {
      const listed = await localAgentFetch("/v1/local-data/projects?kind=analysis").then(res => res.json());
      const same = (listed.projects as AnalysisProject[] | undefined)?.find(
        project => sameAsinSet(project.asins, asins) && (project.marketplace || "US") === market,
      );
      if (same) return same;

      const response = await localAgentFetch("/v1/local-data/projects", {
        method: "POST",
        body: JSON.stringify({
          kind: "analysis",
          name: alias || `${categoryHint} · ${market}`,
          alias: alias || undefined,
          categoryLabel: categoryHint,
          majorCategory: inferAmazonMajorCategory(pool),
          marketplace: market,
          asins,
        }),
      });
      if (!response.ok) return null;
      return (await response.json()).project as AnalysisProject;
    } catch {
      return null;
    }
  };

  return { persistAsins, ensureAnalysisWorkspace };
}

type createAnalysisRunInputs = Pick<ReturnType<typeof useWorkspaceLocation>, "activeTab" | "router">
  & Pick<ReturnType<typeof useWorkspaceInput>, "asinParse" | "setMessage" | "inputs" | "market" | "replaceInputAsins">
  & Pick<ReturnType<typeof useSyncSessionState>, "analysisStartInFlight" | "setSyncRunContext" | "syncSuppressedKey" | "autoSyncStartedKey" | "setTerminalSyncJob" | "setTerminalPointerRetained" | "setSyncAsins">
  & Pick<ReturnType<typeof useVocRunState>, "restoringVocRun" | "setVocRun" | "setSelectedReportIds">
  & Pick<ReturnType<typeof createAnalysisWorkspace>, "ensureAnalysisWorkspace">
  & Pick<ReturnType<typeof createProjectApplication>, "applyProject">
  & { authSession: AuthenticatedWebSession };

export function createAnalysisRun({
    activeTab, asinParse, setMessage, inputs, analysisStartInFlight: analysisStartInFlightRef,
    restoringVocRun: restoringVocRunRef, setVocRun, setSelectedReportIds, setSyncRunContext, ensureAnalysisWorkspace, market,
    authSession, applyProject, replaceInputAsins, syncSuppressedKey: syncSuppressedKeyRef,
    autoSyncStartedKey: autoSyncStartedKeyRef, setTerminalSyncJob, setTerminalPointerRetained, setSyncAsins, router,
  }: createAnalysisRunInputs) {
  const runAnalysis = async () => {
    let values: string[];
    if (activeTab === "overview") {
      if (!asinParse.canSubmit) return setMessage("请修正 ASIN 输入后再开始分析");
      values = [...asinParse.asins];
    } else {
      values = inputs.map(v => v.trim().toUpperCase()).filter(Boolean);
      if (values.length < 3) return setMessage("请至少输入 3 个竞品 ASIN");
      const invalid = values.find(v => !/^[A-Z0-9]{10}$/.test(v));
      if (invalid) return setMessage(`${invalid} 格式不正确，ASIN 应为 10 位字母或数字`);
      if (new Set(values).size !== values.length) return setMessage("请勿重复输入相同 ASIN");
    }
    if (analysisStartInFlightRef.current) return;
    analysisStartInFlightRef.current = true;
    try {
      const cleanParams = clearVocRunFromSearch(clearSyncJobFromSearch(window.location.search));
      cleanParams.delete("run");
      replaceAppUrl(cleanParams, window.location.pathname);
      restoringVocRunRef.current = null;
      setVocRun(null);
      setSelectedReportIds({});
      setSyncRunContext(null);
      const project = await ensureAnalysisWorkspace(values);
      if (!project?.id) throw new Error(PROJECT_REGISTRATION_FAILURE);
      let registrationResponse: Response;
      let registrationPayload: {
        project?: {
          id?: unknown;
          organizationId?: unknown;
          marketplace?: unknown;
          asins?: unknown;
        };
        error?: unknown;
      };
      try {
        registrationResponse = await localAgentFetch("/v1/projects", {
          method: "POST",
          headers: {
            "Idempotency-Key": `project-register:${project.id}`,
          },
          body: JSON.stringify({
            id: project.id,
            name: project.name,
            marketplace: market,
            asins: values,
          }),
        });
        registrationPayload = await registrationResponse.json() as typeof registrationPayload;
      } catch {
        throw new Error(PROJECT_REGISTRATION_FAILURE);
      }
      const registeredProject = registrationPayload.project;
      if (
        !registrationResponse.ok ||
        registeredProject?.id !== project.id ||
        registeredProject.organizationId !== authSession.user.organizationId ||
        registeredProject.marketplace !== market ||
        !Array.isArray(registeredProject.asins) ||
        !sameAsinSet(registeredProject.asins, values)
      ) {
        throw new Error(PROJECT_REGISTRATION_FAILURE);
      }
      const ownershipParams = new URLSearchParams(cleanParams);
      ownershipParams.delete("asins");
      ownershipParams.delete("project");
      replaceAppUrl(ownershipParams, projectWorkspacePath(project.slug));
      applyProject(
        { ...project, marketplace: market, asins: [...values] },
        { announce: false, normalizeInput: false, replace: true },
      );
      const response = await localAgentFetch("/v1/local-data/sync-asins", {
        method: "POST",
        body: JSON.stringify({
          asins: values,
          marketplace: "US",
          projectId: registeredProject.id,
        }),
      });
      const payload = await response.json() as {
        jobId?: unknown;
        scope?: { projectId?: unknown; runId?: unknown };
        error?: unknown;
      };
      if (
        !response.ok ||
        typeof payload.jobId !== "string" ||
        !payload.jobId ||
        payload.scope?.projectId !== registeredProject.id ||
        typeof payload.scope.runId !== "string" ||
        !payload.scope.runId
      ) {
        throw new Error(localAgentErrorMessage(payload, "启动同步失败"));
      }

      replaceInputAsins(values);
      syncSuppressedKeyRef.current = null;
      autoSyncStartedKeyRef.current = values.join(",");
      const finalParams = new URLSearchParams(searchWithSyncJobId(cleanParams, payload.jobId));
      finalParams.set("run", payload.scope.runId);
      finalParams.delete("asins");
      finalParams.delete("project");
      if (!project?.slug) {
        finalParams.set("asins", values.join(","));
      }
      const finalHref = workspaceHref(project?.slug, finalParams);
      replaceAppUrl(finalParams, projectWorkspacePath(project?.slug));
      setTerminalSyncJob(null);
      setTerminalPointerRetained(false);
      setSyncAsins(null);
      router.replace(finalHref);
      setSyncRunContext({
        projectId: registeredProject.id,
        runId: payload.scope.runId,
      });
      setMessage(`基础/MCP同步已启动，${values.length}个VOC待手工录入`);
      return;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "启动同步失败");
    } finally {
      analysisStartInFlightRef.current = false;
    }
  };

  return { runAnalysis };
}
