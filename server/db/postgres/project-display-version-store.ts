import { createHash, randomUUID } from "node:crypto";

import { LocalDataStageOutputResponseSchema } from "../../../shared/agent-contracts";
import type { PostgresQueryContext } from "./query-context";
import type { ProjectableSyncStage, StageOutputProjection } from "../sync-job-repository";

const stages: readonly ProjectableSyncStage[] = [
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
  "child_sales", "price_strategy", "image_remarks",
];
const perAsinFields: Partial<Record<ProjectableSyncStage, readonly string[]>> = {
  keywords: ["analysisByAsin"],
  reviews: ["analysisByAsin", "ratingByAsin"],
  sales_trend: ["trendByAsin"],
  fba: ["feeByAsin"],
  listing: ["contentByAsin"],
  traffic: ["listingByAsin", "monthlyByAsin"],
  child_sales: ["rowsByAsin"],
  price_strategy: ["strategyByAsin"],
  image_remarks: ["remarksByAsin"],
};

export type MissingDisplayStageOutput = Readonly<{
  stage: ProjectableSyncStage;
  stageStatus: "missing-output";
  reasonCode: "OUTPUT_UNAVAILABLE";
}>;
export type DisplayStageOutput = StageOutputProjection | MissingDisplayStageOutput;
export type ProjectDisplayGap = Readonly<{
  asin: string;
  field: string;
  reasonCode: string;
}>;
export type CurrentProjectDisplayVersion = Readonly<{
  versionId: string;
  organizationId: string;
  projectId: string;
  runId: string;
  jobId: string;
  marketplace: string;
  asins: readonly string[];
  catalog: readonly Record<string, unknown>[];
  stageOutputs: Readonly<Record<ProjectableSyncStage, DisplayStageOutput>>;
  gaps: readonly ProjectDisplayGap[];
  contentHash: string;
  sourceCompletedAt: string;
  publishedAt: string;
}>;
export type PublishProjectDisplayVersionInput = Readonly<{
  organizationId: string;
  projectId: string;
  jobId: string;
  expectedCurrentVersionId: string | null;
  catalog?: readonly unknown[];
  publishedAt?: string;
}>;

type ProjectRow = { id: string; organization_id: string; marketplace: string; asins_json: unknown; current_display_version_id: string | null };
type JobRow = { job_id: string; organization_id: string; project_id: string; run_id: string; marketplace: string; asins: unknown; status: string; created_at: Date | string; completed_at: Date | string | null };
type OutputRow = { job_id: string; organization_id: string; project_id: string; run_id: string; stage_id: string; stage_status: string; output_version: number; job_version: number; content_hash: string; data_json: unknown; gap_json: unknown; updated_at: Date | string };
type VersionRow = { id: string; organization_id: string; project_id: string; source_run_id: string; source_job_id: string; marketplace: string; asins_json: unknown; content_hash: string; body_json: unknown; source_completed_at: Date | string; published_at: Date | string };

export class ProjectDisplayVersionConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ProjectDisplayVersionConflictError"; }
}
export class StaleProjectDisplayCandidateError extends ProjectDisplayVersionConflictError {
  constructor() { super("Older sync job cannot replace the current display version"); this.name = "StaleProjectDisplayCandidateError"; }
}
export type ExpiredDisplayBodyCleanup = Readonly<{ purgedCount: number; imageUrls: readonly string[] }>;

function dateTime(value: Date | string | null): string {
  if (!value || Number.isNaN(new Date(value).getTime())) throw new ProjectDisplayVersionConflictError("Invalid display version timestamp");
  return new Date(value).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10 ||
      value.some(item => typeof item !== "string" || !/^[A-Z0-9]{10}$/.test(item)) ||
      new Set(value).size !== value.length) {
    throw new ProjectDisplayVersionConflictError("Display version ASIN scope is invalid");
  }
  return value;
}

function sameSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every(item => right.includes(item));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]));
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function scopedCatalog(value: readonly unknown[] | undefined, requestedAsins: readonly string[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ProjectDisplayVersionConflictError("Catalog must be an array");
  const seen = new Set<string>();
  return value.map(item => {
    const entry = record(item);
    const asin = entry.asin;
    if (typeof asin !== "string" || !requestedAsins.includes(asin) || seen.has(asin)) {
      throw new ProjectDisplayVersionConflictError("Catalog record is outside the project ASIN scope or duplicated");
    }
    seen.add(asin);
    return entry;
  });
}

function outputFromRow(row: OutputRow, expected: { organizationId: string; projectId: string; runId: string; jobId: string }): StageOutputProjection {
  if (row.organization_id !== expected.organizationId || row.project_id !== expected.projectId ||
      row.run_id !== expected.runId || row.job_id !== expected.jobId ||
      !stages.includes(row.stage_id as ProjectableSyncStage) ||
      !["done", "partial", "failed"].includes(row.stage_status)) {
    throw new ProjectDisplayVersionConflictError("Stage output ownership or state is invalid");
  }
  const data = row.data_json === null ? undefined : record(row.data_json);
  const gap = row.gap_json === null ? undefined : record(row.gap_json);
  if ((row.stage_status === "done" && (!data || gap)) ||
      (row.stage_status === "partial" && (!data || !gap || gap.state !== "partial")) ||
      (row.stage_status === "failed" && (data || !gap || gap.state !== "failed"))) {
    throw new ProjectDisplayVersionConflictError("Stage output branch is invalid");
  }
  const branch = { stage: row.stage_id, ...(data ? { data } : {}), ...(gap ? { gap } : {}) };
  if (hash(branch) !== row.content_hash) throw new ProjectDisplayVersionConflictError("Stage output hash mismatch");
  return LocalDataStageOutputResponseSchema.parse({
    stage: row.stage_id as ProjectableSyncStage,
    stageStatus: row.stage_status as StageOutputProjection["stageStatus"],
    projectId: expected.projectId, runId: expected.runId, jobId: expected.jobId,
    jobVersion: Number(row.job_version), outputVersion: Number(row.output_version),
    contentHash: row.content_hash, updatedAt: dateTime(row.updated_at),
    ...(data ? { data } : {}), ...(gap ? { gap: gap as StageOutputProjection["gap"] } : {}),
  }) as StageOutputProjection;
}

function gapsFor(asins: readonly string[], catalog: readonly Record<string, unknown>[], stageOutputs: Record<ProjectableSyncStage, DisplayStageOutput>): ProjectDisplayGap[] {
  const result: ProjectDisplayGap[] = [];
  const catalogAsins = new Set(catalog.map(item => item.asin));
  for (const asin of asins) if (!catalogAsins.has(asin)) result.push({ asin, field: "catalog", reasonCode: "OUTPUT_UNAVAILABLE" });
  for (const stage of stages) {
    const output = stageOutputs[stage];
    const fields = perAsinFields[stage] ?? [];
    if (output.stageStatus === "missing-output") {
      for (const asin of asins) result.push({ asin, field: stage, reasonCode: "OUTPUT_UNAVAILABLE" });
      continue;
    }
    if (output.stageStatus === "failed") {
      for (const asin of asins) result.push({ asin, field: stage, reasonCode: gapReason(output.gap, asin) });
      continue;
    }
    for (const field of fields) {
      const values = record(output.data?.[field]);
      for (const asin of asins) if (!Object.hasOwn(values, asin)) {
        result.push({ asin, field: `${stage}.${field}`, reasonCode: gapReason(output.gap, asin) });
      }
    }
  }
  return result.sort((left, right) => left.asin.localeCompare(right.asin) || left.field.localeCompare(right.field));
}

function gapReason(gap: StageOutputProjection["gap"] | undefined, asin: string): string {
  const item = gap?.items?.find(item => item.asin === asin);
  return typeof item?.causeCode === "string" ? item.causeCode : gap?.reasonCode ?? "OUTPUT_UNAVAILABLE";
}

function imageUrls(value: unknown): Set<string> {
  const urls = new Set<string>();
  const visit = (item: unknown, key = "") => {
    if (typeof item === "string") {
      if (/^https?:\/\/[^\s]+$/i.test(item) &&
          (/\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(item) ||
           /image|gallery|thumbnail|photo|media|^src$|^url$/i.test(key))) urls.add(item);
    } else if (Array.isArray(item)) item.forEach(entry => visit(entry, key));
    else if (item && typeof item === "object") {
      for (const [childKey, child] of Object.entries(item)) visit(child, childKey);
    }
  };
  visit(value);
  return urls;
}

function fromRow(row: VersionRow): CurrentProjectDisplayVersion {
  if (!row.body_json) throw new ProjectDisplayVersionConflictError("Current display version body was purged");
  const body = record(row.body_json);
  const view: CurrentProjectDisplayVersion = {
    versionId: row.id, organizationId: row.organization_id, projectId: row.project_id,
    runId: row.source_run_id, jobId: row.source_job_id, marketplace: row.marketplace,
    asins: asins(row.asins_json),
    catalog: Array.isArray(body.catalog) ? body.catalog as Record<string, unknown>[] : [],
    stageOutputs: body.stageOutputs as CurrentProjectDisplayVersion["stageOutputs"],
    gaps: body.gaps as ProjectDisplayGap[],
    contentHash: row.content_hash,
    sourceCompletedAt: dateTime(row.source_completed_at), publishedAt: dateTime(row.published_at),
  };
  if (!view.stageOutputs || !Array.isArray(view.gaps) || hash({
    organizationId: view.organizationId, projectId: view.projectId, runId: view.runId, jobId: view.jobId,
    marketplace: view.marketplace, asins: view.asins, catalog: view.catalog,
    stageOutputs: view.stageOutputs, gaps: view.gaps, sourceCompletedAt: view.sourceCompletedAt,
  }) !== view.contentHash) throw new ProjectDisplayVersionConflictError("Current display version hash mismatch");
  return view;
}

export class PostgresProjectDisplayVersionStore {
  constructor(private readonly queries: PostgresQueryContext) {}

  async readCurrent(scope: { organizationId: string; projectId: string }): Promise<CurrentProjectDisplayVersion | null> {
    const result = await this.queries.query<VersionRow>(`SELECT version.* FROM projects project
      JOIN project_display_versions version ON version.id = project.current_display_version_id
      WHERE project.id = $1 AND project.organization_id = $2 AND version.organization_id = $2 AND version.project_id = $1`,
    [scope.projectId, scope.organizationId]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async publishFromCompletedJob(input: PublishProjectDisplayVersionInput): Promise<CurrentProjectDisplayVersion> {
    return this.queries.transaction(async () => {
      const project = (await this.queries.query<ProjectRow>(`SELECT id,organization_id,marketplace,asins_json,current_display_version_id
        FROM projects WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [input.projectId, input.organizationId])).rows[0];
      if (!project) throw new ProjectDisplayVersionConflictError("Project not found in organization");
      if (project.current_display_version_id !== input.expectedCurrentVersionId) {
        throw new ProjectDisplayVersionConflictError("Current display version changed");
      }
      const job = (await this.queries.query<JobRow>(`SELECT job.job_id,job.organization_id,job.project_id,job.run_id,job.marketplace,
        job.asins,job.status,job.created_at,job.completed_at FROM sync_jobs job
        JOIN analysis_runs run ON run.id=job.run_id AND run.project_id=job.project_id
        WHERE job.job_id=$1 AND job.organization_id=$2 AND job.project_id=$3
        FOR UPDATE OF job`, [input.jobId, input.organizationId, input.projectId])).rows[0];
      if (!job || job.status !== "completed" || !job.completed_at || !job.run_id ||
          job.marketplace !== project.marketplace || !sameSet(asins(job.asins), asins(project.asins_json))) {
        throw new ProjectDisplayVersionConflictError("Completed sync job does not match the project scope");
      }
      const sourceCompletedAt = dateTime(job.completed_at);
      if (project.current_display_version_id) {
        const current = await this.readCurrent({ organizationId: input.organizationId, projectId: input.projectId });
        const currentJob = current && (await this.queries.query<{ created_at: Date | string }>(`SELECT created_at FROM sync_jobs
          WHERE job_id=$1 AND organization_id=$2 AND project_id=$3`,
        [current.jobId,input.organizationId,input.projectId])).rows[0];
        if (!current || !currentJob ||
            Date.parse(dateTime(job.created_at)) < Date.parse(dateTime(currentJob.created_at)) ||
            Date.parse(sourceCompletedAt) < Date.parse(current.sourceCompletedAt)) {
          throw new StaleProjectDisplayCandidateError();
        }
      }
      const prior = (await this.queries.query<VersionRow>(`SELECT * FROM project_display_versions
        WHERE project_id=$1 AND source_job_id=$2`, [input.projectId, input.jobId])).rows[0];
      if (prior) {
        if (prior.id === project.current_display_version_id) return fromRow(prior);
        throw new ProjectDisplayVersionConflictError("A retired sync job cannot be republished");
      }
      const outputs = (await this.queries.query<OutputRow>(`SELECT output.*,job.job_version FROM sync_job_stage_outputs output
        JOIN sync_jobs job ON job.job_id=output.job_id WHERE output.job_id=$1 ORDER BY output.stage_id`, [input.jobId])).rows;
      if (outputs.length !== stages.length) {
        throw new ProjectDisplayVersionConflictError("Completed sync job must have all 10 stage outputs");
      }
      if (!outputs.some(output => output.stage_status === "done" || output.stage_status === "partial")) {
        throw new ProjectDisplayVersionConflictError("Completed sync job has no usable stage data");
      }
      const stageOutputs = {} as Record<ProjectableSyncStage, DisplayStageOutput>;
      for (const stage of stages) stageOutputs[stage] = { stage, stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" };
      for (const output of outputs) {
        stageOutputs[output.stage_id as ProjectableSyncStage] = outputFromRow(output, {
          organizationId: input.organizationId, projectId: input.projectId,
          runId: job.run_id, jobId: input.jobId,
        });
      }
      const catalog = scopedCatalog(input.catalog, asins(job.asins));
      const gaps = gapsFor(asins(job.asins), catalog, stageOutputs);
      const body = { catalog, stageOutputs, gaps };
      const contentHash = hash({ organizationId: input.organizationId, projectId: input.projectId,
        runId: job.run_id, jobId: input.jobId, marketplace: job.marketplace, asins: asins(job.asins),
        ...body, sourceCompletedAt });
      const publishedAt = dateTime(input.publishedAt ?? new Date().toISOString());
      const versionId = randomUUID();
      await this.queries.query(`INSERT INTO project_display_versions
        (id,organization_id,project_id,source_run_id,source_job_id,marketplace,asins_json,content_hash,body_json,source_completed_at,published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11)`,
      [versionId,input.organizationId,input.projectId,job.run_id,input.jobId,job.marketplace,JSON.stringify(job.asins),contentHash,JSON.stringify(body),sourceCompletedAt,publishedAt]);
      if (project.current_display_version_id) {
        await this.queries.query(`UPDATE project_display_versions SET body_expires_at=$2::timestamptz + interval '24 hours'
          WHERE id=$1 AND organization_id=$3 AND project_id=$4 AND body_expires_at IS NULL`,
        [project.current_display_version_id,publishedAt,input.organizationId,input.projectId]);
      }
      const switched = await this.queries.query(`UPDATE projects SET current_display_version_id=$1
        WHERE id=$2 AND organization_id=$3 AND current_display_version_id IS NOT DISTINCT FROM $4 RETURNING id`,
      [versionId,input.projectId,input.organizationId,input.expectedCurrentVersionId]);
      if (switched.rowCount !== 1) throw new ProjectDisplayVersionConflictError("Current display version changed");
      return fromRow({ id: versionId, organization_id: input.organizationId, project_id: input.projectId,
        source_run_id: job.run_id, source_job_id: input.jobId, marketplace: job.marketplace,
        asins_json: job.asins, content_hash: contentHash, body_json: body,
        source_completed_at: sourceCompletedAt, published_at: publishedAt });
    });
  }

  async cleanupExpiredBodies(input: { now?: string; limit?: number } = {}): Promise<ExpiredDisplayBodyCleanup> {
    const now = dateTime(input.now ?? new Date().toISOString());
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Invalid cleanup limit");
    return this.queries.transaction(async () => {
      const expired = await this.queries.query<{ id: string; source_job_id: string; body_json: unknown }>(`SELECT version.id,version.source_job_id,version.body_json
        FROM project_display_versions version JOIN projects project ON project.id=version.project_id
        JOIN sync_jobs job ON job.job_id=version.source_job_id AND job.organization_id=version.organization_id
          AND job.project_id=version.project_id AND job.status='completed'
        WHERE version.body_json IS NOT NULL AND version.body_expires_at <= $1
          AND project.current_display_version_id IS DISTINCT FROM version.id
        ORDER BY version.body_expires_at,version.id LIMIT $2 FOR UPDATE OF version,job SKIP LOCKED`, [now,limit]);
      if (!expired.rows.length) return { purgedCount: 0, imageUrls: [] };
      const candidates = new Set(expired.rows.flatMap(row => [...imageUrls(row.body_json)]));
      const ids = expired.rows.map(row => row.id);
      const jobIds = expired.rows.map(row => row.source_job_id);
      await this.queries.query(`DELETE FROM sync_job_stage_outputs WHERE job_id=ANY($1::text[])`, [jobIds]);
      const purged = await this.queries.query<{ id: string }>(`UPDATE project_display_versions version
        SET body_json=NULL,body_purged_at=$1 WHERE version.id=ANY($2::text[]) RETURNING version.id`, [now,ids]);
      const retained = await this.queries.query<{ body_json: unknown }>(`SELECT body_json FROM project_display_versions WHERE body_json IS NOT NULL`);
      for (const row of retained.rows) for (const url of imageUrls(row.body_json)) candidates.delete(url);
      return { purgedCount: purged.rowCount ?? 0, imageUrls: [...candidates].sort() };
    });
  }
}
