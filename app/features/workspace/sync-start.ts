"use client";

import { useCallback, useEffect } from "react";
import { localAgentFetch } from "../../lib/local-agent-browser";
import { clearSyncJobFromSearch } from "../../lib/asin-sync-session";
import { replaceAppUrl, parseAsinsParam } from "../projects/workspace-navigation";
import type { useRuntimeRefresh } from "./workspace-runtime";
import type { useSyncSessionState } from "./sync-session-state";
import type { useWorkspaceResume } from "./workspace-resume";
import type { useTerminalSync } from "./terminal-sync";
import type { useRuntimeDataState } from "./workspace-runtime";
import type { useWorkspaceInput } from "./workspace-input";
import type { useWorkspaceLocation } from "./workspace-location";

type useSyncStartInputs = Pick<ReturnType<typeof useRuntimeRefresh>, "syncJobId">
  & Pick<ReturnType<typeof useSyncSessionState>, "terminalSyncJob" | "setTerminalPointerRetained" | "syncSuppressedKey" | "autoSyncStartedKey" | "syncAsins" | "setTerminalSyncJob" | "setSyncAsins">
  & Pick<ReturnType<typeof useWorkspaceResume>, "resumedSyncScope" | "workspaceReady">
  & Pick<ReturnType<typeof useTerminalSync>, "terminalOwnerFor">
  & Pick<ReturnType<typeof useRuntimeDataState>, "catalogItems">
  & Pick<ReturnType<typeof useWorkspaceInput>, "setMessage" | "setActiveAsins" | "replaceInputAsins">
  & Pick<ReturnType<typeof useWorkspaceLocation>, "asinsParam" | "slugParam">;

export function useSyncStart({
    syncJobId, terminalSyncJob, setTerminalPointerRetained, resumedSyncScope, workspaceReady,
    syncSuppressedKey: syncSuppressedKeyRef, terminalOwnerFor, autoSyncStartedKey: autoSyncStartedKeyRef, syncAsins,
    catalogItems, setTerminalSyncJob, setSyncAsins, setMessage, asinsParam, slugParam, setActiveAsins, replaceInputAsins,
  }: useSyncStartInputs) {
  const startSyncIfNeeded = useCallback(async (values: string[], { force = false } = {}) => {
    const key = values.join(",");
    if (values.length < 3) return false;
    if (syncJobId) {
      if (!force || !["completed", "completed-with-gaps", "failed"].includes(terminalSyncJob?.status ?? "")) return false;
      replaceAppUrl(clearSyncJobFromSearch(window.location.search), window.location.pathname);
      setTerminalPointerRetained(false);
    }
    if (!resumedSyncScope.canStart) return false;
    if (!workspaceReady) return false;
    if (!force && syncSuppressedKeyRef.current === key) return false;
    const terminalOwner = terminalOwnerFor(values);
    if (!force && terminalOwner.blocksAutomaticStart()) {
      syncSuppressedKeyRef.current = key;
      return false;
    }
    if (!force && autoSyncStartedKeyRef.current === key && syncAsins) return false;

    if (!force) {
      const pendingCatalog = values.filter(v => !catalogItems.some(p => p.asin === v)).length;
      let needsMcpSync = pendingCatalog > 0;
      try {
        const response = await localAgentFetch(`/v1/local-data/sync-asins?asins=${encodeURIComponent(key)}`);
        if (response.ok) {
          const payload = await response.json();
          needsMcpSync = Boolean(payload.needsSync);
        }
      } catch {
        needsMcpSync = pendingCatalog > 0;
      }
      if (!needsMcpSync) return false;
    }

    if (force) {
      terminalOwner.clearForExplicitStart();
      setTerminalSyncJob(null);
    }
    autoSyncStartedKeyRef.current = key;
    syncSuppressedKeyRef.current = null;
    setSyncAsins(values);
    setMessage(`已加入 ${values.length} 个竞品，后台正在全自动拉取数据（含 VOC）…`);
    return true;
  }, [syncAsins, catalogItems, setMessage, syncJobId, resumedSyncScope.canStart, terminalOwnerFor, terminalSyncJob?.status, workspaceReady, autoSyncStartedKeyRef, setSyncAsins, setTerminalPointerRetained, setTerminalSyncJob, syncSuppressedKeyRef]);

  useEffect(() => {
    const parsed = parseAsinsParam(asinsParam);
    if (slugParam) return;
    if (!parsed) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setActiveAsins(current => (current.join(",") === parsed.join(",") ? current : parsed));
      replaceInputAsins(parsed);
    });
    return () => {
      cancelled = true;
    };
  }, [asinsParam, replaceInputAsins, slugParam, setActiveAsins]);

  return { startSyncIfNeeded };
}
