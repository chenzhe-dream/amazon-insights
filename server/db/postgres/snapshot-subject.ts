import { isDeepStrictEqual } from "node:util";

import type { QueryResultRow } from "pg";

import {
  AsinSchema,
  DateTimeSchema,
  EntityIdSchema,
  MarketplaceSchema,
} from "../../../shared/agent-contracts";
import {
  DataSnapshotSubjectNotFoundError,
  type DataSnapshotSubjectInput,
} from "../data-snapshot-repository";
import { PostgresQueryContext } from "./query-context";

interface TrustedSnapshotSubjectRow extends QueryResultRow {
  run_id: string;
  project_id: string;
  data_cutoff_at: Date | string;
  organization_id: string;
  marketplace: string;
  asins_json: unknown;
  actor_id: string;
  actor_organization_id: string;
  actor_status: string;
}

export interface TrustedSnapshotSubject {
  readonly runId: string;
  readonly projectId: string;
  readonly dataCutoffAt: string;
  readonly organizationId: string;
  readonly marketplace: string;
  readonly asins: readonly string[];
}

export function validateSnapshotSubjectInput(
  input: DataSnapshotSubjectInput,
): DataSnapshotSubjectInput {
  const expectedAsins = input.expectedAsins.map((asin) =>
    AsinSchema.parse(asin),
  );
  if (
    expectedAsins.length < 3 ||
    expectedAsins.length > 10 ||
    new Set(expectedAsins).size !== expectedAsins.length
  ) {
    throw new TypeError("Invalid expected snapshot ASIN identity");
  }
  return {
    actorId: EntityIdSchema.parse(input.actorId),
    actorOrganizationId: EntityIdSchema.parse(input.actorOrganizationId),
    runId: EntityIdSchema.parse(input.runId),
    expectedProjectId: EntityIdSchema.parse(input.expectedProjectId),
    expectedMarketplace: MarketplaceSchema.parse(input.expectedMarketplace),
    expectedAsins,
    expectedRunCutoffAt: canonicalizeDateTime(input.expectedRunCutoffAt),
  };
}

export async function requireSnapshotSubject(
  queries: PostgresQueryContext,
  input: DataSnapshotSubjectInput,
): Promise<TrustedSnapshotSubject> {
  const result = await queries.query<TrustedSnapshotSubjectRow>(
    `SELECT run.id AS run_id, run.project_id, run.data_cutoff_at,
            project.organization_id, project.marketplace, project.asins_json,
            actor.id AS actor_id,
            actor.organization_id AS actor_organization_id,
            actor.status AS actor_status
       FROM analysis_runs run
       JOIN projects project ON project.id = run.project_id
       JOIN users actor ON actor.id = $1
      WHERE run.id = $2
      FOR UPDATE OF run, project, actor`,
    [input.actorId, input.runId],
  );
  const trustedSubject = result.rows[0];
  const storedAsins = storedTextList(trustedSubject?.asins_json);
  const storedRunCutoffAt = storedDateTime(trustedSubject?.data_cutoff_at);
  if (
    !trustedSubject ||
    trustedSubject.actor_id !== input.actorId ||
    trustedSubject.actor_status !== "active" ||
    trustedSubject.actor_organization_id !== input.actorOrganizationId ||
    trustedSubject.organization_id !== input.actorOrganizationId ||
    trustedSubject.project_id !== input.expectedProjectId ||
    trustedSubject.marketplace !== input.expectedMarketplace ||
    !isDeepStrictEqual(storedAsins, input.expectedAsins) ||
    storedRunCutoffAt === null ||
    storedRunCutoffAt !== input.expectedRunCutoffAt
  ) {
    throw new DataSnapshotSubjectNotFoundError();
  }
  return {
    runId: trustedSubject.run_id,
    projectId: trustedSubject.project_id,
    dataCutoffAt: storedRunCutoffAt,
    organizationId: trustedSubject.organization_id,
    marketplace: trustedSubject.marketplace,
    asins: storedAsins,
  };
}

export function canonicalizeDateTime(value: string): string {
  return new Date(DateTimeSchema.parse(value)).toISOString();
}

export function mapDateTime(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string") return canonicalizeDateTime(value);
  throw new TypeError("Invalid stored snapshot timestamp");
}

export function sameDateTimeInstant(left: string, right: string): boolean {
  return new Date(left).getTime() === new Date(right).getTime();
}

function storedTextList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) => (typeof item === "string" ? item : ""));
}

function storedDateTime(value: unknown): string | null {
  try {
    return mapDateTime(value);
  } catch {
    return null;
  }
}
