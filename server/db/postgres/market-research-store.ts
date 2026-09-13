import { z } from "zod";
import {
  MarketOverviewReportSchema,
  MarketResearchIdempotencyKeySchema,
  MarketResearchIssueSchema,
  MarketResearchJobSchema,
  MarketResearchScopeSchema,
  type MarketResearchJob,
} from "../../../shared/market-research-contracts";
import {
  MarketResearchConflictError,
  type MarketResearchActor,
  type MarketResearchClaim,
  type MarketResearchRepository,
} from "../market-research-repository";
import { canonicalJsonSha256 } from "../../runtime/model-request-accounting";
import { PostgresQueryContext } from "./query-context";

const uuid = z.string().uuid();
const timestamp = z.string().datetime();
const owner = z.string().min(1).max(200);
const MAX_ATTEMPTS = 3;
type JobRow = {
  id: string; organization_id: string; created_by: string;
  scope_json: unknown; scope_hash: string; status: string; attempts: number;
  lease_owner_id: string | null; lease_generation: number;
  report_json: unknown | null; report_hash: string | null; error_json: unknown | null;
  created_at: Date | string; updated_at: Date | string;
};

function iso(value: Date | string): string {
  return timestamp.parse(value instanceof Date ? value.toISOString() : new Date(value).toISOString());
}

function mapJob(row: JobRow): MarketResearchJob {
  const scope = MarketResearchScopeSchema.parse(row.scope_json);
  const report = row.report_json === null ? null : MarketOverviewReportSchema.parse(row.report_json);
  if (canonicalJsonSha256(scope) !== row.scope_hash ||
      (report ? canonicalJsonSha256(report) !== row.report_hash : row.report_hash !== null)) {
    throw new Error("Stored market research data failed integrity validation");
  }
  return MarketResearchJobSchema.parse({
    id: row.id, scope, status: row.status, attempts: row.attempts,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    report, error: row.error_json === null ? null : MarketResearchIssueSchema.parse(row.error_json),
  });
}

function actor(input: MarketResearchActor): MarketResearchActor {
  return { organizationId: uuid.parse(input.organizationId), userId: uuid.parse(input.userId) };
}

function lease(input: { now: string; leaseUntil: string }): void {
  timestamp.parse(input.now); timestamp.parse(input.leaseUntil);
  if (Date.parse(input.leaseUntil) <= Date.parse(input.now)) throw new MarketResearchConflictError();
}

function claimIdentity(claim: MarketResearchClaim): void {
  actor(claim); uuid.parse(claim.job.id); owner.parse(claim.ownerId);
  z.number().int().positive().parse(claim.generation);
}

export class PostgresMarketResearchStore implements MarketResearchRepository {
  constructor(private readonly queries: PostgresQueryContext) {}

  private async activeActor(input: MarketResearchActor): Promise<boolean> {
    const result = await this.queries.query(
      "SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND status='active' FOR SHARE",
      [input.userId, input.organizationId],
    );
    return Boolean(result.rowCount);
  }

  async create(input: Parameters<MarketResearchRepository["create"]>[0]) {
    const identity = actor(input), scope = MarketResearchScopeSchema.parse(input.scope);
    uuid.parse(input.id); MarketResearchIdempotencyKeySchema.parse(input.idempotencyKey); timestamp.parse(input.now);
    const hash = canonicalJsonSha256(scope);
    return this.queries.transaction(async () => {
      if (!await this.activeActor(identity)) throw new MarketResearchConflictError();
      const inserted = await this.queries.query<JobRow>(
        `INSERT INTO market_research_jobs
          (id,organization_id,created_by,idempotency_key,scope_json,scope_hash,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,'queued',$7,$7)
         ON CONFLICT DO NOTHING RETURNING *`,
        [input.id, identity.organizationId, identity.userId, input.idempotencyKey, JSON.stringify(scope), hash, input.now],
      );
      if (inserted.rows[0]) return { job: mapJob(inserted.rows[0]), created: true };
      const existing = await this.queries.query<JobRow>(
        "SELECT * FROM market_research_jobs WHERE organization_id=$1 AND idempotency_key=$2",
        [identity.organizationId, input.idempotencyKey],
      );
      if (!existing.rows[0] || existing.rows[0].scope_hash !== hash) throw new MarketResearchConflictError();
      return { job: mapJob(existing.rows[0]), created: false };
    });
  }

