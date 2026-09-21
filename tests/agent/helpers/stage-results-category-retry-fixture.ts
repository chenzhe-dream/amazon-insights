import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { createStageOutputOwner } from "../../../app/lib/stage-output-browser";
import { LocalDataStageOutputResponseSchema } from "../../../shared/agent-contracts";
import { runPostgresMigrations } from "../../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../../server/db/postgres/query-context";
import { PostgresSyncJobStore } from "../../../server/db/postgres/sync-job-store";
import type {
  ProjectableSyncStage,
  StageOutputDraft,
} from "../../../server/db/sync-job-repository";
import { SyncJobService } from "../../../server/services/sync-job-service";
import { collectSorftimeCategoryRecords } from "../../../scripts/build-sorftime-category-trend.mjs";
import { callSorftimeTool } from "../../../scripts/lib/sorftime-mcp-client.mjs";
import { projectStageOutput } from "../../../scripts/lib/sync-stage-output.mjs";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./postgres-test-container";

const ASIN = "B0TEST0001";
const NOW = "2026-08-26T09:00:00.000Z";
const LATER = "2026-08-26T09:00:01.000Z";
const RESUMED_AT = "2026-08-26T09:00:02.000Z";
const STAGES = [
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
] as const satisfies readonly ProjectableSyncStage[];

type CategoryOutcome = "CONNECT_TIMEOUT" | "success";

export type AcceptanceResult = Readonly<{
  jobId: string;
  categoryAttemptKinds: readonly string[];
  categoryDispatches: number;
  thirdDispatches: number;
  categoryReady: boolean;
  categoryGap: Readonly<{ state: "failed"; reasonCode: "CONNECT_TIMEOUT" }> | null;
  followingStageRan: boolean;
  visibleBeforePublication: readonly ProjectableSyncStage[];
  successfulModulesRemainVisible: boolean;
  globalReloadsBeforeAppliedPublication: number;
  stageOutputReadSideEffects: number;
  artifactHashesMatch: boolean;
  fixtureBuilds: number;
}>;

export type CategoryResumeResult = Readonly<{
  newIds: Readonly<{ jobs: number; runs: number; runStages: number }>;
  selectedStages: readonly string[];
  providerProbes: number;
}>;

type StoredRun = Readonly<{
  pool: Pool;
  service: SyncJobService;
  organizationId: string;
  projectId: string;
  runId: string;
}>;

type FixtureCounters = {
  providerDispatches: number;
  providerProbes: number;
  stageOutputReads: number;
  posts: number;
  builds: number;
  reloads: number;
};

type PhysicalAttempt = Readonly<{
  attemptKind: string;
  logicalOperationKey: string;
}>;

