import type { SyncJob } from "./sync-progress-presentation";

const terminalStatuses = new Set(["completed", "completed-with-gaps", "failed"]);

export function publicationIsSettled(job: Pick<SyncJob, "publication">): boolean {
  return job.publication?.status !== "pending";
}

export function syncObservationKey(job: Pick<SyncJob, "jobId" | "jobVersion" | "status" | "publication">): string | null {
  // Output versions do not change for every running stage/module update.
  // Hydrate each active response; retain deduplication after completion.
  if (!terminalStatuses.has(job.status)) return null;
  if (!Number.isSafeInteger(job.jobVersion) || Number(job.jobVersion) < 1) return null;
  const publication = job.publication
    ? Object.fromEntries(Object.entries(job.publication).sort(([left], [right]) => left.localeCompare(right)))
    : null;
  return JSON.stringify([job.jobId, job.jobVersion, job.status, publication]);
}

export function terminalSyncIsQuiescent(job: Pick<SyncJob, "status" | "publication">, stageOutputsSettled: boolean): boolean {
  return terminalStatuses.has(job.status) && publicationIsSettled(job) && stageOutputsSettled;
}
