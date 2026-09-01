import type { ResumedSyncScopeStatus, SyncRunContext } from "./resumed-sync-scope";

export type AlexaVocPageScope = Readonly<{
  manualListProjectId: string | null;
  authoritativeImportScope: SyncRunContext | null;
  canPoll: boolean;
}>;

export function resolveAlexaVocPageScope(input: Readonly<{
  currentProjectId: string | null;
  resumedSyncScope: Readonly<{
    status: ResumedSyncScopeStatus;
    context: SyncRunContext | null;
  }>;
}>): AlexaVocPageScope {
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