export async function createStageResultsCategoryRetryFixture(): Promise<{
  run(input: Readonly<{ category: readonly ["CONNECT_TIMEOUT", CategoryOutcome] }>): Promise<AcceptanceResult>;
  resumeCategory(jobId: string): Promise<CategoryResumeResult>;
  close(): Promise<void>;
}> {
  const postgres = await startPostgresTestContainer();
  const storedRuns = new Map<string, StoredRun>();
  const counters: FixtureCounters = {
    providerDispatches: 0,
    providerProbes: 0,
    stageOutputReads: 0,
    posts: 0,
    builds: 0,
    reloads: 0,
  };

  return {
    async run(input) {
      const scope = await createCanonicalRun(postgres);
      const category = await runCategoryTransport(input.category, {
        organizationId: scope.organizationId,
        jobId: scope.jobId,
        counters,
      });
      const outputs = stageOutputs(scope, category.ready);
      const stages = STAGES.map((stage) => ({
        id: stage,
        status: stage === "category" && !category.ready ? "failed" : "done",
        completedAt: LATER,
      }));
      const modules = STAGES.map((stage) => ({
        asin: ASIN,
        module: stage,
        status: stage === "category" && !category.ready ? "timeout" as const : "ready" as const,
        reason: stage === "category" && !category.ready ? "CONNECT_TIMEOUT" : null,
        updatedAt: LATER,
      }));
      const progressed = await scope.store.recordProgress({
        jobId: scope.jobId,
        leaseGeneration: scope.leaseGeneration,
        workerId: scope.workerId,
        recordedAt: LATER,
        currentStageId: "traffic",
        stages,
        modules,
        outputs,
        message: "Deterministic stage fixture persisted",
      });
      const completed = await scope.store.complete({
        jobId: scope.jobId,
        leaseGeneration: scope.leaseGeneration,
        workerId: scope.workerId,
        completedAt: LATER,
        message: "Deterministic acceptance fixture completed",
      });

      const owner = createStageOutputOwner({
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        runId: scope.runId,
        jobId: scope.jobId,
      });
      const requestedStages = owner.observeJob({
        jobId: scope.jobId,
        jobVersion: Number(completed.jobVersion),
        stages: completed.stages,
      });
      const sideEffectsBeforeReads = sideEffectCount(counters);
      for (const stage of requestedStages) {
        counters.stageOutputReads += 1;
        const output = await scope.service.readStageOutput({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          runId: scope.runId,
          jobId: scope.jobId,
          stage,
        });
        if (output) owner.accept(stage, LocalDataStageOutputResponseSchema.parse(output));
      }
      const stageOutputReadSideEffects = sideEffectCount(counters) - sideEffectsBeforeReads;
      const visible = owner.snapshot();
      const publicationView = await scope.service.readPublicationView(
        scope.jobId,
        scope.organizationId,
      );
      const categoryProjection = visible.category;
      const categoryGap = categoryProjection?.stageStatus === "failed" &&
          categoryProjection.gap.reasonCode === "CONNECT_TIMEOUT"
        ? { state: "failed" as const, reasonCode: "CONNECT_TIMEOUT" as const }
        : null;

      storedRuns.set(scope.jobId, {
        pool: scope.pool,
        service: scope.service,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        runId: scope.runId,
      });
      return {
        jobId: scope.jobId,
        categoryAttemptKinds: category.attemptKinds,
        categoryDispatches: category.dispatches,
        thirdDispatches: Math.max(0, category.dispatches - 2),
        categoryReady: category.ready,
        categoryGap,
        followingStageRan: progressed.stages.find((stage) => stage.id === "traffic")?.status === "done",
        visibleBeforePublication: STAGES.filter((stage) => visible[stage] !== undefined),
        successfulModulesRemainVisible: STAGES.filter((stage) => stage !== "category")
          .every((stage) => visible[stage]?.stageStatus === "done"),
        globalReloadsBeforeAppliedPublication: counters.reloads,
        stageOutputReadSideEffects,
        artifactHashesMatch: publicationView !== null && STAGES.every((stage) => {
          const output = visible[stage];
          return output !== undefined && "contentHash" in output &&
            publicationView.stageContentHashes[stage] === output.contentHash;
        }),
        fixtureBuilds: counters.builds,
      };
    },

    async resumeCategory(jobId) {
      const run = storedRuns.get(jobId);
      if (!run) throw new Error("Acceptance job is not available for resume");
      const before = await identityCounts(run.pool, jobId, run.projectId, run.runId);
      const probesBefore = counters.providerProbes;
      const resumed = await run.service.resume({
        jobId,
        organizationId: run.organizationId,
        actorId: null,
      });
      const after = await identityCounts(run.pool, jobId, run.projectId, run.runId);
      return {
        newIds: {
          jobs: after.jobs - before.jobs,
          runs: after.runs - before.runs,
          runStages: after.runStages - before.runStages,
        },
        selectedStages: resumed?.resumedStages ?? [],
        providerProbes: counters.providerProbes - probesBefore,
      };
    },

    async close() {
      await postgres.close();
    },
  };
}

