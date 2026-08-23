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
  dates: z.array(z.string().regex(/^\d{4}-\d{2}$/)).max(24),
  nfScore: MonthlyTrafficPointsSchema,
  adScore: MonthlyTrafficPointsSchema,
  data_notice: z.string().optional(),
  fetchedAt: MonthlyTrendFetchedAtSchema.optional(),
}), z.strictObject({
  dates: z.array(z.string().regex(/^\d{4}-\d{2}$/)).max(24),
  nf: MonthlyTrafficPointsSchema,
  ad: MonthlyTrafficPointsSchema,
  data_notice: z.string().optional(),
  fetchedAt: MonthlyTrendFetchedAtSchema.optional(),
})]).transform((value) => ({
  dates: value.dates,
  nfScore: "nfScore" in value ? value.nfScore : value.nf,
  adScore: "adScore" in value ? value.adScore : value.ad,
}));

const MONTHLY_TREND_DIAGNOSTIC_FIELDS = [
  "dates",
  "nfScore",
  "adScore",
  "nf",
  "ad",
  "data_notice",
  "fetchedAt",
] as const;

const MONTHLY_TREND_OFFICIAL_FIELDS = [
  "dates",
  "asin",
  "totalScore",
  "nfScore",
  "adScore",
  "spScore",
  "recSpScore",
  "sbScore",
  "sbvScore",
  "trend_analysis",
  "dealPrice",
  "buyboxPrice",
  "primePrice",
  "ldPrice",
  "couponInfo",
  "promotion",
  "buyboxSeller",
  "bsr",
  "subBsr",
  "star",
  "review",
  "seller",
  "woot",
  "titleImg",
  "boughtInPastMonth",
  "catId",
  "catName",
  "pasin",
  "data_notice",
] as const;

const MONTHLY_TREND_OFFICIAL_META_FIELDS = [
  "_formatted",
  "_next_step",
] as const;

const MONTHLY_TREND_CORE_SEQUENCE_FIELDS = [
  "totalScore",
  "nfScore",
  "adScore",
  "spScore",
  "recSpScore",
  "sbScore",
  "sbvScore",
  "nf",
  "ad",
] as const;

const MONTHLY_TREND_SCORE_FIELDS = new Set<string>([
  "totalScore",
  "nfScore",
  "adScore",
  "spScore",
  "recSpScore",
  "sbScore",
  "sbvScore",
]);

type MonthlyTrendDiagnosticField =
  (typeof MONTHLY_TREND_DIAGNOSTIC_FIELDS)[number];
type MonthlyTrendOfficialField =
  (typeof MONTHLY_TREND_OFFICIAL_FIELDS)[number];
type MonthlyTrendOfficialMetaField =
  (typeof MONTHLY_TREND_OFFICIAL_META_FIELDS)[number];
type MonthlyTrendCoreSequenceField =
  (typeof MONTHLY_TREND_CORE_SEQUENCE_FIELDS)[number];
type JsonShapeType =
  | "missing"
  | "null"
  | "array"
  | "object"
  | "string"
  | "number"
  | "boolean"
  | "non-json";
type JsonElementType = Exclude<JsonShapeType, "missing">;
type ArrayElementInvalidReason = "type" | "nonfinite" | "negative";

type SifTrafficFieldDiagnostic = Readonly<{
  present: boolean;
  type: JsonShapeType;
  arrayLength?: number;
  elementTypeCounts?: Readonly<Record<JsonElementType, number>>;
  firstInvalidIndex?: number;
  firstInvalidReason?: ArrayElementInvalidReason;
}>;

