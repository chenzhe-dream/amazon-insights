import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ConnectorError,
  type ConnectorResult,
  type RemoteMcpConnector,
} from "../connectors/connector-contract";
import {
  buildTrafficSnapshotCandidate,
  type TrafficDataSnapshotRecord,
  type TrafficSnapshotSource,
} from "../data/traffic-data-snapshot";
import type { RuntimeAgentRepository } from "../db/repository";
import {
  buildCollectedTrafficAnalysisInput,
  type CollectedTrafficRecord,
} from "../domain/traffic/traffic-analysis-contracts";
import { canonicalJsonSha256 } from "../runtime/model-request-accounting";
import { WorkerTaskError } from "../runtime/retry-policy";
import { normalizeListingDetails, listingContentId } from './traffic-listing-collection';
import { TrafficListingCollectionSchema, type TrafficListingRecord } from '../../shared/traffic-listing-contract';

const OverviewDistributionSchema = z.object({
  score: z.number().finite().nonnegative(),
  ratio: z.number().finite().nonnegative(),
});

const ListingOverviewSchema = z.object({
  overview: z.object({
    nf: OverviewDistributionSchema,
    ad: OverviewDistributionSchema,
  }),
  ad: z.record(z.string(), z.object({
    name: z.string().optional(),
    score: z.number().finite().nonnegative(),
    ratio: z.number().finite().nonnegative(),
  })).default({}),
  recommend: z.record(z.string(), z.object({
    name: z.string().min(1),
    score: z.number().finite().nonnegative(),
    ratio: z.number().finite().nonnegative(),
  })).default({}),
  total: z.number().finite().nonnegative(),
});
type ListingOverview = z.output<typeof ListingOverviewSchema>;

const ListingStructureSchema = z.object({
  chars: z.object({
    dims: z.array(z.object({
      ratio: z.number().finite().nonnegative(),
    })),
  }),
});

const MonthlyTrafficPointsSchema = z.array(z.object({
  score: z.number().finite().nonnegative(),
}).nullable()).max(24);

const MonthlyTrendFetchedAtSchema = z.iso.date();

const MonthlyTrendSchema = z.union([z.strictObject({
  dates: z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).max(24),
  nfScore: MonthlyTrafficPointsSchema,
  adScore: MonthlyTrafficPointsSchema,
  data_notice: z.string().optional(),
  fetchedAt: MonthlyTrendFetchedAtSchema.optional(),
}), z.strictObject({
  dates: z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).max(24),
  nf: MonthlyTrafficPointsSchema,
  ad: MonthlyTrafficPointsSchema,
  data_notice: z.string().optional(),
  fetchedAt: MonthlyTrendFetchedAtSchema.optional(),
})]).refine((value) => value.dates.length ===
  ("nfScore" in value ? value.nfScore.length : value.nf.length) &&
  value.dates.length ===
  ("adScore" in value ? value.adScore.length : value.ad.length),
).transform((value) => ({
  dates: value.dates,
  nfScore: "nfScore" in value ? value.nfScore : value.nf,
  adScore: "adScore" in value ? value.adScore : value.ad,
}));
type MonthlyTrend = z.output<typeof MonthlyTrendSchema>;

const MONTHLY_TREND_DIAGNOSTIC_FIELDS = [
  "dates",
  "nfScore",
  "adScore",
  "nf",
  "ad",
  "data_notice",
  "fetchedAt",
] as const;

const MONTHLY_TREND_CORE_SEQUENCE_FIELDS = [
  "nfScore",
  "adScore",
  "nf",
  "ad",
] as const;

type MonthlyTrendDiagnosticField =
  (typeof MONTHLY_TREND_DIAGNOSTIC_FIELDS)[number];
type MonthlyTrendCoreSequenceField =
  (typeof MONTHLY_TREND_CORE_SEQUENCE_FIELDS)[number];
type MonthlyTrendPointField = MonthlyTrendCoreSequenceField;
type ProjectedMonthlyTrendCandidate = Readonly<{
  dates?: unknown;
  nfScore?: unknown;
  adScore?: unknown;
  nf?: unknown;
  ad?: unknown;
  data_notice?: unknown;
  fetchedAt?: unknown;
}>;
type ProjectedListingOverviewCandidate = Readonly<{
  overview?: unknown;
  ad?: unknown;
  recommend?: unknown;
  total?: unknown;
}>;
type JsonShapeType =
  | "missing"
  | "null"
  | "array"
  | "object"
  | "string"
  | "number"
  | "boolean"
  | "non-json";
