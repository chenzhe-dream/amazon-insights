"use client";

import { ProjectMarketplaceSchema } from "../shared/project-marketplaces";


import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ManualAlexaVocListResponseSchema,
  type ManualAlexaVocRecord,
} from "../shared/agent-contracts";
import {
  abortManualVocRequests,
  createManualVocOverlayState,
  hydrationFailed,
  hydrationStarted,
  hydrationSucceeded,
  importSucceeded,
  manualVocOverlayKey,
  manualVocScopeChanged,
  reduceManualVoc,
  selectEffectiveVocByAsin,
  type ManualVocOverlayState,
  type ManualVocStatus,
  type OverlayRecord,
} from "./manual-alexa-voc-store";

type ManualVocFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function normalizedAsins(asins: readonly string[]) {
  return [...new Set(asins.map(asin => asin.trim().toUpperCase()).filter(asin => /^[A-Z0-9]{10}$/.test(asin)))].slice(0, 10);
}

async function readManualVocResponse(response: Response) {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : "Manual Alexa VOC 暂不可用";
    throw new Error(error);
  }
  const parsed = ManualAlexaVocListResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Manual Alexa VOC 响应格式无效");
  return parsed.data.records;
}

export type UseManualAlexaVocInput = Readonly<{
  projectId: string | null;
  sessionIdentity: string;
  organizationId: string;
  marketplace: string;
  asins: readonly string[];
  enabled?: boolean;
  request?: ManualVocFetch;
}>;

export type UseManualAlexaVocResult = Readonly<{
  state: ManualVocOverlayState;
  effectiveVocByAsin: Readonly<Record<string, OverlayRecord | null>>;
  statusByAsin: Readonly<Record<string, ManualVocStatus | undefined>>;
  onImported: (record: ManualAlexaVocRecord) => boolean;
  refresh: () => Promise<void>;
}>;

