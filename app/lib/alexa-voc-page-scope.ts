import type { ResumedSyncScopeStatus, SyncRunContext } from "./resumed-sync-scope";

export type AlexaVocPageScope = Readonly<{
  manualListProjectId: string | null;
  authoritativeImportScope: SyncRunContext | null;
  canPoll: boolean;
}>;

export function resolveAlexaVocPageScope(input: Readonly<{
  currentProjectId: string | null;
  workspaceReady: boolean;
  resumedSyncScope: Readonly<{
    status: ResumedSyncScopeStatus;
    context: SyncRunContext | null;
  }>;
}>): AlexaVocPageScope {
  if (!input.workspaceReady) {
    return {
      manualListProjectId: null,
      authoritativeImportScope: null,
      canPoll: false,
    };
  }
  const context = input.resumedSyncScope.status === "resolved"
    && input.resumedSyncScope.context?.projectId === input.currentProjectId
    ? input.resumedSyncScope.context
    : null;
  return {
    manualListProjectId: input.currentProjectId,
    authoritativeImportScope: context,
    canPoll: context !== null,
  };
}