const JSON_SHAPE_TYPES = [
  "missing",
  "null",
  "array",
  "object",
  "string",
  "number",
  "boolean",
  "non-json",
] as const;
const JSON_CANDIDATE_TYPES = JSON_SHAPE_TYPES.filter((type) =>
  type !== "missing",
);
const MONTHLY_TREND_FIRST_INVALID_REASONS = [
  "type",
  "nonfinite",
  "negative",
  "length-mismatch",
  "unknown-shape",
] as const;
const LISTING_OVERVIEW_FIRST_INVALID_REASONS = [
  "type",
  "nonfinite",
  "negative",
  "unknown-shape",
] as const;
export type SifMonthlyTrendShapeDiagnostic = Readonly<{
  kind: "monthly-trend";
  candidateType: Exclude<JsonShapeType, "missing">;
  fields: Readonly<Record<MonthlyTrendDiagnosticField, Readonly<{
    present: boolean;
    type: JsonShapeType;
    arrayLength?: number;
  }>> & {
    fetchedAt: Readonly<{
      present: boolean;
      type: JsonShapeType;
      dateOnlyValid: boolean;
    }>;
  }>;
  coreLengthMismatch: Readonly<{
    field: MonthlyTrendCoreSequenceField;
    expectedLength: number;
    actualLength: number;
    firstInvalidIndex: number;
  }> | null;
  firstInvalid: Readonly<{
    field: MonthlyTrendDiagnosticField | "root";
    index: number | null;
    reason:
      | "type"
      | "nonfinite"
      | "negative"
      | "length-mismatch"
      | "unknown-shape";
  }> | Readonly<{
    field: MonthlyTrendDiagnosticField | "root";
    index: number | null;
    reason:
      | "type"
      | "nonfinite"
      | "negative"
      | "length-mismatch"
      | "unknown-shape";
    point: SifMonthlyTrendPointDiagnostic;
  }>;
}>;

type SifMonthlyTrendPointDiagnostic = Readonly<{
  type: "object";
  score: Readonly<{
    present: boolean;
    type: JsonShapeType;
  }>;
}> | Readonly<{
  type: "array" | "string" | "number" | "boolean" | "non-json";
}>;

const LISTING_OVERVIEW_DIAGNOSTIC_FIELDS = [
  "overview",
  "ad",
  "recommend",
  "total",
  "data_notice",
  "overview.nf",
  "overview.ad",
  "overview.nf.score",
  "overview.nf.ratio",
  "overview.ad.score",
  "overview.ad.ratio",
] as const;

type ListingOverviewDiagnosticField =
  (typeof LISTING_OVERVIEW_DIAGNOSTIC_FIELDS)[number];
type ListingOverviewDiagnosticFirstInvalidField =
  | ListingOverviewDiagnosticField
  | "root";
type ListingOverviewDiagnosticCandidate = Readonly<Record<string, unknown>>;
export type SifListingOverviewShapeDiagnostic = Readonly<{
  kind: "listing-overview";
  candidateType: Exclude<JsonShapeType, "missing">;
  fields: Readonly<Record<ListingOverviewDiagnosticField, Readonly<{
    present: boolean;
    type: JsonShapeType;
  }>>>;
  firstInvalid: Readonly<{
    field: ListingOverviewDiagnosticFirstInvalidField;
    reason: "type" | "nonfinite" | "negative" | "unknown-shape";
  }>;
}>;

export type SifTrafficShapeDiagnostic =
  | SifMonthlyTrendShapeDiagnostic
  | SifListingOverviewShapeDiagnostic;

type TrafficSubject = Readonly<{
  actorId: string;
  organizationId: string;
  projectId: string;
  runId: string;
  marketplace: "US";
  asins: readonly string[];
  dataCutoffAt: string;
}>;

type RequestEvidence = Extract<
  TrafficSnapshotSource,
  { connectorId: "sif" }
>["requests"][number];

export const SIF_TRAFFIC_SCHEMA_REASON_CODE =
  "SIF_TRAFFIC_SCHEMA_INVALID" as const;

export class SifTrafficSnapshotTaskError extends WorkerTaskError {
  readonly reasonCode = SIF_TRAFFIC_SCHEMA_REASON_CODE;
  readonly shapeDiagnostic?: SifTrafficShapeDiagnostic;

  constructor(
    readonly asin: string,
    readonly operation: RequestEvidence["operation"],
    shapeDiagnostic?: SifTrafficShapeDiagnostic,
  ) {
    super(
      "data-quality",
      `SIF traffic response validation failed: asin=${asin}; operation=${operation}; reasonCode=${SIF_TRAFFIC_SCHEMA_REASON_CODE}`,
    );
    this.name = "SifTrafficSnapshotTaskError";
    this.shapeDiagnostic = shapeDiagnostic
      ? copySifTrafficShapeDiagnostic(shapeDiagnostic)
      : undefined;
  }
}

