import {
  rufusVocData,
  rufusVocMeta,
} from "../../app/rufus-voc-data";
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
  MarketplaceSchema,
} from "../../shared/agent-contracts";
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

interface StaticAlexaSource {
  readonly meta: Readonly<{ capturedAt: string }>;
  readonly data: Readonly<Record<string, unknown>>;
}

interface StaticReviewSource {
  readonly meta: Readonly<{ marketplace: string }>;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface RepositoryVocSources {
  readonly alexa: StaticAlexaSource;
  readonly sorftime: StaticReviewSource;
  readonly sellerSprite: StaticReviewSource;
}

export interface RepositoryVocReadInput {
  readonly marketplace: string;
  readonly asins: readonly string[];
  readonly dataCutoffAt: string;
}

export interface RepositoryVocReadResult {
  readonly candidate: VocSnapshotCandidate | null;
  readonly missingSources: readonly MissingVocSource[];
  readonly recordCount: number;
}

const defaultSources: RepositoryVocSources = {
  alexa: { meta: rufusVocMeta, data: rufusVocData },
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
  readonly #sources: RepositoryVocSources;

  constructor(sources: RepositoryVocSources = defaultSources) {
    this.#sources = sources;
  }

  read(input: RepositoryVocReadInput): RepositoryVocReadResult {
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

    const alexa = readAlexaSource(
      this.#sources.alexa,
      asins,
      dataCutoffAt,
      missingSources,
    );
    if (alexa) sourceBundles.push(alexa);

    const sorftime = readReviewSource(
      "sorftime-review-analysis",
      this.#sources.sorftime,
      asins,
      marketplace,
      dataCutoffAt,
      missingSources,
    );
    if (sorftime) sourceBundles.push(sorftime);

    const sellerSprite = readReviewSource(
      "seller-sprite-review-analysis",
      this.#sources.sellerSprite,
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

function readAlexaSource(
  source: StaticAlexaSource,
  asins: readonly string[],
  dataCutoffAt: string,
  missing: MissingVocSource[],
): Extract<VocSnapshotSourceBundle, { sourceId: "alexa-voc" }> | null {
  const records = [] as Array<
    ReturnType<typeof AlexaVocSnapshotRecordSchema.parse>
  >;
  let capturedAt: string | null = null;

  for (const asin of asins) {
    const raw = source.data[asin];
    if (!raw || typeof raw !== "object") {
      addMissing(missing, "alexa-voc", asin, "not-found");
      continue;
    }
    const status = Reflect.get(raw, "captureStatus");
    if (status === "pending") {
      addMissing(missing, "alexa-voc", asin, "pending");
      continue;
    }
    if (status !== "dialog") {
      addMissing(missing, "alexa-voc", asin, "source-error");
      continue;
    }
    let recordCapturedAt: string;
    try {
      recordCapturedAt = normalizeRepositoryDateOnlyUtc(source.meta.capturedAt);
    } catch {
      addMissing(missing, "alexa-voc", asin, "source-error");
      continue;
    }
    if (recordCapturedAt > dataCutoffAt) {
      addMissing(missing, "alexa-voc", asin, "after-cutoff");
      continue;
    }
    const parsed = AlexaVocSnapshotRecordSchema.safeParse({ ...raw, asin });
    if (!parsed.success) {
      addMissing(missing, "alexa-voc", asin, "source-error");
      continue;
    }
    records.push(parsed.data);
    capturedAt = latestTimestamp(capturedAt, recordCapturedAt);
  }

  return records.length === 0 || !capturedAt
    ? null
    : {
        sourceId: "alexa-voc",
        type: "manual-voc",
        reference: VOC_SOURCE_REFERENCES.alexaVoc,
        capturedAt,
        records,
      };
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
      source.meta.marketplace.trim().toUpperCase() !== marketplace ||
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
        capturedAt,
        records,
      }
    : {
        sourceId,
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
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
