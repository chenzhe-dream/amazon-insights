"use client";

import { useState } from "react";
import type { useWorkspaceLocation } from "./workspace-location";

type useProjectStateInputs = Pick<ReturnType<typeof useWorkspaceLocation>, "projectParam">;

export function useProjectState({ projectParam }: useProjectStateInputs) {
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(projectParam);

  const [currentProjectName, setCurrentProjectName] = useState<string | null>(null);

  const [savingKeywordCompare, setSavingKeywordCompare] = useState(false);

  const [savingTrafficPromo, setSavingTrafficPromo] = useState(false);

  const [savingChecklist, setSavingChecklist] = useState(false);

  const [refreshingProjectId, setRefreshingProjectId] = useState<string | null>(null);

  return {
    currentProjectId, setCurrentProjectId, currentProjectName, setCurrentProjectName, savingKeywordCompare,
    setSavingKeywordCompare, savingTrafficPromo, setSavingTrafficPromo, savingChecklist, setSavingChecklist,
    refreshingProjectId, setRefreshingProjectId,
  };
}