export type SifTrafficShapeDiagnostic = Readonly<{
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
  officialFields: Readonly<Record<
    MonthlyTrendOfficialField,
    SifTrafficFieldDiagnostic
  >>;
  officialMeta: Readonly<Record<
    MonthlyTrendOfficialMetaField,
    Readonly<{ present: boolean; type: JsonShapeType }>
  >>;
  parserUnknownCount: number;
  outsideOfficialUnknownCount: number;
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
      | "unknown-shape"
      | "extra-key";
  }>;
}>;

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
      ? copyShapeDiagnostic(shapeDiagnostic)
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
            pageSize: 20,
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
        const record = normalizeTrafficRecord(
          asin,
          overviewResult.data,
          structureResult.data,
          monthlyResult.data,
        );
        listingEvidence.push(
          requestEvidence(asin, overviewResult),
          requestEvidence(asin, structureResult),
        );
        monthlyEvidence.push(requestEvidence(asin, monthlyResult));
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
    const created = await this.#repository.createTrafficDataSnapshotForRun({
      actorId: subject.actorId,
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
      expectedProjectId: subject.projectId,
      expectedMarketplace: subject.marketplace,
      expectedAsins: subject.asins,
      expectedRunCutoffAt: subject.dataCutoffAt,
      candidateId: this.#createId(),
      createdAt,
      candidate: buildTrafficSnapshotCandidate({
        asins: subject.asins,
        trafficInput,
        sources,
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
  overviewCandidate: ConnectorResult["data"],
  structureCandidate: ConnectorResult["data"],
  monthlyCandidate: ConnectorResult["data"],
): CollectedTrafficRecord {
  const overview = parseTrafficOperation(
    asin,
    "ops_get_listing_traffic_overview",
    ListingOverviewSchema,
    overviewCandidate,
  );
  const structure = parseTrafficOperation(
    asin,
    "ops_get_listing_traffic_structure",
    ListingStructureSchema,
    structureCandidate,
  );
  const monthly = parseTrafficOperation(
    asin,
    "ops_get_asin_traffic_trend",
    MonthlyTrendSchema,
    monthlyCandidate,
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

function parseTrafficOperation<Output>(
  asin: string,
  operation: RequestEvidence["operation"],
  schema: z.ZodType<Output>,
  candidate: unknown,
): Output {
  try {
    return schema.parse(candidate);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new SifTrafficSnapshotTaskError(
        asin,
        operation,
        operation === "ops_get_asin_traffic_trend"
          ? diagnoseMonthlyTrendShape(candidate)
          : undefined,
      );
    }
    throw error;
  }
}

function diagnoseMonthlyTrendShape(candidate: unknown): SifTrafficShapeDiagnostic {
  const candidateType = jsonShapeType(candidate);
  const objectCandidate = candidateType === "object"
    ? candidate as Record<string, unknown>
    : null;
  const fields = Object.fromEntries(
    MONTHLY_TREND_DIAGNOSTIC_FIELDS.map((field) => {
      const present = objectCandidate !== null && Object.hasOwn(objectCandidate, field);
      const value = present ? objectCandidate[field] : undefined;
      const type = present ? jsonShapeType(value) : "missing";
      return [field, {
        present,
        type,
        ...(Array.isArray(value) ? { arrayLength: value.length } : {}),
        ...(field === "fetchedAt"
          ? { dateOnlyValid: MonthlyTrendFetchedAtSchema.safeParse(value).success }
          : {}),
      }];
    }),
  ) as SifTrafficShapeDiagnostic["fields"];
  const parserFields = new Set<string>(MONTHLY_TREND_DIAGNOSTIC_FIELDS);
  const parserUnknownCount = objectCandidate === null
    ? 0
    : Object.keys(objectCandidate).filter((field) => !parserFields.has(field)).length;
  const officialFields = Object.fromEntries(
    MONTHLY_TREND_OFFICIAL_FIELDS.map((field) => [
      field,
      diagnoseOfficialField(objectCandidate, field),
    ]),
  ) as SifTrafficShapeDiagnostic["officialFields"];
  const officialMeta = Object.fromEntries(
    MONTHLY_TREND_OFFICIAL_META_FIELDS.map((field) => {
      const present = objectCandidate !== null && Object.hasOwn(objectCandidate, field);
      return [field, {
        present,
        type: present ? jsonShapeType(objectCandidate[field]) : "missing",
      }];
    }),
  ) as SifTrafficShapeDiagnostic["officialMeta"];
  const officialAllowlist = new Set<string>([
    ...MONTHLY_TREND_OFFICIAL_FIELDS,
    ...MONTHLY_TREND_OFFICIAL_META_FIELDS,
  ]);
  const outsideOfficialUnknownCount = objectCandidate === null
    ? 0
    : Object.keys(objectCandidate)
        .filter((field) => !officialAllowlist.has(field)).length;
  return {
    candidateType,
    fields,
    officialFields,
    officialMeta,
    parserUnknownCount,
    outsideOfficialUnknownCount,
    coreLengthMismatch: firstCoreLengthMismatch(objectCandidate),
    firstInvalid: firstMonthlyTrendInvalid(objectCandidate, parserUnknownCount),
  };
}

function diagnoseOfficialField(
  candidate: Record<string, unknown> | null,
  field: MonthlyTrendOfficialField,
): SifTrafficFieldDiagnostic {
  const present = candidate !== null && Object.hasOwn(candidate, field);
  if (!present) return { present: false, type: "missing" };
  const value = candidate[field];
  const type = jsonShapeType(value);
  if (!Array.isArray(value)) return { present: true, type };
  const invalid = firstOfficialArrayInvalid(field, value);
  return {
    present: true,
    type,
    arrayLength: value.length,
    elementTypeCounts: countArrayElementTypes(value),
    ...(invalid === null
      ? {}
      : {
          firstInvalidIndex: invalid.index,
          firstInvalidReason: invalid.reason,
        }),
  };
}

function countArrayElementTypes(
  values: readonly unknown[],
): Readonly<Record<JsonElementType, number>> {
  const counts: Record<JsonElementType, number> = {
    null: 0,
    array: 0,
    object: 0,
    string: 0,
    number: 0,
    boolean: 0,
    "non-json": 0,
  };
  for (const value of values) counts[jsonShapeType(value)] += 1;
  return counts;
}

function firstOfficialArrayInvalid(
  field: MonthlyTrendOfficialField,
  values: readonly unknown[],
): Readonly<{ index: number; reason: ArrayElementInvalidReason }> | null {
  for (const [index, value] of values.entries()) {
    if (jsonShapeType(value) === "non-json") return { index, reason: "type" };
    if (field === "dates") {
      if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) {
        return { index, reason: "type" };
      }
      continue;
    }
    if (!MONTHLY_TREND_SCORE_FIELDS.has(field)) continue;
    if (value === null) continue;
    if (typeof value !== "object" || Array.isArray(value)) {
      return { index, reason: "type" };
    }
    if (!Object.hasOwn(value, "score") || typeof value.score !== "number") {
      return { index, reason: "type" };
    }
    if (!Number.isFinite(value.score)) return { index, reason: "nonfinite" };
    if (value.score < 0) return { index, reason: "negative" };
  }
  return null;
}

function firstCoreLengthMismatch(
  candidate: Record<string, unknown> | null,
): SifTrafficShapeDiagnostic["coreLengthMismatch"] {
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
  candidate: Record<string, unknown> | null,
  parserUnknownCount: number,
): SifTrafficShapeDiagnostic["firstInvalid"] {
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
    if (!/^\d{4}-\d{2}$/.test(value)) {
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
  if (parserUnknownCount > 0) {
    return { field: "root", index: null, reason: "extra-key" };
  }
  return { field: "root", index: null, reason: "unknown-shape" };
}

function jsonShapeType(value: unknown): Exclude<JsonShapeType, "missing"> {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value;
  }
  return "non-json";
}

function copyShapeDiagnostic(
  diagnostic: SifTrafficShapeDiagnostic,
): SifTrafficShapeDiagnostic {
  return {
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
    ) as SifTrafficShapeDiagnostic["fields"],
    officialFields: Object.fromEntries(
      MONTHLY_TREND_OFFICIAL_FIELDS.map((field) => {
        const value = diagnostic.officialFields[field];
        return [field, {
          present: value.present,
          type: value.type,
          ...(typeof value.arrayLength === "number"
            ? { arrayLength: value.arrayLength }
            : {}),
          ...(value.elementTypeCounts
            ? { elementTypeCounts: { ...value.elementTypeCounts } }
            : {}),
          ...(typeof value.firstInvalidIndex === "number"
            ? { firstInvalidIndex: value.firstInvalidIndex }
            : {}),
          ...(value.firstInvalidReason
            ? { firstInvalidReason: value.firstInvalidReason }
            : {}),
        }];
      }),
    ) as SifTrafficShapeDiagnostic["officialFields"],
    officialMeta: Object.fromEntries(
      MONTHLY_TREND_OFFICIAL_META_FIELDS.map((field) => {
        const value = diagnostic.officialMeta[field];
        return [field, { present: value.present, type: value.type }];
      }),
    ) as SifTrafficShapeDiagnostic["officialMeta"],
    parserUnknownCount: diagnostic.parserUnknownCount,
    outsideOfficialUnknownCount: diagnostic.outsideOfficialUnknownCount,
    coreLengthMismatch: diagnostic.coreLengthMismatch
      ? { ...diagnostic.coreLengthMismatch }
      : null,
    firstInvalid: {
      field: diagnostic.firstInvalid.field,
      index: diagnostic.firstInvalid.index,
      reason: diagnostic.firstInvalid.reason,
    },
  };
}

function ratioToPercentage(value: number) {
  return Math.round(value * 1_000) / 10;
}

function requestEvidence(
  asin: string,
  result: ConnectorResult,
): RequestEvidence {
  return {
    asin,
    operation: result.source.operation as RequestEvidence["operation"],
    fetchedAt: result.source.fetchedAt,
    attemptCount: result.source.attemptCount,
    checksum: canonicalJsonSha256(result.data),
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
    const category = error.code === "timeout"
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
