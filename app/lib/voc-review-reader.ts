import { isSyncJobScopeMatch } from "./asin-sync-session";
import { createStageOutputOwner, type StageOutputScope, type StageOutputSnapshot } from "./stage-output-browser";

export type VocReviewScope = StageOutputScope & { marketplace: string; asins: readonly string[] };

/** Page-owned, read-only projection reader; independent of progress UI lifetime. */
export function createVocReviewReader(
  scope: VocReviewScope,
  fetcher: (path: string, init?: RequestInit) => Promise<Response>,
  publish: (snapshot: StageOutputSnapshot) => void,
) {
  const owner = createStageOutputOwner(scope);
  const abort = new AbortController();
  let disposed = false;
  let inFlight = false;
  let settled = false;
  const missing = () => {
    const outcome = owner.missing("reviews");
    if (outcome.kind === "missing-output") { settled = true; publish(owner.snapshot()); }
  };
  return {
    async refresh() {
      if (disposed || inFlight || settled) return;
      inFlight = true;
      try {
        const response = await fetcher(`/v1/local-data/sync-asins/${encodeURIComponent(scope.jobId)}`, { signal: abort.signal, cache: "no-store" });
        const job = await response.json();
        if (disposed) return;
        if (!response.ok) { missing(); return; }
        if (job.jobId !== scope.jobId || !Array.isArray(job.asins) || !Array.isArray(job.stages) ||
          job.scope?.runId !== scope.runId ||
          !isSyncJobScopeMatch(job, { ...scope, asins: [...scope.asins] })) { settled = true; return; }
        if (!owner.observeJob(job).includes("reviews")) {
          if (["completed", "completed-with-gaps", "failed"].includes(job.status)) missing();
          return;
        }
        const output = await fetcher(`/v1/projects/${encodeURIComponent(scope.projectId)}/runs/${encodeURIComponent(scope.runId)}/sync-jobs/${encodeURIComponent(scope.jobId)}/stages/reviews/output`, { signal: abort.signal, cache: "no-store" });
        const payload = output.ok ? await output.json() : null;
        if (disposed) return;
        const result = output.ok ? owner.accept("reviews", payload) : owner.missing("reviews");
        if (result.kind === "applied" || result.kind === "missing-output") publish(owner.snapshot());
        settled = owner.outputsSettled({ ...job, stages: job.stages.filter((stage: { id: string }) => stage.id === "reviews") });
      } catch {
        if (!disposed) missing();
      } finally { inFlight = false; }
    },
    isSettled() { return settled || disposed; },
    dispose() { disposed = true; abort.abort(); owner.clear(); },
  };
}
