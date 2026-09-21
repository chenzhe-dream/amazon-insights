import { localAgentErrorMessage } from "./local-agent-browser";

type RepairScope = { asins: string[]; marketplace: string; projectId: string; parentJobId: string; imageAction?: {asin:string;action:"refresh"|"analyze"} };
type RepairResult = { noWork: true; message: string } | { jobId: string; scope: { projectId: string; runId: string } };

/** Keep terminal state intact until a matching job is admitted; fence navigation and duplicate clicks. */
export function createIncompleteSyncRepair(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  let pending = false;
  return async (scope: RepairScope, isCurrent: () => boolean): Promise<RepairResult | null> => {
    if (pending || !isCurrent()) return null;
    pending = true;
    try {
      const response = await fetchImpl("/v1/local-data/sync-asins", {
        method: "POST",
        body: JSON.stringify({ asins: scope.asins, marketplace: scope.marketplace, projectId: scope.projectId, parentJobId: scope.parentJobId, mode: "repair-incomplete", ...(scope.imageAction ? {imageAction:scope.imageAction} : {}) }),
      });
      const payload = await response.json();
      if (!isCurrent()) return null;
      if (!response.ok) throw new Error(localAgentErrorMessage(payload, "补抓启动失败"));
      if (payload?.noWork === true && typeof payload.message === "string" && !payload.jobId) {
        return { noWork: true, message: payload.message };
      }
      if (typeof payload?.jobId !== "string" || !payload.jobId || payload.scope?.projectId !== scope.projectId
        || typeof payload.scope?.runId !== "string" || !payload.scope.runId) throw new Error("补抓任务工作区无效");
      return { jobId: payload.jobId, scope: { projectId: payload.scope.projectId, runId: payload.scope.runId } };
    } finally {
      pending = false;
    }
  };
}
