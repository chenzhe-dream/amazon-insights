import type { AnalysisProject } from "./project-library-panel";
import type { SyncJob } from "../sync/asin-sync-funnel";
import { localAgentFetch } from "../../lib/local-agent-browser";
import { isSyncJobScopeMatch } from "../../lib/asin-sync-session";

export type HistoricalSyncPointer = Readonly<{
  projectId: string;
  runId: string;
  jobId: string;
}>;

export async function readHistoricalSyncPointer(project: AnalysisProject): Promise<HistoricalSyncPointer | null> {
  try {
    const projectResponse = await localAgentFetch(`/v1/projects/${encodeURIComponent(project.id)}`);
    const projectPayload = await projectResponse.json() as {
      project?: { id?: unknown; currentRunId?: unknown };
    };
    const runId = projectPayload.project?.currentRunId;
    if (!projectResponse.ok || projectPayload.project?.id !== project.id || typeof runId !== "string" || !runId) {
      return null;
    }

    const runResponse = await localAgentFetch(`/v1/runs/${encodeURIComponent(runId)}`);
    const runPayload = await runResponse.json() as {
      run?: { id?: unknown; projectId?: unknown; idempotencyKey?: unknown };
    };
    const jobId = runPayload.run?.idempotencyKey;
    if (
      !runResponse.ok ||
      runPayload.run?.id !== runId ||
      runPayload.run?.projectId !== project.id ||
      typeof jobId !== "string" ||
      !jobId
    ) return null;

    const jobResponse = await localAgentFetch(`/v1/local-data/sync-asins/${encodeURIComponent(jobId)}`);
    const job = await jobResponse.json() as SyncJob;
    if (
      !jobResponse.ok ||
      job.jobId !== jobId ||
      job.scope?.runId !== runId ||
      !isSyncJobScopeMatch(
      { asins: job.asins ?? [], marketplace: job.marketplace ?? "", scope: job.scope },
      { asins: project.asins, marketplace: project.marketplace || "US", projectId: project.id, runId },
      )
    ) return null;

    return { projectId: project.id, runId, jobId };
  } catch {
    return null;
  }
}