export function useManualAlexaVoc(input: UseManualAlexaVocInput): UseManualAlexaVocResult {
  const enabled = (input.enabled ?? true) && ProjectMarketplaceSchema.safeParse(input.marketplace).success && Boolean(input.projectId);
  const activeProjectId = enabled ? input.projectId : null;
  const request = input.request ?? fetch;
  const asinKey = useMemo(() => normalizedAsins(input.asins).join(","), [input.asins]);
  const scopedAsins = useMemo(() => asinKey ? asinKey.split(",") : [], [asinKey]);
  const [state, setState] = useState(() => createManualVocOverlayState(
    input.sessionIdentity,
    input.organizationId,
    1,
    input.marketplace,
    activeProjectId,
  ));
  const stateRef = useRef(state);
  const requestsRef = useRef(new Map<number, AbortController>());
  const currentScopeRef = useRef({
    sessionIdentity: input.sessionIdentity,
    organizationId: input.organizationId,
    marketplace: input.marketplace,
    projectId: activeProjectId,
  });

  const apply = useCallback((action: Parameters<typeof reduceManualVoc>[1]) => {
    const next = reduceManualVoc(stateRef.current, action);
    stateRef.current = next;
    setState(next);
    return next;
  }, []);

  useLayoutEffect(() => {
    currentScopeRef.current = {
      sessionIdentity: input.sessionIdentity,
      organizationId: input.organizationId,
      marketplace: input.marketplace,
      projectId: activeProjectId,
    };
    const current = stateRef.current;
    if (
      current.identity === input.sessionIdentity
      && current.organizationId === input.organizationId
      && current.marketplace === input.marketplace
      && current.projectId === activeProjectId
    ) return;
    abortManualVocRequests(requestsRef.current);
    apply(manualVocScopeChanged(input.sessionIdentity, input.organizationId, input.marketplace, activeProjectId));
  }, [activeProjectId, apply, input.marketplace, input.organizationId, input.sessionIdentity]);

  const refreshAsins = useCallback(async (requestedAsins: readonly string[]) => {
    const asins = normalizedAsins(requestedAsins);
    const current = stateRef.current;
    const projectId = input.projectId;
    if (!enabled || !projectId || asins.length === 0) return;
    const liveScope = currentScopeRef.current;
    if (
      current.identity !== input.sessionIdentity
      || current.organizationId !== input.organizationId
      || current.marketplace !== input.marketplace
      || current.projectId !== projectId
      || liveScope.projectId !== projectId
    ) return;

    const requestGeneration = current.requestGeneration + 1;
    const context = {
      sessionOrgEpoch: current.sessionOrgEpoch,
      requestGeneration,
      scope: { organizationId: input.organizationId, marketplace: ProjectMarketplaceSchema.parse(input.marketplace) },
    };
    const controller = new AbortController();
    requestsRef.current.set(requestGeneration, controller);
    apply(hydrationStarted({ ...context, asins }));

    const query = new URLSearchParams({ projectId, marketplace: ProjectMarketplaceSchema.parse(input.marketplace) });
    for (const asin of asins) query.append("asins", asin);
    try {
      const response = await request(`/api/alexa-voc?${query.toString()}`, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      const records = await readManualVocResponse(response);
      if (controller.signal.aborted) return;
      const activeScope = currentScopeRef.current;
      if (
        activeScope.sessionIdentity !== input.sessionIdentity
        || activeScope.organizationId !== input.organizationId
        || activeScope.marketplace !== input.marketplace
        || activeScope.projectId !== projectId
      ) return;
      apply(hydrationSucceeded({ ...context, requestedAsins: asins, records }));
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      const activeScope = currentScopeRef.current;
      if (
        activeScope.sessionIdentity !== input.sessionIdentity
        || activeScope.organizationId !== input.organizationId
        || activeScope.marketplace !== input.marketplace
        || activeScope.projectId !== projectId
      ) return;
      apply(hydrationFailed({ ...context, asins }));
    } finally {
      if (requestsRef.current.get(requestGeneration) === controller) {
        requestsRef.current.delete(requestGeneration);
      }
    }
  }, [apply, enabled, input.marketplace, input.organizationId, input.projectId, input.sessionIdentity, request]);

  const refresh = useCallback(() => refreshAsins(scopedAsins), [refreshAsins, scopedAsins]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const refreshOnFocus = () => { void refresh(); };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [refresh]);

  useEffect(() => () => abortManualVocRequests(requestsRef.current), []);

  const onImported = useCallback((record: ManualAlexaVocRecord) => {
    const current = stateRef.current;
    const projectId = input.projectId;
    const activeScope = currentScopeRef.current;
    if (!enabled || !projectId || record.marketplace !== input.marketplace) return false;
    if (
      current.identity !== input.sessionIdentity
      || current.organizationId !== input.organizationId
      || current.marketplace !== input.marketplace
      || current.projectId !== projectId
      || activeScope.sessionIdentity !== input.sessionIdentity
      || activeScope.organizationId !== input.organizationId
      || activeScope.marketplace !== input.marketplace
      || activeScope.projectId !== projectId
    ) return false;
    const requestGeneration = current.requestGeneration + 1;
    apply(importSucceeded({
      sessionOrgEpoch: current.sessionOrgEpoch,
      requestGeneration,
      scope: { organizationId: input.organizationId, marketplace: ProjectMarketplaceSchema.parse(input.marketplace) },
      record,
    }));
    void refreshAsins([record.asin]);
    return true;
  }, [apply, enabled, input.marketplace, input.organizationId, input.projectId, input.sessionIdentity, refreshAsins]);

  const effectiveVocByAsin = useMemo(() => Object.fromEntries(scopedAsins.map(asin => [
    asin,
    enabled && state.projectId === input.projectId && ProjectMarketplaceSchema.safeParse(input.marketplace).success
      ? selectEffectiveVocByAsin(state, input.organizationId, ProjectMarketplaceSchema.parse(input.marketplace), asin, input.projectId)
      : null,
  ])), [enabled, input.marketplace, input.organizationId, input.projectId, scopedAsins, state]);

  const statusByAsin = useMemo(() => Object.fromEntries(scopedAsins.map(asin => [
    asin,
    enabled
      && state.projectId === input.projectId
      && ProjectMarketplaceSchema.safeParse(input.marketplace).success
      && state.marketplace === input.marketplace
      ? state.statusByKey.get(manualVocOverlayKey(input.organizationId, ProjectMarketplaceSchema.parse(input.marketplace), asin))
      : undefined,
  ])), [enabled, input.marketplace, input.organizationId, input.projectId, scopedAsins, state.marketplace, state.projectId, state.statusByKey]);

  return { state, effectiveVocByAsin, statusByAsin, onImported, refresh };
}
