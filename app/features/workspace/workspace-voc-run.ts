"use client";

import { useState, useRef, useMemo, useEffect } from "react";
import { type VocRunObservation, vocRunIdFromSearch, waitForVocRun, VocRunClientError, cancelVocRun, retryVocStage } from "../../lib/voc-run-browser";
import { type SavedAnalysisReportSelection, buildSavedAnalysisReportView, readSavedAnalysisReport, serializeSavedAnalysisReportView } from "../../lib/saved-analysis-reports";
import { savedReportStageLabels } from "../projects/workspace-navigation";
import type { useWorkspaceLocation } from "./workspace-location";
import type { useRuntimeRefresh } from "./workspace-runtime";
import type { AuthenticatedWebSession } from "../../auth-session-gate";
import type { useWorkspaceInput } from "./workspace-input";

export function useVocRunState() {
  const [vocRun, setVocRun] = useState<VocRunObservation | null>(null);

  const [selectedReportIds, setSelectedReportIds] = useState<SavedAnalysisReportSelection>({});

  const restoringVocRun = useRef<string | null>(null);

  const vocRestoreController = useRef<AbortController | null>(null);

  return { vocRun, setVocRun, selectedReportIds, setSelectedReportIds, restoringVocRun, vocRestoreController };
}

type useSavedReportViewInputs = Pick<ReturnType<typeof useVocRunState>, "vocRun" | "selectedReportIds">;

export function useSavedReportView({ vocRun, selectedReportIds }: useSavedReportViewInputs) {
  const savedReportView = useMemo(
    () => vocRun?.runId
      ? buildSavedAnalysisReportView(vocRun.runId, vocRun.reports, selectedReportIds)
      : null,
    [selectedReportIds, vocRun],
  );

  return { savedReportView };
}

type useVocRunRestoreInputs = Pick<ReturnType<typeof useWorkspaceLocation>, "appSearch">
  & Pick<ReturnType<typeof useVocRunState>, "restoringVocRun" | "vocRestoreController" | "setVocRun">
  & Pick<ReturnType<typeof useRuntimeRefresh>, "runtimeSessionKey">
  & { authSession: AuthenticatedWebSession };

export function useVocRunRestore({
    appSearch, authSession, restoringVocRun: restoringVocRunRef, vocRestoreController: vocRestoreControllerRef, setVocRun,
    runtimeSessionKey,
  }: useVocRunRestoreInputs) {
  useEffect(() => {
    const runId = vocRunIdFromSearch(appSearch);
    if (authSession.logoutPending || !runId || restoringVocRunRef.current === runId) return;
    restoringVocRunRef.current = runId;
    const controller = new AbortController();
    vocRestoreControllerRef.current = controller;
    void waitForVocRun(runId, { signal: controller.signal, onObservation: (observation) => {
      if (!controller.signal.aborted) setVocRun(observation);
    } })
      .catch((error) => { if (!controller.signal.aborted) setVocRun({
        kind: "failed",
        runId,
        stage: null,
        report: null,
        reports: [],
        message: error instanceof Error ? error.message : "Unable to restore VOC run",
      }); });
    return () => {
      controller.abort();
      if (restoringVocRunRef.current === runId) restoringVocRunRef.current = null;
    };
  }, [appSearch, runtimeSessionKey, authSession.logoutPending, restoringVocRunRef, setVocRun, vocRestoreControllerRef]);

  return {  };
}

type createVocReportActionsInputs = Pick<ReturnType<typeof useVocRunState>, "setVocRun" | "vocRun" | "setSelectedReportIds">
  & Pick<ReturnType<typeof useWorkspaceInput>, "setMessage">
  & Pick<ReturnType<typeof useSavedReportView>, "savedReportView">;

export function createVocReportActions({ setVocRun, vocRun, setSelectedReportIds, setMessage, savedReportView }: createVocReportActionsInputs) {
  const continueVocRun = async (observation: VocRunObservation) => {
    setVocRun(observation);
    if (observation.kind === "active" && observation.runId) {
      setVocRun(await waitForVocRun(observation.runId, { onObservation: setVocRun }));
    }
  };

  const setVocActionFailure = (runId: string, error: unknown) => {
    setVocRun((current) => ({
      kind: error instanceof TypeError ? "offline" : error instanceof VocRunClientError ? error.kind : "failed",
      runId,
      stage: current?.stage ?? null,
      report: current?.report ?? null,
      reports: current?.reports ?? [],
      message: error instanceof TypeError
        ? "Agent Service is offline. Run: npm run agent:dev"
        : error instanceof Error ? error.message : "VOC run action failed",
    }));
  };

  const cancelCurrentVocRun = async () => {
    const runId = vocRun?.runId;
    if (!runId) return;
    try {
      await continueVocRun(await cancelVocRun(runId));
    } catch (error) {
      setVocActionFailure(runId, error);
    }
  };

  const retryCurrentVocStage = async () => {
    const runId = vocRun?.runId;
    if (!runId) return;
    try {
      await continueVocRun(await retryVocStage(runId));
    } catch (error) {
      setVocActionFailure(runId, error);
    }
  };

  const selectSavedReportVersion = async (
    stage: keyof typeof savedReportStageLabels,
    reportId: string,
  ) => {
    const runId = vocRun?.runId;
    if (!runId) return;
    try {
      const report = await readSavedAnalysisReport(reportId);
      if (report.runId !== runId || report.stage !== stage) {
        throw new Error("Saved report does not belong to this run and stage");
      }
      setVocRun((current) => current
        ? {
            ...current,
            reports: current.reports.map((candidate) => candidate.id === report.id ? report : candidate),
            report: stage === "voc-positioning" ? report : current.report,
          }
        : current);
      setSelectedReportIds((current) => ({ ...current, [stage]: report.id }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取已保存报告失败");
    }
  };

  const downloadSavedAnalysisReports = () => {
    if (!savedReportView) {
      setMessage("当前运行没有可导出的已保存报告");
      return;
    }
    const url = URL.createObjectURL(new Blob(
      [serializeSavedAnalysisReportView(savedReportView)],
      { type: "application/json" },
    ));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `analysis-run-${savedReportView.runId}-reports.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return { cancelCurrentVocRun, retryCurrentVocStage, selectSavedReportVersion, downloadSavedAnalysisReports };
}
