"use client";

import { useState, useMemo, useRef, useLayoutEffect } from "react";
import { localAgentFetch } from "../../lib/local-agent-browser";
import { type TrafficSnapshotClientState, trafficSnapshotBindingKey, createTrafficSnapshotOwner } from "../../lib/traffic-snapshot-browser";
import { trafficDisplayFromSnapshot } from "../../sif-listing-traffic-data";
import type { useWorkspaceInput } from "./workspace-input";
import type { useWorkspaceLocation } from "./workspace-location";
import type { useRuntimeRefresh } from "./workspace-runtime";
import type { AuthenticatedWebSession } from "../../auth-session-gate";

type useTrafficSnapshotInputs = Pick<ReturnType<typeof useWorkspaceInput>, "market" | "activeAsins">
  & Pick<ReturnType<typeof useWorkspaceLocation>, "activeTab">
  & Pick<ReturnType<typeof useRuntimeRefresh>, "baseSyncRunId">
  & { authSession: AuthenticatedWebSession };

export function useTrafficSnapshot({ authSession, market, activeAsins, activeTab, baseSyncRunId }: useTrafficSnapshotInputs) {
  const [trafficSnapshotReceipt, setTrafficSnapshotReceipt] = useState<{ key: string; state: TrafficSnapshotClientState } | null>(null);

  const trafficBindingKey = trafficSnapshotBindingKey({
    sessionIdentity: authSession.sessionIdentity, organizationId: authSession.user.organizationId,
    logoutPending: authSession.logoutPending, marketplace: market, asins: activeAsins,
    runId: activeTab === "traffic" ? baseSyncRunId : null,
  });

  const trafficSnapshotState = useMemo<TrafficSnapshotClientState>(() => !authSession.logoutPending && trafficSnapshotReceipt?.key === trafficBindingKey
    ? trafficSnapshotReceipt.state : { kind: "pending" }, [authSession.logoutPending, trafficBindingKey, trafficSnapshotReceipt]);

  const trafficSnapshotOwner = useRef<ReturnType<typeof createTrafficSnapshotOwner> | null>(null);

  const asinScopeKey = activeAsins.join(",");

  useLayoutEffect(() => {
    const owner = trafficSnapshotOwner.current ??= createTrafficSnapshotOwner({
      sessionIdentity: authSession.sessionIdentity,
      organizationId: authSession.user.organizationId,
      logoutPending: authSession.logoutPending,
      runId: null,
      marketplace: market,
      asins: activeAsins,
      request: (path) => localAgentFetch(path),
      onState: (state, key) => setTrafficSnapshotReceipt({ state, key }),
    });
    if (activeTab !== "traffic" || !baseSyncRunId || activeAsins.length === 0) {
      owner.rebind({ sessionIdentity: authSession.sessionIdentity, organizationId: authSession.user.organizationId, logoutPending: authSession.logoutPending, runId: null, marketplace: market, asins: activeAsins });
      return;
    }
    owner.rebind({ sessionIdentity: authSession.sessionIdentity, organizationId: authSession.user.organizationId, logoutPending: authSession.logoutPending, runId: baseSyncRunId, marketplace: market, asins: activeAsins });
    void owner.refresh().catch(() => undefined);
    const timer = window.setInterval(() => void owner.refresh().catch(() => undefined), 5_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [activeAsins, activeTab, asinScopeKey, authSession.logoutPending, authSession.sessionIdentity, authSession.user.organizationId, baseSyncRunId, market]);

  const trafficData = useMemo(
    () => trafficSnapshotState.kind === "dynamic" ? trafficDisplayFromSnapshot(trafficSnapshotState.snapshot) : undefined,
    [trafficSnapshotState],
  );

  const trafficOrigin = trafficSnapshotState.kind === "dynamic"
    ? "dynamic" as const
    : trafficSnapshotState.kind === "legacy" ? "legacy" as const : "pending" as const;

  return { trafficBindingKey, trafficSnapshotState, trafficSnapshotOwner, trafficData, trafficOrigin };
}