export class SifTrafficSnapshotTask {
  readonly #repository: RuntimeAgentRepository;
  readonly #connector: RemoteMcpConnector;
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(options: {
    repository: RuntimeAgentRepository;
    connector: RemoteMcpConnector;
    clock?: () => Date;
    createId?: () => string;
  }) {
    if (options.connector.id !== "sif") {
      throw new TypeError("SIF traffic snapshot task requires the SIF connector");
    }
    this.#repository = options.repository;
    this.#connector = options.connector;
    this.#clock = options.clock ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  async createForRun(
    subject: TrafficSubject,
    signal?: AbortSignal,
  ): Promise<TrafficDataSnapshotRecord> {
    const existing = await this.#repository.listTrafficDataSnapshotsByRun({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
    });
    const persisted = existing.at(-1);
    if (persisted) return persisted;

    const listingEvidence: RequestEvidence[] = [];
    const monthlyEvidence: RequestEvidence[] = [];
    const records: CollectedTrafficRecord[] = [];
    const listingRecords: Record<string, TrafficListingRecord> = {};
    try {
      for (const asin of subject.asins) {
        const overviewResult = await this.#execute(
          subject,
          "ops_get_listing_traffic_overview",
          {
            asin,
            country: subject.marketplace,
            timePieceType: "latelyDay",
            timePieceValue: "30",
            isListingSearch: true,
          },
          signal,
        );
        const structureResult = await this.#execute(
          subject,
          "ops_get_listing_traffic_structure",
          {
            asin,
            country: subject.marketplace,
            timePieceType: "latelyDay",
            timePieceValue: "30",
            pageSize: 1000,
          },
          signal,
        );
        const monthlyResult = await this.#execute(
          subject,
          "ops_get_asin_traffic_trend",
          {
            asin,
            country: subject.marketplace,
            granularity: "month",
            lastMonths: 6,
            listingSearch: true,
          },
          signal,
        );
        const projectedMonthlyCandidate = projectMonthlyTrendCandidate(
          monthlyResult.data,
        );
        const monthly = parseTrafficOperation(
          asin,
          "ops_get_asin_traffic_trend",
          MonthlyTrendSchema,
          projectedMonthlyCandidate,
          monthlyResult.data,
        );
        const projectedOverviewCandidate = projectListingOverviewCandidate(
          overviewResult.data,
        );
        const overview = parseTrafficOperation(
          asin,
          "ops_get_listing_traffic_overview",
          ListingOverviewSchema,
          projectedOverviewCandidate,
          overviewResult.data,
        );
        const record = normalizeTrafficRecord(
          asin,
          overview,
          structureResult.data,
          monthly,
        );
        listingRecords[asin] = normalizeListingDetails(overviewResult.data, structureResult.data);
        listingEvidence.push(
          requestEvidence(
            asin,
            overviewResult,
            canonicalListingOverviewEvidence(record),
          ),
          requestEvidence(asin, structureResult),
        );
        monthlyEvidence.push(
          requestEvidence(asin, monthlyResult, monthly),
        );
        records.push(record);
      }
    } catch (error) {
      throw safeTaskError(error);
    }

    const trafficInput = buildCollectedTrafficAnalysisInput({
      marketplace: subject.marketplace,
      records,
      dataCutoffAt: subject.dataCutoffAt,
    });
    const sources = collectedSources(listingEvidence, monthlyEvidence);
    const createdAt = this.#now();
    const candidateId = this.#createId();
    const created = await this.#repository.createTrafficDataSnapshotForRun({
      actorId: subject.actorId,
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      expectedProjectId: subject.projectId,
      expectedMarketplace: subject.marketplace,
      expectedAsins: subject.asins,
      expectedRunCutoffAt: subject.dataCutoffAt,
      candidateId,
      createdAt,
      candidate: buildTrafficSnapshotCandidate({
        asins: subject.asins,
        trafficInput,
        sources,
        listingCollection: TrafficListingCollectionSchema.parse({ id: listingContentId({ records: listingRecords, capturedAt: listingEvidence.map(item => item.fetchedAt) }), schemaVersion: '1', source: 'sif', marketplace: subject.marketplace, period: '近30天', collectedAt: listingEvidence.map(item => item.fetchedAt).sort().at(-1), asins: [...subject.asins], records: listingRecords }),
      }),
    });
    const reopened = await this.#repository.findTrafficDataSnapshotById({
      actorOrganizationId: subject.organizationId,
      snapshotId: created.snapshot.id,
    });
    if (!reopened) {
      throw new WorkerTaskError(
        "infrastructure",
        "Persisted SIF traffic snapshot is unavailable",
      );
    }
    return reopened;
  }

  #execute(
    subject: TrafficSubject,
    operation: RequestEvidence["operation"],
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) {
    return this.#connector.execute({
      operation,
      input,
      governorScope: {
        organizationId: subject.organizationId,
        jobId: subject.runId,
      },
      ...(signal ? { signal } : {}),
    });
  }

  #now() {
    const value = this.#clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("Invalid SIF traffic snapshot task clock");
    }
    return value.toISOString();
  }
}

function normalizeTrafficRecord(
  asin: string,
  overview: ListingOverview,
  structureCandidate: ConnectorResult["data"],
  monthly: MonthlyTrend,
): CollectedTrafficRecord {
  const structure = parseTrafficOperation(
    asin,
    "ops_get_listing_traffic_structure",
    ListingStructureSchema,
    structureCandidate,
  );
  const labels: Readonly<Record<string, string>> = {
    sp: "SP(常规)",
    recommend: "SP(推荐)",
    sb: "SB(常规)",
    sbv: "SBV",
  };
  return {
    asin,
    total: Math.round(overview.total),
    natural: {
      score: Math.round(overview.overview.nf.score),
      ratio: ratioToPercentage(overview.overview.nf.ratio),
    },
    advertising: {
      score: Math.round(overview.overview.ad.score),
      ratio: ratioToPercentage(overview.overview.ad.ratio),
    },
    advertisingChannels: Object.entries(overview.ad)
      .filter(([, item]) => item.score > 0)
      .map(([key, item]) => ({
        label: labels[key] ?? item.name?.trim() ?? key,
        score: Math.round(item.score),
        ratio: ratioToPercentage(item.ratio),
      })),
    recommendationTraffic: Object.values(overview.recommend)
      .reduce((sum, item) => sum + Math.round(item.score), 0),
    childShares: structure.chars.dims.map(({ ratio }) =>
      ratioToPercentage(ratio)),
    monthlyTrend: monthly.dates.map((month, index) => ({
      month,
      natural: Math.round(monthly.nfScore[index]?.score ?? 0),
      advertising: Math.round(monthly.adScore[index]?.score ?? 0),
    })),
  };
}

