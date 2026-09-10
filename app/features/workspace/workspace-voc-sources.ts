"use client";

import { useMemo } from "react";
import { useManualAlexaVoc } from "../voc/use-manual-alexa-voc";
import { type ManualAlexaVocNormalizedRecord } from "../../../shared/agent-contracts";
import { placeholderProduct } from "../catalog/product-contracts";
import type { useWorkspaceInput } from "./workspace-input";
import type { useRuntimeDataState } from "./workspace-runtime";
import type { useWorkspaceResume } from "./workspace-resume";
import type { AuthenticatedWebSession } from "../../auth-session-gate";

type useWorkspaceVocSourcesInputs = Pick<ReturnType<typeof useWorkspaceInput>, "activeAsins" | "market">
  & Pick<ReturnType<typeof useRuntimeDataState>, "catalogItems">
  & Pick<ReturnType<typeof useWorkspaceResume>, "alexaVocPageScope">
  & { authSession: AuthenticatedWebSession };

export function useWorkspaceVocSources({ activeAsins, catalogItems, alexaVocPageScope, authSession, market }: useWorkspaceVocSourcesInputs) {
  const products = useMemo(
    () => activeAsins.map(asin => catalogItems.find(p => p.asin === asin) ?? placeholderProduct(asin)),
    [activeAsins, catalogItems]
  );

  const manualVoc = useManualAlexaVoc({
    projectId: alexaVocPageScope.manualListProjectId,
    sessionIdentity: authSession.sessionIdentity,
    organizationId: authSession.user.organizationId,
    marketplace: market,
    asins: activeAsins,
    enabled: !authSession.logoutPending,
  });

  const manualVocByAsin = useMemo<Readonly<Record<string, ManualAlexaVocNormalizedRecord | undefined>>>(
    () => Object.fromEntries(activeAsins.map(asin => [asin, manualVoc.effectiveVocByAsin[asin]?.normalizedRecord])),
    [activeAsins, manualVoc.effectiveVocByAsin],
  );

  return { products, manualVoc, manualVocByAsin };
}
