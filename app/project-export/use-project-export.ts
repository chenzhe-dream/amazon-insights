"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ExportSectionId } from "./module-catalog";
import type { ModuleKey } from "../../shared/module-visibility-contracts";
import { resolveSnapshotSelection, type SnapshotSelection } from "./snapshot-navigation-catalog";
import { verifyExportEligibility, type ExportIdentity, type ExportRequest } from "./read-export-eligibility";
import { preparePageSnapshot } from "./page-snapshot-host";
import type { PageSnapshotSources } from "./read-page-snapshot-sources";
import { buildExportFileName, downloadExportHtml } from "./download-export-html";

type Receipt = { key: string } & (
  { kind: "ready"; content: PageSnapshotSources; html: string }
  | { kind: "error"; message: string }
);
export function useProjectExport(projectId: string, selection: SnapshotSelection, identity?: ExportIdentity, visibleModules?: readonly ModuleKey[]) {
  const resolved = resolveSnapshotSelection(selection, visibleModules);
  const moduleIds: readonly ExportSectionId[] = resolved.moduleIds;
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [confirmation, setConfirmation] = useState<{key:string;kind:"checking"|"error"|"sent";message?:string}|null>(null);
  const verification = useRef<AbortController | null>(null);
  const context = JSON.stringify({ projectId, selection: {pageIds: resolved.pageIds, includeVariants: resolved.includeVariants}, identity });
  const [scope, setScope] = useState({ context, generation: 0 });
  const generation = scope.context === context ? scope.generation : scope.generation + 1;
  // Each selection transition is a new preparation, including a return to an earlier selection.
  if (scope.context !== context) setScope({ context, generation });
  const key = JSON.stringify([context, generation, attempt]);
  const sessionIdentity = identity?.sessionIdentity, organizationId = identity?.organizationId;
  const modules = JSON.stringify(moduleIds);
  const pages = JSON.stringify(resolved.pageIds);
  const includeVariants = resolved.includeVariants;
  useLayoutEffect(() => () => { verification.current?.abort(); }, [key]);
  useEffect(() => {
    verification.current?.abort();
    if (!sessionIdentity || !organizationId || modules === "[]") return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("读取超时，请重试")), 60_000);
    let active = true;
    const request: ExportRequest = { libraryProjectId: projectId, moduleIds: JSON.parse(modules),
      selection: {pageIds: JSON.parse(pages), includeVariants},
      sessionIdentity, organizationId, signal: controller.signal };
    void preparePageSnapshot(request).then(({content,html}) => {
      if (active) setReceipt({ key, kind: "ready", content, html });
    }).catch(error => {
      if (active) setReceipt({ key, kind: "error", message: error instanceof Error ? error.message : "报告读取失败，请重试" });
    }).finally(() => clearTimeout(timer));
    return () => { active=false;clearTimeout(timer);controller.abort();verification.current?.abort(); };
  }, [key, projectId, modules, pages, includeVariants, sessionIdentity, organizationId]);

  const result = receipt?.key === key ? receipt : null;
  const confirmationState = confirmation?.key === key ? confirmation : null;
  const ready = result?.kind === "ready" ? result : null;
  async function download() {
    if (!ready || !identity || verification.current || confirmationState?.kind === "checking") return;
    const controller = new AbortController(); verification.current=controller;
    const timer=setTimeout(()=>controller.abort(new Error("资格核验超时，请重试")),60_000);
    setConfirmation({key,kind:"checking"});
    try {
      await verifyExportEligibility({ ...identity,libraryProjectId:projectId,moduleIds,
        selection:{pageIds:resolved.pageIds,includeVariants:resolved.includeVariants},signal:controller.signal },ready.content);
      controller.signal.throwIfAborted();
      downloadExportHtml(ready.html,buildExportFileName(ready.content.project.name,ready.content.project.marketplace,ready.content.capturedAt));
      setConfirmation({key,kind:"sent"});
    } catch(error) {
      if (!controller.signal.aborted || controller.signal.reason?.message === "资格核验超时，请重试") {
        const message = error instanceof Error ? error.message : "下载失败，请重试";
        setReceipt({key,kind:"error",message});
        setConfirmation({key,kind:"error",message});
      }
    } finally { clearTimeout(timer);if(verification.current===controller)verification.current=null; }
  }
  return {
    result, confirmation: confirmationState, download,
    preparing: Boolean(identity && moduleIds.length && !result),
    canDownload: Boolean(ready && moduleIds.length && confirmationState?.kind !== "checking" && confirmationState?.kind !== "error"),
    retry: () => { verification.current?.abort(); setAttempt(value=>value+1); },
  };
}