function canonicalListingOverviewEvidence(record: CollectedTrafficRecord) {
  return {
    total: record.total,
    natural: { ...record.natural },
    advertising: { ...record.advertising },
    advertisingChannels: record.advertisingChannels.map((channel) => ({
      ...channel,
    })),
    recommendationTraffic: record.recommendationTraffic,
  };
}

function parseTrafficOperation<Output>(
  asin: string,
  operation: RequestEvidence["operation"],
  schema: z.ZodType<Output>,
  candidate: unknown,
  diagnosticCandidate: unknown = candidate,
): Output {
  try {
    return schema.parse(candidate);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new SifTrafficSnapshotTaskError(
        asin,
        operation,
        operation === "ops_get_asin_traffic_trend"
          ? diagnoseMonthlyTrendShape(candidate, diagnosticCandidate)
          : operation === "ops_get_listing_traffic_overview"
          ? diagnoseListingOverviewShape(diagnosticCandidate)
          : undefined,
      );
    }
    throw error;
  }
}

function projectMonthlyTrendCandidate(candidate: unknown): unknown {
  if (!isPlainObject(candidate)) return undefined;
  const source = candidate as ProjectedMonthlyTrendCandidate;
  const useCanonicalScores = Object.hasOwn(source, "nfScore") ||
    Object.hasOwn(source, "adScore");
  if (useCanonicalScores) {
    return {
      ...(Object.hasOwn(source, "dates") ? { dates: source.dates } : {}),
      ...(Object.hasOwn(source, "nfScore")
        ? { nfScore: projectMonthlyScorePoints(source.nfScore) }
        : {}),
      ...(Object.hasOwn(source, "adScore")
        ? { adScore: projectMonthlyScorePoints(source.adScore) }
        : {}),
      ...(source.data_notice === undefined
        ? {}
        : { data_notice: source.data_notice }),
      ...(source.fetchedAt === undefined
        ? {}
        : { fetchedAt: source.fetchedAt }),
    };
  }
  return {
    ...(Object.hasOwn(source, "dates") ? { dates: source.dates } : {}),
    ...(Object.hasOwn(source, "nf")
      ? { nf: projectMonthlyScorePoints(source.nf) }
      : {}),
    ...(Object.hasOwn(source, "ad") ? { ad: projectMonthlyScorePoints(source.ad) } : {}),
    ...(source.data_notice === undefined
      ? {}
      : { data_notice: source.data_notice }),
    ...(source.fetchedAt === undefined
      ? {}
      : { fetchedAt: source.fetchedAt }),
  };
}

function projectMonthlyScorePoints(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((point) => {
      if (point === 0) return { score: 0 };
      if (
        isPlainObject(point) &&
        Object.hasOwn(point, "score") &&
        point.score === null
      ) return null;
      return point;
    })
    : value;
}

function projectListingOverviewCandidate(candidate: unknown): unknown {
  if (!isPlainObject(candidate)) return candidate;
  const source = candidate as ProjectedListingOverviewCandidate;
  const overview = isPlainObject(source.overview)
    ? {
        ...(Object.hasOwn(source.overview, "nf")
          ? { nf: source.overview.nf }
          : {}),
        ...(Object.hasOwn(source.overview, "ad")
          ? { ad: source.overview.ad }
          : isVerifiedAllNaturalOverview(source, source.overview)
          ? { ad: { score: 0, ratio: 0 } }
          : {}),
      }
    : source.overview;
  return {
    ...(Object.hasOwn(source, "overview") ? { overview } : {}),
    ...(Object.hasOwn(source, "ad") ? { ad: source.ad } : {}),
    ...(Object.hasOwn(source, "recommend")
      ? { recommend: source.recommend }
      : {}),
    ...(Object.hasOwn(source, "total") ? { total: source.total } : {}),
  };
}

