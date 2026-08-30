import {
  sellerSpriteMcpReviewAnalysisData,
  sellerSpriteMcpReviewAnalysisMeta,
} from "../../app/seller-sprite-mcp-review-analysis-data";
import {
  sorftimeReviewAnalysisData,
  sorftimeReviewAnalysisMeta,
} from "../../app/sorftime-review-analysis-data";
import {
  AsinSchema,
  DateTimeSchema,
  ManualAlexaVocNormalizedRecordSchema,
  ManualAlexaVocRecordSchema,
  MarketplaceSchema,
} from "../../shared/agent-contracts";
import {
  ManualAlexaVocRepositoryError,
  type ManualAlexaVocRepository,
  type ManualAlexaVocRevision,
} from "../db/manual-alexa-voc-repository";
import {
  LegacyManualAlexaVocSource,
  type LegacyManualAlexaVocSourceReader,
} from "./legacy-manual-alexa-voc-source";
import {
  AlexaVocSnapshotRecordSchema,
  MissingVocSourceSchema,
  ReviewAnalysisSnapshotRecordSchema,
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
  deepFreeze,
  normalizeRepositoryDateOnlyUtc,
  type MissingVocSource,
  type VocSnapshotCandidate,
  type VocSnapshotSourceBundle,
  type VocSnapshotSourceId,
} from "./voc-data-snapshot";

interface StaticReviewSource {
  readonly meta: Readonly<{ marketplace: string }>;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface RepositoryVocReviewSources {
  readonly sorftime: StaticReviewSource;
  readonly sellerSprite: StaticReviewSource;
}

export interface RepositoryVocSourceReaderOptions {
  readonly manualVoc: Pick<ManualAlexaVocRepository, "listAtCutoff">;
  readonly legacySource?: LegacyManualAlexaVocSourceReader;
  readonly reviewSources?: RepositoryVocReviewSources;
}

export interface RepositoryVocReadInput {
  readonly organizationId: string;
  readonly marketplace: string;
  readonly asins: readonly string[];
  readonly dataCutoffAt: string;
}

export interface RepositoryVocReadResult {
  readonly candidate: VocSnapshotCandidate | null;
  readonly missingSources: readonly MissingVocSource[];
  readonly recordCount: number;
}

const defaultReviewSources: RepositoryVocReviewSources = {
  sorftime: {
    meta: sorftimeReviewAnalysisMeta,
    data: sorftimeReviewAnalysisData,
  },
  sellerSprite: {
    meta: sellerSpriteMcpReviewAnalysisMeta,
    data: sellerSpriteMcpReviewAnalysisData,
  },
};

export class RepositoryVocSourceReader {
  readonly #manualVoc: Pick<ManualAlexaVocRepository, "listAtCutoff">;
  readonly #legacySource: LegacyManualAlexaVocSourceReader;
  readonly #reviewSources: RepositoryVocReviewSources;

  constructor(options: RepositoryVocSourceReaderOptions) {
    this.#manualVoc = options.manualVoc;
    this.#legacySource = options.legacySource ?? new LegacyManualAlexaVocSource();
    this.#reviewSources = options.reviewSources ?? defaultReviewSources;
  }

