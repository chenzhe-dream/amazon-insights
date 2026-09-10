"use client";

import { useEffect } from "react";
import { localAgentFetch } from "../../lib/local-agent-browser";
import type { useWorkspaceResume } from "./workspace-resume";
import type { useProjectState } from "./project-state";

type useProjectLibraryRefreshInputs = Pick<ReturnType<typeof useWorkspaceResume>, "setWorkspaces">
  & Pick<ReturnType<typeof useProjectState>, "currentProjectId">;

export function useProjectLibraryRefresh({ setWorkspaces, currentProjectId }: useProjectLibraryRefreshInputs) {
  useEffect(() => {
    localAgentFetch("/v1/local-data/projects?kind=analysis")
      .then(res => res.json())
      .then(payload => setWorkspaces(Array.isArray(payload.projects) ? payload.projects : []))
      .catch(() => setWorkspaces([]));
  }, [currentProjectId, setWorkspaces]);

  return {  };
}