async function createCanonicalRun(postgres: PostgresTestContainer) {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  const store = new PostgresSyncJobStore(new PostgresQueryContext(pool));
  const service = new SyncJobService(store, { bypassProviderReadiness: true, now: () => RESUMED_AT });
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const runStageId = randomUUID();
  const jobId = randomUUID();
  const workerId = `acceptance-worker-${jobId}`;
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Acceptance fixture owner', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Acceptance fixture project', 'US', $3::jsonb, $4, $5, $5)`,
    [projectId, organizationId, JSON.stringify([ASIN]), actorId, NOW],
  );
  await store.admit({
    jobId,
    organizationId,
    projectId,
    runId,
    actorId,
    fingerprint: `stage-results-category-retry:${jobId}`,
    asins: [ASIN],
    marketplace: "US",
    createdAt: NOW,
    currentStageId: "keywords",
    message: "Queued deterministic acceptance fixture",
    stages: STAGES.map((stage) => ({
      id: stage,
      label: stage,
      kind: "auto" as const,
      status: "pending",
      estimatedSeconds: 1,
    })),
    canonicalRun: { runId, stageId: runStageId, dataCutoffAt: NOW },
  });
  const lease = await store.claimNext({
    workerId,
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  if (!lease || lease.job.jobId !== jobId) throw new Error("Acceptance job was not claimed");
  return {
    pool,
    store,
    service,
    organizationId,
    projectId,
    runId,
    jobId,
    workerId,
    leaseGeneration: lease.leaseGeneration,
  };
}

function stageOutputs(
  scope: Readonly<{ organizationId: string; projectId: string; runId: string }>,
  categoryReady: boolean,
): readonly StageOutputDraft[] {
  const sourceByExport: Readonly<Record<string, Record<string, unknown>>> = {
    sifKeywordAnalysisData: { [ASIN]: { keywords: [{ keyword: "fixture" }] } },
    sifKeywordEnrichmentData: { fixture: { status: "ready" } },
    sorftimeReviewAnalysisData: { [ASIN]: { status: "ready" } },
    sorftimeRatingData: { [ASIN]: { status: "ready" } },
    sorftimeSalesTrendData: { [ASIN]: { status: "ready", volume: [] } },
    sorftimeFbaFeeData: { [ASIN]: { status: "ready" } },
    sorftimeListingContentData: { [ASIN]: { status: "ready", title: "Fixture" } },
    sorftimeCategoryTrendData: { node: { nodeId: "node", asins: [ASIN], status: "ready" } },
    sifListingTrafficRawByAsin: { [ASIN]: { overview: {} } },
    sifMonthlyTrafficRawByAsin: { [ASIN]: { dates: [] } },
  };
  return STAGES.map((stage) => projectStageOutput(stage, [ASIN], {
    ...scope,
    updatedAt: LATER,
    ...(stage === "category" && !categoryReady
      ? { stageStatus: "failed", gapReasonCode: "CONNECT_TIMEOUT" }
      : {}),
    readExport: (_file: string, exportName: string) => sourceByExport[exportName] ?? {},
  }) as StageOutputDraft);
}

async function runCategoryTransport(
  outcomes: readonly ["CONNECT_TIMEOUT", CategoryOutcome],
  input: Readonly<{ organizationId: string; jobId: string; counters: FixtureCounters }>,
) {
  const attempts: PhysicalAttempt[] = [];
  let categoryDispatches = 0;
  const resourceGovernor = {
    async run(request: {
      attemptKind: string;
      logicalOperationKey: string;
      operation(): Promise<Response>;
    }) {
      attempts.push({
        attemptKind: request.attemptKind,
        logicalOperationKey: request.logicalOperationKey,
      });
      return await request.operation();
    },
  };
  const fetchImpl = async (_request: URL | RequestInfo, init?: RequestInit) => {
    input.counters.providerDispatches += 1;
    const body = JSON.parse(String(init?.body)) as { params: { name: string } };
    if (body.params.name === "product_detail") {
      return mcpResponse({
        node_id: "123456789",
        subcategory: "Fixture category (Rank: 1)",
        top_category: "Fixture top (Rank: 2)",
      });
    }
    categoryDispatches += 1;
    const outcome = outcomes[Math.min(categoryDispatches - 1, outcomes.length - 1)];
    if (outcome === "CONNECT_TIMEOUT") throw providerFailure();
    return mcpResponse(["2026-08=10"]);
  };
  const callTool = (key: string, toolName: string, args: Record<string, unknown>) =>
    callSorftimeTool(key, toolName, args, {
      env: {
        NODE_ENV: "test",
        AGENT_SYNC_STAGE_ID: "category",
        AGENT_SYNC_JOB_ID: input.jobId,
        SORFTIME_MCP_ENDPOINT: "http://127.0.0.1:1/mcp",
      },
      organizationId: input.organizationId,
      jobId: input.jobId,
      resourceGovernor,
      fetchImpl,
    });
  let ready = false;
  const previousExitCode = process.exitCode;
  try {
    const result = await collectSorftimeCategoryRecords({
      key: "fixture-key",
      marketplace: "US",
      catalog: [{ asin: ASIN, subRankCategory: "Fixture category" }],
      existing: {},
      fetchedAt: "2026-08-26",
      jobId: input.jobId,
      callTool,
      wait: async () => {},
    });
    ready = result.records["123456789"]?.status === "ready";
  } catch (error) {
    if (outcomes[1] !== "CONNECT_TIMEOUT") throw error;
  } finally {
    process.exitCode = previousExitCode;
  }
  const categoryLogicalKey = attempts.find((attempt) =>
    attempt.logicalOperationKey !== attempts[0]?.logicalOperationKey
  )?.logicalOperationKey;
  return {
    ready,
    dispatches: categoryDispatches,
    attemptKinds: attempts
      .filter((attempt) => attempt.logicalOperationKey === categoryLogicalKey)
      .map((attempt) => attempt.attemptKind),
  };
}

function mcpResponse(data: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { data },
  }));
}

function providerFailure(): TypeError {
  const cause = Object.assign(new Error("provider fixture timed out"), {
    code: "UND_ERR_CONNECT_TIMEOUT",
  });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

function sideEffectCount(counters: FixtureCounters): number {
  return counters.providerDispatches + counters.providerProbes + counters.posts +
    counters.builds + counters.reloads;
}

async function identityCounts(pool: Pool, jobId: string, projectId: string, runId: string) {
  const result = await pool.query<{
    jobs: number;
    runs: number;
    run_stages: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM sync_jobs WHERE job_id = $1) AS jobs,
       (SELECT count(*)::integer FROM analysis_runs WHERE id = $3 AND project_id = $2) AS runs,
       (SELECT count(*)::integer FROM run_stages WHERE run_id = $3) AS run_stages`,
    [jobId, projectId, runId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Acceptance identity counts are unavailable");
  return { jobs: row.jobs, runs: row.runs, runStages: row.run_stages };
}