  async read(input: RepositoryVocReadInput): Promise<RepositoryVocReadResult> {
    const organizationId = normalizeOrganizationId(input.organizationId);
    const marketplace = MarketplaceSchema.parse(input.marketplace.trim().toUpperCase());
    const asins = input.asins.map((asin) =>
      AsinSchema.parse(asin.trim().toUpperCase()),
    );
    if (
      asins.length === 0 ||
      asins.length > 10 ||
      new Set(asins).size !== asins.length
    ) {
      throw new TypeError("Invalid VOC target ASIN list");
    }
    const dataCutoffAt = new Date(
      DateTimeSchema.parse(input.dataCutoffAt),
    ).toISOString();
    const missingSources: MissingVocSource[] = [];
    const sourceBundles: VocSnapshotSourceBundle[] = [];

    const alexa = marketplace === "US"
      ? await readAlexaSource(
          this.#manualVoc,
          this.#legacySource,
          organizationId,
          asins,
          dataCutoffAt,
          missingSources,
        )
      : addMarketplaceMismatch(asins, missingSources);
    if (alexa) sourceBundles.push(alexa);

    const sorftime = readReviewSource(
      "sorftime-review-analysis",
      this.#reviewSources.sorftime,
      asins,
      marketplace,
      dataCutoffAt,
      missingSources,
    );
    if (sorftime) sourceBundles.push(sorftime);

    const sellerSprite = readReviewSource(
      "seller-sprite-review-analysis",
      this.#reviewSources.sellerSprite,
      asins,
      marketplace,
      dataCutoffAt,
      missingSources,
    );
    if (sellerSprite) sourceBundles.push(sellerSprite);

    const recordCount = sourceBundles.reduce(
      (total, source) => total + source.records.length,
      0,
    );
    return deepFreeze({
      candidate:
        sourceBundles.length === 0
          ? null
          : buildVocSnapshotCandidate({
              marketplace,
              asins,
              dataCutoffAt,
              sourceBundles,
            }),
      missingSources: missingSources.map((missing) =>
        MissingVocSourceSchema.parse(missing),
      ),
      recordCount,
    });
  }
}

async function readAlexaSource(
  manualVoc: Pick<ManualAlexaVocRepository, "listAtCutoff">,
  legacySource: LegacyManualAlexaVocSourceReader,
  organizationId: string,
  asins: readonly string[],
  dataCutoffAt: string,
  missing: MissingVocSource[],
): Promise<Extract<VocSnapshotSourceBundle, { sourceId: "alexa-voc" }> | null> {
  const records = [] as Array<
    ReturnType<typeof AlexaVocSnapshotRecordSchema.parse>
  >;
  let capturedAt: string | null = null;
  const dynamic = await manualVoc.listAtCutoff({
    organizationId,
    marketplace: "US",
    asins,
    dataCutoffAt,
  });
  const dynamicByAsin = validateDynamicRecords(
    dynamic,
    organizationId,
    asins,
    dataCutoffAt,
  );

  for (const asin of asins) {
    const record = dynamicByAsin.get(asin);
    if (record) {
      records.push(record.normalizedRecord);
      capturedAt = latestTimestamp(capturedAt, record.capturedAt);
      continue;
    }
    const legacy = await legacySource.readIfEligible({
      principalOrg: organizationId,
      marketplace: "US",
      asin,
      dataCutoffAt,
    });
    if (legacy.status !== "ready") {
      addMissing(
        missing,
        "alexa-voc",
        asin,
        legacy.status === "missing" ? legacy.reason : "not-found",
      );
      continue;
    }
    const parsed = ManualAlexaVocRecordSchema.safeParse(legacy.record);
    if (
      !parsed.success ||
      parsed.data.asin !== asin ||
      parsed.data.marketplace !== "US" ||
      parsed.data.source !== "legacy-static-stale" ||
      parsed.data.capturedAt > dataCutoffAt
    ) {
      addMissing(missing, "alexa-voc", asin, "source-error");
      continue;
    }
    records.push(parsed.data.normalizedRecord);
    capturedAt = latestTimestamp(capturedAt, parsed.data.capturedAt);
  }

  return records.length === 0 || !capturedAt
    ? null
    : {
        sourceId: "alexa-voc",
        type: "manual-voc",
        reference: VOC_SOURCE_REFERENCES.alexaVoc,
        marketplace: "US",
        capturedAt,
        records,
      };
}

function validateDynamicRecords(
  records: readonly ManualAlexaVocRevision[],
  organizationId: string,
  asins: readonly string[],
  dataCutoffAt: string,
) {
  if (!Array.isArray(records)) {
    throw new ManualAlexaVocRepositoryError("deserialize");
  }
  const allowed = new Set(asins);
  const byAsin = new Map<string, ManualAlexaVocRevision>();
  for (const record of records) {
    const normalized = ManualAlexaVocNormalizedRecordSchema.safeParse(
      record?.normalizedRecord,
    );
    const capturedAt = DateTimeSchema.safeParse(record?.capturedAt);
    const canonicalCapturedAt = capturedAt.success
      ? new Date(capturedAt.data).toISOString()
      : null;
    if (
      record?.organizationId !== organizationId ||
      record?.marketplace !== "US" ||
      !allowed.has(record?.asin) ||
      byAsin.has(record?.asin) ||
      !/^[1-9]\d*$/.test(record?.revision ?? "") ||
      !/^[a-f0-9]{64}$/.test(record?.contentHash ?? "") ||
      record?.normalizedSchemaVersion !== "alexa-voc-record/v2" ||
      record?.parserVersion !== "deterministic-alexa-parser/v3" ||
      !normalized.success ||
      normalized.data.asin !== record.asin ||
      !canonicalCapturedAt ||
      canonicalCapturedAt !== record.capturedAt ||
      canonicalCapturedAt > dataCutoffAt
    ) {
      throw new ManualAlexaVocRepositoryError("deserialize");
    }
    byAsin.set(record.asin, {
      ...record,
      normalizedRecord: normalized.data,
      capturedAt: canonicalCapturedAt,
    });
  }
  return byAsin;
}

function addMarketplaceMismatch(
  asins: readonly string[],
  missing: MissingVocSource[],
) {
  for (const asin of asins) {
    addMissing(missing, "alexa-voc", asin, "marketplace-mismatch");
  }
  return null;
}

function readReviewSource(
  sourceId:
    | "sorftime-review-analysis"
    | "seller-sprite-review-analysis",
  source: StaticReviewSource,
  asins: readonly string[],
  marketplace: string,
  dataCutoffAt: string,
  missing: MissingVocSource[],
): Exclude<VocSnapshotSourceBundle, { sourceId: "alexa-voc" }> | null {
  const records = [] as Array<
    ReturnType<typeof ReviewAnalysisSnapshotRecordSchema.parse>
  >;
  let capturedAt: string | null = null;
  const sourceMarketplace = source.meta.marketplace.trim().toUpperCase();

  for (const asin of asins) {
    const raw = source.data[asin];
    if (!raw || typeof raw !== "object") {
      addMissing(missing, sourceId, asin, "not-found");
      continue;
    }
    const status = Reflect.get(raw, "status");
    if (status === "pending") {
      addMissing(missing, sourceId, asin, "pending");
      continue;
    }
    if (status !== "ready") {
      addMissing(missing, sourceId, asin, "source-error");
      continue;
    }
    if (
      sourceMarketplace !== marketplace ||
      Reflect.get(raw, "marketplace") !== marketplace
    ) {
      addMissing(missing, sourceId, asin, "marketplace-mismatch");
      continue;
    }
    const parsed = ReviewAnalysisSnapshotRecordSchema.safeParse(raw);
    if (!parsed.success || parsed.data.asin !== asin) {
      addMissing(missing, sourceId, asin, "source-error");
      continue;
    }
    let recordCapturedAt: string;
    try {
      recordCapturedAt = normalizeRepositoryDateOnlyUtc(parsed.data.fetchedAt);
    } catch {
      addMissing(missing, sourceId, asin, "source-error");
      continue;
    }
    if (recordCapturedAt > dataCutoffAt) {
      addMissing(missing, sourceId, asin, "after-cutoff");
      continue;
    }
    records.push(parsed.data);
    capturedAt = latestTimestamp(capturedAt, recordCapturedAt);
  }

  if (records.length === 0 || !capturedAt) return null;
  return sourceId === "sorftime-review-analysis"
    ? {
        sourceId,
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
        marketplace: sourceMarketplace,
        capturedAt,
        records,
      }
    : {
        sourceId,
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
        marketplace: sourceMarketplace,
        capturedAt,
        records,
      };
}

function addMissing(
  target: MissingVocSource[],
  sourceId: VocSnapshotSourceId,
  asin: string,
  reason: MissingVocSource["reason"],
) {
  target.push(MissingVocSourceSchema.parse({ sourceId, asin, reason }));
}

function latestTimestamp(current: string | null, candidate: string) {
  return current === null || candidate > current ? candidate : current;
}

function normalizeOrganizationId(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value
  ) {
    throw new TypeError("Invalid VOC organization identity");
  }
  return value;
}
