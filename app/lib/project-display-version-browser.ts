import { z } from "zod";

import { LocalDataStageOutputResponseSchema, ProjectableSyncStageSchema } from "../../shared/agent-contracts";
import { localAgentFetch } from "./local-agent-browser";
import type { StageOutputSnapshot } from "./stage-output-browser";

const versionResponseSchema = z.object({
  versionId: z.string().uuid(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  jobId: z.string().uuid(),
  marketplace: z.string(),
  asins: z.array(z.string()),
  catalog: z.array(z.unknown()),
  catalogEvidence: z.object({
    sourceKind: z.literal("generated-file"),
    sourceRef: z.literal("app/competitor-data.ts#refreshedCatalog"),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceUpdatedAt: z.string().datetime(),
    capturedAt: z.string().datetime(),
    sourceJobId: z.string().uuid().optional(),
  }).nullable().optional(),
  stageOutputs: z.record(z.string(), z.unknown()),
  gaps: z.array(z.object({ asin: z.string(), field: z.string(), reasonCode: z.string() })),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  sourceCompletedAt: z.string(),
  publishedAt: z.string(),
});

export type CurrentProjectDisplayVersion = Omit<z.infer<typeof versionResponseSchema>, "stageOutputs"> & {
  stageOutputs: StageOutputSnapshot;
};

type Scope = Readonly<{
  organizationId: string;
  projectId: string;
  marketplace: string;
  asins: readonly string[];
}>;

function sameAsins(left: readonly string[], right: readonly string[]) {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((asin, index) => asin === sortedRight[index]);
}

function parseStageOutputs(raw: Record<string, unknown>, identity: { projectId: string; runId: string; jobId: string }) {
  const stages = ProjectableSyncStageSchema.options;
  if (Object.keys(raw).length !== stages.length) throw new Error("当前报告阶段范围不完整");
  const snapshot: Partial<Record<typeof stages[number], StageOutputSnapshot[typeof stages[number]]>> = {};
  for (const stage of stages) {
    const value = raw[stage];
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("当前报告阶段结果无效");
    const item = value as Record<string, unknown>;
    if (item.stageStatus === "missing-output") {
      if (item.stage !== stage || item.reasonCode !== "OUTPUT_UNAVAILABLE") throw new Error("当前报告缺口无效");
      snapshot[stage] = { stage, stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" };
      continue;
    }
    const parsed = LocalDataStageOutputResponseSchema.safeParse(value);
    if (!parsed.success || parsed.data.stage !== stage || parsed.data.projectId !== identity.projectId
      || parsed.data.runId !== identity.runId || parsed.data.jobId !== identity.jobId) {
      throw new Error("当前报告阶段来源不匹配");
    }
    snapshot[stage] = parsed.data;
  }
  return snapshot as StageOutputSnapshot;
}

/** Reads an immutable published report. It never starts, repairs, or publishes a sync job. */
export async function readCurrentProjectDisplayVersion(
  scope: Scope,
  fetcher: (path: string) => Promise<Response> = localAgentFetch,
): Promise<CurrentProjectDisplayVersion | null> {
  const response = await fetcher(`/v1/local-data/projects/${encodeURIComponent(scope.projectId)}/current-display-version`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(response.status === 401 ? "登录已失效，请重新登录" : "当前报告读取失败，请稍后重试");
  const parsed = versionResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("当前报告格式无效");
  const version = parsed.data;
  if (version.organizationId !== scope.organizationId || version.projectId !== scope.projectId
    || version.marketplace !== scope.marketplace || !sameAsins(version.asins, scope.asins)) {
    throw new Error("当前报告与项目范围不匹配");
  }
  return { ...version, stageOutputs: parseStageOutputs(version.stageOutputs, version) };
}