function isVerifiedAllNaturalOverview(
  source: ProjectedListingOverviewCandidate,
  overview: Record<string, unknown>,
): boolean {
  if (
    Object.hasOwn(overview, "ad") ||
    !Object.hasOwn(source, "ad") ||
    !isPlainObject(source.ad) ||
    Object.keys(source.ad).length !== 0
  ) {
    return false;
  }
  if (!isPlainObject(overview.nf)) return false;
  const natural = overview.nf as Readonly<{ score?: unknown; ratio?: unknown }>;
  if (
    typeof natural.score !== "number" ||
    !Number.isFinite(natural.score) ||
    natural.score <= 0 ||
    natural.ratio !== 1 ||
    typeof source.total !== "number" ||
    !Number.isFinite(source.total) ||
    source.total <= 0
  ) return false;
  return Math.abs(natural.score - source.total) <= 1e-8;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function diagnoseMonthlyTrendShape(
  candidate: unknown,
  rawCandidate: unknown = candidate,
): SifMonthlyTrendShapeDiagnostic {
  const candidateType = jsonShapeType(candidate);
  const objectCandidate = candidateType === "object"
    ? candidate as ProjectedMonthlyTrendCandidate
    : null;
  const diagnoseField = (field: (typeof MONTHLY_TREND_DIAGNOSTIC_FIELDS)[number]) => {
    const present = objectCandidate !== null && Object.hasOwn(objectCandidate, field);
    const value = present ? objectCandidate[field] : undefined;
    const type: JsonShapeType = present ? jsonShapeType(value) : "missing";
    return {
      present,
      type,
      ...(Array.isArray(value) ? { arrayLength: value.length } : {}),
    };
  };
  const fields: SifMonthlyTrendShapeDiagnostic["fields"] = {
    dates: diagnoseField("dates"),
    nf: diagnoseField("nf"),
    ad: diagnoseField("ad"),
    nfScore: diagnoseField("nfScore"),
    adScore: diagnoseField("adScore"),
    data_notice: diagnoseField("data_notice"),
    fetchedAt: {
      ...diagnoseField("fetchedAt"),
      dateOnlyValid: MonthlyTrendFetchedAtSchema.safeParse(
        objectCandidate !== null && Object.hasOwn(objectCandidate, "fetchedAt")
          ? objectCandidate.fetchedAt
          : undefined,
      ).success,
    },
  };
  const firstInvalid = firstMonthlyTrendInvalid(objectCandidate);
  return {
    kind: "monthly-trend",
    candidateType,
    fields,
    coreLengthMismatch: firstCoreLengthMismatch(objectCandidate),
    firstInvalid: monthlyTrendFirstInvalidWithPoint(
      firstInvalid,
      fields,
      rawCandidate,
    ),
  };
}

function monthlyTrendFirstInvalidWithPoint(
  firstInvalid: SifMonthlyTrendShapeDiagnostic["firstInvalid"],
  fields: SifMonthlyTrendShapeDiagnostic["fields"],
  rawCandidate: unknown,
): SifMonthlyTrendShapeDiagnostic["firstInvalid"] {
  if (
    !isOneOf(firstInvalid.field, MONTHLY_TREND_CORE_SEQUENCE_FIELDS) ||
    !isSafeNonNegativeInteger(firstInvalid.index) ||
    !isOneOf(firstInvalid.reason, ["type", "nonfinite", "negative"] as const)
  ) return firstInvalid;
  const field = fields[firstInvalid.field];
  if (
    !field.present ||
    field.type !== "array" ||
    !isSafeNonNegativeInteger(field.arrayLength) ||
    firstInvalid.index >= field.arrayLength
  ) return firstInvalid;
  const point = rawMonthlyTrendPoint(rawCandidate, firstInvalid.field, firstInvalid.index);
  return point ? { ...firstInvalid, point } : firstInvalid;
}

function rawMonthlyTrendPoint(
  candidate: unknown,
  field: MonthlyTrendPointField,
  index: number,
): SifMonthlyTrendPointDiagnostic | undefined {
  if (!isPlainObject(candidate) || !Object.hasOwn(candidate, field)) return undefined;
  const points = candidate[field];
  if (!Array.isArray(points)) return undefined;
  const value = points[index];
  const type = jsonShapeType(value);
  if (type === "null") return undefined;
  if (type !== "object") return { type };
  const present = Object.hasOwn(value, "score");
  return {
    type: "object",
    score: {
      present,
      type: present ? jsonShapeType((value as { score?: unknown }).score) : "missing",
    },
  };
}

function firstCoreLengthMismatch(
  candidate: ProjectedMonthlyTrendCandidate | null,
): SifMonthlyTrendShapeDiagnostic["coreLengthMismatch"] {
  if (candidate === null || !Array.isArray(candidate.dates)) return null;
  const expectedLength = candidate.dates.length;
  for (const field of MONTHLY_TREND_CORE_SEQUENCE_FIELDS) {
    const value = candidate[field];
    if (!Array.isArray(value) || value.length === expectedLength) continue;
    return {
      field,
      expectedLength,
      actualLength: value.length,
      firstInvalidIndex: Math.min(expectedLength, value.length),
    };
  }
  return null;
}

function firstMonthlyTrendInvalid(
  candidate: ProjectedMonthlyTrendCandidate | null,
): SifMonthlyTrendShapeDiagnostic["firstInvalid"] {
  if (candidate === null) {
    return { field: "root", index: null, reason: "unknown-shape" };
  }
  const hasCanonical = Object.hasOwn(candidate, "nfScore") &&
    Object.hasOwn(candidate, "adScore") &&
    !Object.hasOwn(candidate, "nf") &&
    !Object.hasOwn(candidate, "ad");
  const hasRetained = Object.hasOwn(candidate, "nf") &&
    Object.hasOwn(candidate, "ad") &&
    !Object.hasOwn(candidate, "nfScore") &&
    !Object.hasOwn(candidate, "adScore");
  if (!hasCanonical && !hasRetained) {
    return { field: "root", index: null, reason: "unknown-shape" };
  }
  const pointFields = hasCanonical
    ? ["nfScore", "adScore"] as const
    : ["nf", "ad"] as const;
  const arrayFields = ["dates", ...pointFields] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(candidate[field])) {
      return { field, index: null, reason: "type" };
    }
  }
  const dates = candidate.dates as unknown[];
  for (const [index, value] of dates.entries()) {
    if (typeof value !== "string") {
      return { field: "dates", index, reason: "type" };
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
      return { field: "dates", index, reason: "unknown-shape" };
    }
  }
  for (const field of pointFields) {
    const points = candidate[field] as unknown[];
    for (const [index, value] of points.entries()) {
      if (value === null) continue;
      if (
        typeof value !== "object" ||
        Array.isArray(value) ||
        !Object.hasOwn(value, "score") ||
        typeof (value as { score?: unknown }).score !== "number"
      ) {
        return { field, index, reason: "type" };
      }
      const score = (value as { score: number }).score;
      if (!Number.isFinite(score)) {
        return { field, index, reason: "nonfinite" };
      }
      if (score < 0) {
        return { field, index, reason: "negative" };
      }
    }
  }
  if (
    Object.hasOwn(candidate, "data_notice") &&
    typeof candidate.data_notice !== "string"
  ) {
    return { field: "data_notice", index: null, reason: "type" };
  }
  if (Object.hasOwn(candidate, "fetchedAt")) {
    if (typeof candidate.fetchedAt !== "string") {
      return { field: "fetchedAt", index: null, reason: "type" };
    }
    if (!MonthlyTrendFetchedAtSchema.safeParse(candidate.fetchedAt).success) {
      return { field: "fetchedAt", index: null, reason: "unknown-shape" };
    }
  }
  for (const field of arrayFields) {
    const values = candidate[field] as unknown[];
    if (values.length > 24) {
      return { field, index: 24, reason: "length-mismatch" };
    }
  }
  for (const field of pointFields) {
    const values = candidate[field] as unknown[];
    if (values.length !== dates.length) {
      return {
        field,
        index: Math.min(values.length, dates.length),
        reason: "length-mismatch",
      };
    }
  }
  return { field: "root", index: null, reason: "unknown-shape" };
}

