export function createSyncStartGate() {
  let started = false;

  return () => {
    if (started) return false;
    started = true;
    return true;
  };
}

export type SyncJobRecoveryScope = {
  asins: string[];
  marketplace: string;
  projectId: string | null;
  runId: string | null;
};

export type RecoverableSyncJob = Pick<SyncJobRecoveryScope, "asins" | "marketplace"> & {
  scope?: Pick<SyncJobRecoveryScope, "projectId" | "runId">;
};

export function syncJobIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("syncJob")?.trim();
  return value || null;
}

export function searchWithSyncJobId(search: string, jobId: string): string {
  const params = new URLSearchParams(search);
  params.set("syncJob", jobId);
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function clearSyncJobFromSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("syncJob");
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function isSyncJobScopeMatch(job: RecoverableSyncJob, expected: SyncJobRecoveryScope): boolean {
  if (job.marketplace !== expected.marketplace) return false;
  if ((job.scope?.projectId ?? null) !== expected.projectId) return false;
  if ((job.scope?.runId ?? null) !== expected.runId) return false;
  const actualAsins = [...new Set(job.asins)].sort();
  const expectedAsins = [...new Set(expected.asins)].sort();
  return actualAsins.length === expectedAsins.length && actualAsins.every((asin, index) => asin === expectedAsins[index]);
}