  async find(input: Parameters<MarketResearchRepository["find"]>[0]) {
    const identity = actor(input); uuid.parse(input.id);
    const result = await this.queries.query<JobRow>(
      `SELECT job.* FROM market_research_jobs job
       JOIN users actor ON actor.id=$2 AND actor.organization_id=job.organization_id AND actor.status='active'
       WHERE job.organization_id=$1 AND job.id=$3`,
      [identity.organizationId, identity.userId, input.id],
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async list(input: MarketResearchActor) {
    const identity = actor(input);
    const result = await this.queries.query<JobRow>(
      `SELECT job.* FROM market_research_jobs job
       JOIN users actor ON actor.id=$2 AND actor.organization_id=job.organization_id AND actor.status='active'
       WHERE job.organization_id=$1 ORDER BY job.created_at DESC, job.id DESC LIMIT 30`,
      [identity.organizationId, identity.userId],
    );
    return result.rows.map(mapJob);
  }

  async retry(input: Parameters<MarketResearchRepository["retry"]>[0]) {
    const identity = actor(input); uuid.parse(input.id); timestamp.parse(input.now);
    return this.queries.transaction(async () => {
      if (!await this.activeActor(identity)) return null;
      const result = await this.queries.query<JobRow>(
        "SELECT * FROM market_research_jobs WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [identity.organizationId, input.id],
      );
      if (!result.rows[0]) return null;
      const job = mapJob(result.rows[0]);
      if (job.status !== "failed" || job.attempts >= MAX_ATTEMPTS || !job.error?.retryable ||
          !await this.activeActor({ organizationId: identity.organizationId, userId: result.rows[0].created_by })) {
        throw new MarketResearchConflictError();
      }
      const updated = await this.queries.query<JobRow>(
        "UPDATE market_research_jobs SET status='queued',error_json=NULL,updated_at=$3 WHERE organization_id=$1 AND id=$2 RETURNING *",
        [identity.organizationId, input.id, input.now],
      );
      return mapJob(updated.rows[0]!);
    });
  }

  async claim(input: Parameters<MarketResearchRepository["claim"]>[0]) {
    owner.parse(input.ownerId); lease(input);
    return this.queries.transaction(async () => {
      // A revoked actor must not leave the UI permanently queued or running.
      // An active lease is left to its owner; renew/finish already reject revocation.
      await this.queries.query(
        `WITH revoked AS (
           SELECT job.id FROM market_research_jobs job
           WHERE (job.status='queued' OR (job.status='running' AND job.lease_until <= $1))
             AND NOT EXISTS (
               SELECT 1 FROM users actor WHERE actor.id=job.created_by
                 AND actor.organization_id=job.organization_id AND actor.status='active'
             ) FOR UPDATE OF job SKIP LOCKED
         ) UPDATE market_research_jobs job SET status='failed',lease_owner_id=NULL,lease_until=NULL,updated_at=$1,
           error_json=jsonb_set($2::jsonb,'{retryable}',to_jsonb(job.attempts < $3))
           FROM revoked WHERE job.id=revoked.id`,
        [input.now, JSON.stringify({ dataset: "research", code: "authentication", message: "任务提交者当前不可用，已停止调研", retryable: false }), MAX_ATTEMPTS],
      );
      // Recover an abandoned final attempt without allowing another upstream call.
      await this.queries.query(
        `WITH exhausted AS (
           SELECT id FROM market_research_jobs WHERE status='running' AND lease_until <= $1 AND attempts >= $2
           FOR UPDATE SKIP LOCKED
         ) UPDATE market_research_jobs SET status='failed',lease_owner_id=NULL,lease_until=NULL,updated_at=$1,
           error_json=$3::jsonb WHERE id IN (SELECT id FROM exhausted)`,
        [input.now, MAX_ATTEMPTS, JSON.stringify({ dataset: "research", code: "interrupted", message: "任务多次中断，已停止自动重试，请新建调研任务", retryable: false })],
      );
      const result = await this.queries.query<JobRow>(
        `WITH candidate AS (
           SELECT job.id FROM market_research_jobs job
           JOIN users actor ON actor.id=job.created_by AND actor.organization_id=job.organization_id AND actor.status='active'
           WHERE (job.status='queued' OR (job.status='running' AND job.lease_until <= $1)) AND job.attempts < $4
           ORDER BY job.created_at,job.id FOR UPDATE OF job SKIP LOCKED LIMIT 1
         ) UPDATE market_research_jobs job SET status='running',attempts=job.attempts+1,
           lease_owner_id=$2,lease_generation=job.lease_generation+1,lease_until=$3,updated_at=$1
           FROM candidate WHERE job.id=candidate.id RETURNING job.*`,
        [input.now, input.ownerId, input.leaseUntil, MAX_ATTEMPTS],
      );
      const row = result.rows[0];
      return row ? {
        job: mapJob(row), organizationId: row.organization_id, userId: row.created_by,
        ownerId: row.lease_owner_id!, generation: row.lease_generation,
      } : null;
    });
  }

  async renew(input: Parameters<MarketResearchRepository["renew"]>[0]) {
    claimIdentity(input.claim); lease(input);
    return this.queries.transaction(async () => {
      if (!await this.activeActor(input.claim)) return false;
      const result = await this.queries.query(
        `UPDATE market_research_jobs SET lease_until=GREATEST(lease_until,$7::timestamptz),updated_at=$6
         WHERE id=$1 AND organization_id=$2 AND created_by=$3 AND lease_owner_id=$4 AND lease_generation=$5
           AND status='running' AND lease_until > $6`,
        [input.claim.job.id, input.claim.organizationId, input.claim.userId, input.claim.ownerId, input.claim.generation, input.now, input.leaseUntil],
      );
      return Boolean(result.rowCount);
    });
  }

  async finish(input: Parameters<MarketResearchRepository["finish"]>[0]) {
    claimIdentity(input.claim); timestamp.parse(input.now);
    const report = input.report === null ? null : MarketOverviewReportSchema.parse(input.report);
    const error = input.error === null ? null : MarketResearchIssueSchema.parse(input.error);
    if (Boolean(report) === Boolean(error)) throw new MarketResearchConflictError();
    const scopeHash = canonicalJsonSha256(MarketResearchScopeSchema.parse(input.claim.job.scope));
    if (report && canonicalJsonSha256(report.scope) !== scopeHash) throw new MarketResearchConflictError();
    const status = report ? (report.issues.length ? "partial" : "succeeded") : "failed";
    return this.queries.transaction(async () => {
      if (!await this.activeActor(input.claim)) return false;
      const result = await this.queries.query(
        `UPDATE market_research_jobs SET status=$7,report_json=$8::jsonb,report_hash=$9,
           error_json=CASE WHEN $10::jsonb IS NOT NULL AND attempts >= $12 THEN jsonb_set($10::jsonb,'{retryable}','false') ELSE $10::jsonb END,
           lease_owner_id=NULL,lease_until=NULL,updated_at=$6
         WHERE id=$1 AND organization_id=$2 AND created_by=$3 AND lease_owner_id=$4 AND lease_generation=$5
           AND status='running' AND lease_until > $6 AND scope_hash=$11`,
        [input.claim.job.id, input.claim.organizationId, input.claim.userId, input.claim.ownerId, input.claim.generation, input.now,
          status, report ? JSON.stringify(report) : null, report ? canonicalJsonSha256(report) : null,
          error ? JSON.stringify(error) : null, scopeHash, MAX_ATTEMPTS],
      );
      return Boolean(result.rowCount);
    });
  }
}
