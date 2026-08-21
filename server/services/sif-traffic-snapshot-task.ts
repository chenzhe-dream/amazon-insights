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

const MonthlyTrendSchema = z.object({
  dates: z.array(z.string().regex(/^\d{4}-\d{2}$/)).max(24),
  nfScore: z.array(z.object({
    score: z.number().finite().nonnegative(),
  }).nullable()).max(24),
  adScore: z.array(z.object({
    score: z.number().finite().nonnegative(),
  }).nullable()).max(24),
});

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
        listingEvidence.push(
          requestEvidence(asin, overviewResult),
          requestEvidence(asin, structureResult),
        );
        monthlyEvidence.push(requestEvidence(asin, monthlyResult));
        records.push(normalizeTrafficRecord(
          asin,
          overviewResult.data,
          structureResult.data,
          monthlyResult.data,
        ));
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
  const overview = ListingOverviewSchema.parse(overviewCandidate);
  const structure = ListingStructureSchema.parse(structureCandidate);
  const monthly = MonthlyTrendSchema.parse(monthlyCandidate);
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