function jsonShapeType(value: unknown): Exclude<JsonShapeType, "missing"> {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "non-json";
}

function diagnoseListingOverviewShape(
  candidate: unknown,
): SifListingOverviewShapeDiagnostic {
  const candidateType = jsonShapeType(candidate);
  const objectCandidate = isPlainObject(candidate)
    ? candidate as ListingOverviewDiagnosticCandidate
    : null;
  return {
    kind: "listing-overview",
    candidateType,
    fields: Object.fromEntries(
      LISTING_OVERVIEW_DIAGNOSTIC_FIELDS.map((field) => {
        const value = listingOverviewDiagnosticValue(objectCandidate, field);
        return [field, {
          present: value.present,
          type: value.present ? jsonShapeType(value.value) : "missing",
        }];
      }),
    ) as SifListingOverviewShapeDiagnostic["fields"],
    firstInvalid: firstListingOverviewInvalid(objectCandidate),
  };
}

function listingOverviewDiagnosticValue(
  candidate: ListingOverviewDiagnosticCandidate | null,
  field: ListingOverviewDiagnosticField,
): Readonly<{ present: boolean; value: unknown }> {
  const [rootField, distribution, metric] = field.split(".");
  if (!rootField || candidate === null || !Object.hasOwn(candidate, rootField)) {
    return { present: false, value: undefined };
  }
  const rootValue = candidate[rootField];
  if (!distribution) return { present: true, value: rootValue };
  if (!isPlainObject(rootValue) || !Object.hasOwn(rootValue, distribution)) {
    return { present: false, value: undefined };
  }
  const distributionValue = rootValue[distribution];
  if (!metric) return { present: true, value: distributionValue };
  if (!isPlainObject(distributionValue) || !Object.hasOwn(distributionValue, metric)) {
    return { present: false, value: undefined };
  }
  return { present: true, value: distributionValue[metric] };
}

function firstListingOverviewInvalid(
  candidate: ListingOverviewDiagnosticCandidate | null,
): SifListingOverviewShapeDiagnostic["firstInvalid"] {
  if (candidate === null) {
    return { field: "root", reason: "unknown-shape" };
  }
  if (!isPlainObject(candidate.overview)) {
    return { field: "overview", reason: "type" };
  }
  for (const field of ["ad", "recommend"] as const) {
    if (Object.hasOwn(candidate, field) && !isPlainObject(candidate[field])) {
      return { field, reason: "type" };
    }
  }
  if (typeof candidate.total !== "number") {
    return { field: "total", reason: "type" };
  }
  if (!Number.isFinite(candidate.total)) {
    return { field: "total", reason: "nonfinite" };
  }
  if (candidate.total < 0) {
    return { field: "total", reason: "negative" };
  }
  const overview = candidate.overview;
  for (const distribution of ["nf", "ad"] as const) {
    const distributionField = `overview.${distribution}` as const;
    if (!isPlainObject(overview[distribution])) {
      return { field: distributionField, reason: "type" };
    }
    const value = overview[distribution];
    for (const metric of ["score", "ratio"] as const) {
      const field = `${distributionField}.${metric}` as const;
      if (typeof value[metric] !== "number") {
        return { field, reason: "type" };
      }
      if (!Number.isFinite(value[metric])) {
        return { field, reason: "nonfinite" };
      }
      if (value[metric] < 0) {
        return { field, reason: "negative" };
      }
    }
  }
  return { field: "root", reason: "unknown-shape" };
}

