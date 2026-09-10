import type { StageOutputEntry } from "./stage-output-browser";

// Both inputs must already have passed a scoped StageOutputOwner. This selects
// whole verified projections; it neither validates raw responses nor merges data.
export function selectVerifiedReviewSnapshot(current: StageOutputEntry | undefined, incoming: StageOutputEntry | undefined): StageOutputEntry | undefined {
  if (!current || current.stageStatus === "missing-output") return incoming ?? current;
  if (!incoming || incoming.stageStatus === "missing-output") return current;
  if (incoming.projectId !== current.projectId || incoming.runId !== current.runId || incoming.jobId !== current.jobId) return current;
  if (incoming.outputVersion <= current.outputVersion || incoming.jobVersion < current.jobVersion) return current;
  return incoming;
}