export function copySifTrafficShapeDiagnostic(
  diagnostic: unknown,
): SifTrafficShapeDiagnostic | undefined {
  if (isListingOverviewShapeDiagnostic(diagnostic)) {
    return {
      kind: "listing-overview",
      candidateType: diagnostic.candidateType,
      fields: Object.fromEntries(
        LISTING_OVERVIEW_DIAGNOSTIC_FIELDS.map((field) => {
          const value = diagnostic.fields[field];
          return [field, { present: value.present, type: value.type }];
        }),
      ) as SifListingOverviewShapeDiagnostic["fields"],
      firstInvalid: {
        field: diagnostic.firstInvalid.field,
        reason: diagnostic.firstInvalid.reason,
      },
    };
  }
  if (!isMonthlyTrendShapeDiagnostic(diagnostic)) return undefined;
  return {
    kind: "monthly-trend",
    candidateType: diagnostic.candidateType,
    fields: Object.fromEntries(
      MONTHLY_TREND_DIAGNOSTIC_FIELDS.map((field) => {
        const value = diagnostic.fields[field];
        return [field, {
          present: value.present,
          type: value.type,
          ...(typeof value.arrayLength === "number"
            ? { arrayLength: value.arrayLength }
            : {}),
          ...(field === "fetchedAt"
            ? { dateOnlyValid: diagnostic.fields.fetchedAt.dateOnlyValid }
            : {}),
        }];
      }),
    ) as SifMonthlyTrendShapeDiagnostic["fields"],
    coreLengthMismatch: diagnostic.coreLengthMismatch
      ? { ...diagnostic.coreLengthMismatch }
      : null,
    firstInvalid: {
      field: diagnostic.firstInvalid.field,
      index: diagnostic.firstInvalid.index,
      reason: diagnostic.firstInvalid.reason,
      ...("point" in diagnostic.firstInvalid
        ? { point: copyMonthlyTrendPointDiagnostic(diagnostic.firstInvalid.point) }
        : {}),
    },
  };
}

function copyMonthlyTrendPointDiagnostic(
  point: SifMonthlyTrendPointDiagnostic,
): SifMonthlyTrendPointDiagnostic {
  return point.type === "object"
    ? {
      type: "object",
      score: { present: point.score.present, type: point.score.type },
    }
    : { type: point.type };
}

function isListingOverviewShapeDiagnostic(
  value: unknown,
): value is SifListingOverviewShapeDiagnostic {
  if (!hasExactKeys(value, [
    "kind",
    "candidateType",
    "fields",
    "firstInvalid",
  ])) return false;
  const diagnostic = value as Record<string, unknown>;
  if (
    diagnostic.kind !== "listing-overview" ||
    !isJsonCandidateType(diagnostic.candidateType) ||
    !hasExactKeys(diagnostic.fields, LISTING_OVERVIEW_DIAGNOSTIC_FIELDS)
  ) return false;
  const fields = diagnostic.fields as Record<string, unknown>;
  if (!LISTING_OVERVIEW_DIAGNOSTIC_FIELDS.every((field) =>
    isDiagnosticField(fields[field]),
  )) return false;
  if (!hasExactKeys(diagnostic.firstInvalid, ["field", "reason"])) {
    return false;
  }
  const firstInvalid = diagnostic.firstInvalid as Record<string, unknown>;
  return (
    typeof firstInvalid.field === "string" &&
    (firstInvalid.field === "root" ||
      LISTING_OVERVIEW_DIAGNOSTIC_FIELDS.includes(
        firstInvalid.field as ListingOverviewDiagnosticField,
      )) &&
    isOneOf(firstInvalid.reason, LISTING_OVERVIEW_FIRST_INVALID_REASONS)
  );
}

function isMonthlyTrendShapeDiagnostic(
  value: unknown,
): value is SifMonthlyTrendShapeDiagnostic {
  if (!hasExactKeys(value, [
    "kind",
    "candidateType",
    "fields",
    "coreLengthMismatch",
    "firstInvalid",
  ])) return false;
  const diagnostic = value as Record<string, unknown>;
  if (
    diagnostic.kind !== "monthly-trend" ||
    !isJsonCandidateType(diagnostic.candidateType) ||
    !hasExactKeys(diagnostic.fields, MONTHLY_TREND_DIAGNOSTIC_FIELDS)
  ) return false;
  const fields = diagnostic.fields as Record<string, unknown>;
  if (!MONTHLY_TREND_DIAGNOSTIC_FIELDS.every((field) =>
    isDiagnosticField(fields[field], field === "fetchedAt"),
  )) return false;
  if (!isMonthlyCoreLengthMismatch(diagnostic.coreLengthMismatch)) return false;
  const firstInvalidHasPoint = hasExactKeys(diagnostic.firstInvalid, [
    "field",
    "index",
    "reason",
    "point",
  ]);
  if (
    !firstInvalidHasPoint &&
    !hasExactKeys(diagnostic.firstInvalid, ["field", "index", "reason"])
  ) {
    return false;
  }
  const firstInvalid = diagnostic.firstInvalid as Record<string, unknown>;
  if (!(
    typeof firstInvalid.field === "string" &&
    (firstInvalid.field === "root" ||
      MONTHLY_TREND_DIAGNOSTIC_FIELDS.includes(
        firstInvalid.field as MonthlyTrendDiagnosticField,
      )) &&
    (firstInvalid.index === null || isSafeNonNegativeInteger(firstInvalid.index)) &&
    isOneOf(firstInvalid.reason, MONTHLY_TREND_FIRST_INVALID_REASONS)
  )) return false;
  if (!firstInvalidHasPoint) return true;
  return isMonthlyTrendPointPermitted(
    firstInvalid.point,
    firstInvalid,
    fields,
  );
}

function isMonthlyTrendPointPermitted(
  point: unknown,
  firstInvalid: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, unknown>>,
): point is SifMonthlyTrendPointDiagnostic {
  if (!isMonthlyTrendPointDiagnostic(point)) return false;
  if (
    !isOneOf(firstInvalid.field, MONTHLY_TREND_CORE_SEQUENCE_FIELDS) ||
    !isSafeNonNegativeInteger(firstInvalid.index) ||
    !isOneOf(firstInvalid.reason, ["type", "nonfinite", "negative"] as const)
  ) return false;
  const field = fields[firstInvalid.field];
  if (!isDiagnosticField(field)) return false;
  const boundedField = field as Record<string, unknown>;
  if (
    !boundedField.present ||
    boundedField.type !== "array" ||
    !isSafeNonNegativeInteger(boundedField.arrayLength) ||
    firstInvalid.index >= boundedField.arrayLength
  ) return false;
  if (point.type !== "object") return firstInvalid.reason === "type";
  return point.score.type === "number"
    ? firstInvalid.reason === "nonfinite" || firstInvalid.reason === "negative"
    : firstInvalid.reason === "type";
}

function isMonthlyTrendPointDiagnostic(
  value: unknown,
): value is SifMonthlyTrendPointDiagnostic {
  if (!isPlainObject(value)) return false;
  const point = value as Record<string, unknown>;
  if (point.type !== "object") {
    return hasExactKeys(value, ["type"]) && isOneOf(point.type, [
      "array",
      "string",
      "number",
      "boolean",
      "non-json",
    ] as const);
  }
  if (!hasExactKeys(value, ["type", "score"]) || !hasExactKeys(point.score, ["present", "type"])) {
    return false;
  }
  const score = point.score as Record<string, unknown>;
  return typeof score.present === "boolean" &&
    isOneOf(score.type, JSON_SHAPE_TYPES) &&
    score.present === (score.type !== "missing");
}

function isDiagnosticField(value: unknown, requiresDateOnlyValid = false): boolean {
  const keys = requiresDateOnlyValid
    ? ["present", "type", "dateOnlyValid"]
    : ["present", "type"];
  if (
    !hasExactKeys(value, keys) &&
    !hasExactKeys(value, [...keys, "arrayLength"])
  ) return false;
  const field = value as Record<string, unknown>;
  return (
    typeof field.present === "boolean" &&
    field.present === (field.type !== "missing") &&
    isOneOf(field.type, JSON_SHAPE_TYPES) &&
    (!Object.hasOwn(field, "arrayLength") ||
      (field.type === "array" && isSafeNonNegativeInteger(field.arrayLength))) &&
    (!requiresDateOnlyValid || typeof field.dateOnlyValid === "boolean")
  );
}

function isMonthlyCoreLengthMismatch(value: unknown): boolean {
  if (value === null) return true;
  if (!hasExactKeys(value, [
    "field",
    "expectedLength",
    "actualLength",
    "firstInvalidIndex",
  ])) return false;
  const mismatch = value as Record<string, unknown>;
  return (
    isOneOf(mismatch.field, MONTHLY_TREND_CORE_SEQUENCE_FIELDS) &&
    isSafeNonNegativeInteger(mismatch.expectedLength) &&
    isSafeNonNegativeInteger(mismatch.actualLength) &&
    isSafeNonNegativeInteger(mismatch.firstInvalidIndex) &&
    mismatch.firstInvalidIndex === Math.min(
      mismatch.expectedLength,
      mismatch.actualLength,
    )
  );
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) =>
    Object.hasOwn(value, key),
  );
}

function isJsonCandidateType(value: unknown): value is Exclude<JsonShapeType, "missing"> {
  return isOneOf(value, JSON_CANDIDATE_TYPES);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function isOneOf<const Value extends string>(
  value: unknown,
  values: readonly Value[],
): value is Value {
  return typeof value === "string" && values.includes(value as Value);
}

function ratioToPercentage(value: number) {
  return Math.round(value * 1_000) / 10;
}

function requestEvidence(
  asin: string,
  result: ConnectorResult,
  evidenceData: unknown = result.data,
): RequestEvidence {
  return {
    asin,
    operation: result.source.operation as RequestEvidence["operation"],
    fetchedAt: result.source.fetchedAt,
    attemptCount: result.source.attemptCount,
    checksum: canonicalJsonSha256(evidenceData),
  };
}

function collectedSources(
  listing: readonly RequestEvidence[],
  monthly: readonly RequestEvidence[],
): readonly TrafficSnapshotSource[] {
  return [
    {
      id: "sif-listing-traffic",
      type: "connector",
      connectorId: "sif",
      capturedAt: latestFetchedAt(listing),
      checksum: canonicalJsonSha256(listing),
      requests: [...listing],
    },
    {
      id: "sif-monthly-traffic-trend",
      type: "connector",
      connectorId: "sif",
      capturedAt: latestFetchedAt(monthly),
      checksum: canonicalJsonSha256(monthly),
      requests: [...monthly],
    },
  ];
}

function latestFetchedAt(requests: readonly RequestEvidence[]) {
  const latest = requests
    .map(({ fetchedAt }) => fetchedAt)
    .sort()
    .at(-1);
  if (!latest) throw new TypeError("SIF traffic source evidence is empty");
  return latest;
}

function safeTaskError(error: unknown) {
  if (error instanceof ConnectorError) {
    const category = error.code === "local-admission" ? "rate-limit" : error.code === "timeout"
      ? "upstream-temporary"
      : error.code === "malformed-response"
      ? "data-quality"
      : error.code;
    return new WorkerTaskError(category, error.message);
  }
  if (error instanceof z.ZodError) {
    return new WorkerTaskError(
      "data-quality",
      "SIF traffic response failed deterministic validation",
    );
  }
  if (error instanceof WorkerTaskError) return error;
  return new WorkerTaskError(
    "infrastructure",
    "SIF traffic snapshot task failed",
  );
}
