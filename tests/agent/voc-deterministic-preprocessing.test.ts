import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  VocDataSnapshotRecordSchema,
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
  type VocDataSnapshotRecord,
  type VocSnapshotSourceBundle,
} from "../../server/data/voc-data-snapshot";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import {
  VocDeterministicPreprocessingResultSchema,
  preprocessVocSnapshot,
} from "../../server/domain/voc/preprocess-voc-snapshot";
import * as vocPreprocessing from "../../server/domain/voc/preprocess-voc-snapshot";
import { repositoryVocCandidateFixture } from "./helpers/voc-positioning-fixture";

const IDS = {
  scooterSnapshot: "11111111-1111-4111-8111-111111111111",
  lightingSnapshot: "22222222-2222-4222-8222-222222222222",
  run: "33333333-3333-4333-8333-333333333333",
} as const;

const SYNTHETIC_ASINS = ["B000000001", "B000000002", "B000000003"] as const;

function alexaRecord(
  negatives: readonly string[],
  reviewCount = 100,
) {
  return {
    asin: SYNTHETIC_ASINS[0],
    attention: ["1. 普通关注：结构化主题。"],
    positives: ["【普通优点】"],
    negatives: [...negatives],
    unmet: ["希望普通需求。"],
    audiences: ["人群｜说明"],
    scenarios: ["场景｜说明"],
    motives: ["动机｜说明"],
    captureStatus: "dialog" as const,
    alexaReport: {
      title: "顾客评价深度分析",
      asin: SYNTHETIC_ASINS[0],
      rating: 4,
      reviewCount,
      prompt: "七问",
      overallConclusion: "结构化结论",
      captureStatus: "dialog" as const,
    },
  };
}

function reviewRecord(
  rows: readonly Readonly<{ label: string; sharePct: number }>[],
  sampledReviews = 100,
  options: Readonly<{
    asin?: string;
    fetchedAt?: string;
    family?: "scooter" | "lighting" | "generic";
    blockKey?: "consumerProfile" | "scenarios" | "unmet" | "positives" | "negatives" | "motives";
    blockLabel?: string;
    rowReason?: string;
  }> = {},
) {
  return {
    asin: options.asin ?? SYNTHETIC_ASINS[0],
    marketplace: "US" as const,
    sampledReviews,
    fetchedAt: options.fetchedAt ?? "2026-08-10",
    status: "ready" as const,
    ...(options.family ? { family: options.family } : {}),
    blocks: [
      {
        key: options.blockKey ?? ("negatives" as const),
        label: options.blockLabel ?? "差评",
        rows: rows.map((row) => ({
          ...row,
          reason: options.rowReason ?? "",
        })),
      },
    ],
  };
}

function sourceBundles(args: Readonly<{
  alexa?: ReturnType<typeof alexaRecord>;
  sorftime?: ReturnType<typeof reviewRecord> | readonly ReturnType<typeof reviewRecord>[];
  sellerSprite?: ReturnType<typeof reviewRecord> | readonly ReturnType<typeof reviewRecord>[];
}>): VocSnapshotSourceBundle[] {
  const bundles: VocSnapshotSourceBundle[] = [];
  if (args.alexa) {
    bundles.push({
      sourceId: "alexa-voc",
      type: "manual-voc",
      reference: VOC_SOURCE_REFERENCES.alexaVoc,
      marketplace: "US",
      capturedAt: "2026-08-10T23:59:59.999Z",
      records: [args.alexa],
    });
  }
  if (args.sorftime) {
    bundles.push({
      sourceId: "sorftime-review-analysis",
      type: "connector",
      reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
      marketplace: "US",
      capturedAt: "2026-08-10T23:59:59.999Z",
      records: Array.isArray(args.sorftime) ? args.sorftime : [args.sorftime],
    });
  }
  if (args.sellerSprite) {
    bundles.push({
      sourceId: "seller-sprite-review-analysis",
      type: "connector",
      reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
      marketplace: "US",
      capturedAt: "2026-08-10T23:59:59.999Z",
      records: Array.isArray(args.sellerSprite)
        ? args.sellerSprite
        : [args.sellerSprite],
    });
  }
  return bundles;
}

function syntheticSnapshot(
  bundles: readonly VocSnapshotSourceBundle[],
  id = "44444444-4444-4444-8444-444444444444",
) {
  const candidate = buildVocSnapshotCandidate({
    marketplace: "US",
    asins: SYNTHETIC_ASINS,
    dataCutoffAt: "2026-08-15T23:59:59.999Z",
    sourceBundles: bundles,
  });
  return VocDataSnapshotRecordSchema.parse({
    ...candidate,
    id,
    runId: IDS.run,
    createdAt: "2026-08-15T23:59:59.999Z",
  });
}

function realSnapshot(
  asins: readonly string[],
  id: string,
): VocDataSnapshotRecord {
  return VocDataSnapshotRecordSchema.parse({
    ...repositoryVocCandidateFixture(asins),
    id,
    runId: IDS.run,
    createdAt: "2026-08-15T23:59:59.999Z",
  });
}

function dimension(
  result: ReturnType<typeof preprocessVocSnapshot>,
  key: string,
) {
  const found = result.dimensions.find((item) => item.key === key);
  assert.ok(found);
  return found;
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index)).map(
      (tail) => [value, ...tail],
    ),
  );
}

function recomputeSerializedFactsDigest(
  value: ReturnType<typeof preprocessVocSnapshot>,
) {
  return canonicalJsonSha256({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    snapshot: {
      id: value.snapshot.id,
      runId: value.snapshot.runId,
      marketplace: value.snapshot.marketplace,
      asins: value.snapshot.asins,
      dataCutoffAt: value.snapshot.dataCutoffAt,
    },
    availability: value.availability.map((source) => ({
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      status: source.status,
      reference: source.reference,
      marketplace: source.marketplace,
      capturedAt: source.capturedAt,
      recordCount: source.recordCount,
      targetCount: source.targetCount,
      missingAsins: source.missingAsins,
      comparability: source.comparability,
      denominators: source.denominators,
    })),
    dimensions: value.dimensions,
    evidenceIndex: value.evidenceIndex,
  });
}

test("real scooter snapshot produces strict source-scoped facts and resolvable evidence", () => {
  const snapshot = realSnapshot(
    ["B07VY9Q95Q", "B0BPXRVWYK", "B07DYG1C9B"],
    IDS.scooterSnapshot,
  );
  const result = preprocessVocSnapshot(snapshot);

  assert.equal(result.schemaVersion, "1.0.0");
  assert.equal(result.kind, "voc-deterministic-preprocessing");
  assert.deepEqual(result.snapshot.asins, snapshot.asins);
  assert.deepEqual(
    result.availability.map((source) => [
      source.sourceId,
      source.status,
      source.recordCount,
    ]),
    [
      ["alexa-voc", "available", 3],
      ["sorftime-review-analysis", "available", 3],
      ["seller-sprite-review-analysis", "available", 3],
    ],
  );
  assert.deepEqual(
    result.dimensions.map((item) => item.key),
    [
      "attention",
      "positives",
      "negatives",
      "unmet",
      "audiences",
      "scenarios",
      "motives",
    ],
  );

  const durability = dimension(result, "positives").themes.find(
    (theme) => theme.label === "耐用性 / 结构强度",
  );
  assert.ok(durability);
  assert.deepEqual(
    durability.metrics
      .filter(
        (metric) =>
          metric.asin === "B07VY9Q95Q" && metric.sourceId !== "alexa-voc",
      )
      .map((metric) => [
        metric.sourceId,
        metric.mentionCount,
        metric.sampleCount,
        metric.mentionPct,
      ]),
    [
      ["sorftime-review-analysis", null, 100, 12.1],
      ["seller-sprite-review-analysis", null, 99, 13.13],
    ],
  );
  const evidenceIds = new Set(result.evidenceIndex.map((evidence) => evidence.id));
  assert.equal(
    result.dimensions.every((item) =>
      item.themes.every((theme) =>
        theme.evidenceIds.every((id) => evidenceIds.has(id)),
      ),
    ),
    true,
  );
  assert.equal(
    result.evidenceIndex.every(
      (evidence) =>
        evidence.snapshotId === snapshot.id &&
        evidence.runId === snapshot.runId &&
        evidence.marketplace === snapshot.marketplace &&
        snapshot.asins.includes(evidence.asin),
    ),
    true,
  );
  assert.deepEqual(
    VocDeterministicPreprocessingResultSchema.parse(result),
    result,
  );
  assert.equal(Object.isFrozen(result), true);
  assert.match(result.factsDigest, /^[a-f0-9]{64}$/);
});

test("real lighting snapshot reports unavailable sources without fabricating zero facts", () => {
  const snapshot = realSnapshot(
    ["B08Z36X6B4", "B0D77D5WKD", "B0BVFX154J"],
    IDS.lightingSnapshot,
  );
  const result = preprocessVocSnapshot(snapshot);

  assert.deepEqual(
    result.availability.map((source) => [
      source.sourceId,
      source.status,
      source.recordCount,
      source.comparability,
    ]),
    [
      ["alexa-voc", "unavailable", 0, "unknown"],
      ["sorftime-review-analysis", "available", 3, "not-comparable"],
      ["seller-sprite-review-analysis", "unavailable", 0, "unknown"],
    ],
  );
  const facts = result.dimensions.flatMap((item) =>
    item.themes.flatMap((theme) => theme.metrics),
  );
  assert.equal(facts.some((metric) => metric.sourceId === "alexa-voc"), false);
  assert.equal(
    facts.every(
      (metric) =>
        metric.sourceId !== "sorftime-review-analysis" ||
        (metric.mentionCount === null && metric.sampleCount !== null),
    ),
    true,
  );
  assert.equal(
    facts.some(
      (metric) =>
        metric.mentionCount === 0 ||
        metric.sampleCount === 0 ||
        metric.mentionPct === 0,
    ),
    false,
  );
  assert.deepEqual(
    VocDeterministicPreprocessingResultSchema.parse(result),
    result,
  );
});

test("partial three-source conflicts remain independent and do not create an aggregate percentage", () => {
  const snapshot = syntheticSnapshot(
    sourceBundles({
      alexa: alexaRecord(["【普通问题】约 2% 评论提及（2 条）"]),
      sorftime: reviewRecord([{ label: "普通问题", sharePct: 6 }]),
      sellerSprite: reviewRecord([{ label: "普通问题", sharePct: 11 }]),
    }),
  );
  const result = preprocessVocSnapshot(snapshot);
  const theme = dimension(result, "negatives").themes.find(
    (item) => item.label === "普通问题",
  );
  assert.ok(theme);
  assert.deepEqual(
    theme.metrics.map((metric) => [metric.sourceId, metric.mentionPct]),
    [
      ["alexa-voc", 2],
      ["sorftime-review-analysis", 6],
      ["seller-sprite-review-analysis", 11],
    ],
  );
  assert.equal("mentionPct" in theme, false);
  assert.equal(theme.priority.level, "P0");
  assert.deepEqual(
    result.availability.map((source) => source.status),
    ["partial", "partial", "partial"],
  );
});

test("synonyms merge deterministically while identical evidence rows deduplicate", () => {
  const snapshot = syntheticSnapshot(
    sourceBundles({
      sorftime: reviewRecord([
        { label: "  Durability  ", sharePct: 10 },
        { label: "耐用性", sharePct: 10 },
        { label: "  Durability  ", sharePct: 10 },
      ]),
    }),
  );
  const result = preprocessVocSnapshot(snapshot);
  const durability = dimension(result, "negatives").themes.find(
    (theme) => theme.label === "耐用性 / 结构强度",
  );
  assert.ok(durability);
  assert.equal(durability.metrics.length, 2);
  assert.equal(durability.evidenceIds.length, 2);
  assert.equal(durability.priority.level, "P2");
});

test("canonical display labels are stable for colliding keys across all sources", () => {
  const labels = ["Foo Bar", "foobar", "  Foo   Bar  "] as const;
  const pctByLabel = new Map<string, number>([
    ["Foo Bar", 5],
    ["foobar", 6],
    ["  Foo   Bar  ", 7],
  ]);
  const outputs = permutations(labels).map((orderedLabels) =>
    preprocessVocSnapshot(
      syntheticSnapshot(
        sourceBundles({
          alexa: alexaRecord(
            orderedLabels.map(
              (label) => `【${label}】约 ${pctByLabel.get(label)}% 评论提及`,
            ),
          ),
          sorftime: reviewRecord(
            orderedLabels.map((label) => ({
              label,
              sharePct: pctByLabel.get(label)!,
            })),
          ),
          sellerSprite: reviewRecord(
            orderedLabels.map((label) => ({
              label,
              sharePct: pctByLabel.get(label)!,
            })),
          ),
        }),
      ),
    ),
  );
  const expectedDimensions = outputs[0]!.dimensions;
  const expectedEvidence = outputs[0]!.evidenceIndex;
  const expectedDigest = outputs[0]!.factsDigest;
  for (const output of outputs) {
    assert.deepEqual(output.dimensions, expectedDimensions);
    assert.deepEqual(output.evidenceIndex, expectedEvidence);
    assert.equal(output.factsDigest, expectedDigest);
    const theme = dimension(output, "negatives").themes.find(
      (candidate) => candidate.key === "foobar",
    );
    assert.ok(theme);
    assert.equal(theme.label, "Foo Bar");
    assert.equal(theme.metrics.length, 9);
  }
});

test("semantic Alexa headers are ignored in every row permutation", () => {
  const tables = {
    audiences: [
      "人群分类｜特征",
      "家庭用户｜多人共同使用",
      "专业用户｜高频使用",
    ],
    scenarios: [
      "场景｜说明与示例",
      "室内使用｜居家环境",
      "户外使用｜社区环境",
    ],
    motives: [
      "动机｜重要性｜说明",
      "产品质量｜★★★★★｜长期使用",
      "性价比｜★★★★☆｜预算考虑",
    ],
  } as const;

  for (const [key, lines] of Object.entries(tables) as Array<
    [keyof typeof tables, readonly string[]]
  >) {
    const outputs = permutations(lines).map((orderedLines) => {
      const record = alexaRecord(["【普通问题】约 5% 评论提及"]);
      return preprocessVocSnapshot(
        syntheticSnapshot(
          sourceBundles({
            alexa: { ...record, [key]: orderedLines },
          }),
        ),
      );
    });
    const expected = dimension(outputs[0]!, key);
    assert.equal(expected.themes.length, 2);
    for (const output of outputs) {
      const actual = dimension(output, key);
      assert.deepEqual(actual, expected);
      assert.equal(
        actual.themes.some((theme) =>
          ["人群分类", "场景", "动机"].includes(theme.label),
        ),
        false,
      );
      assert.equal(output.factsDigest, outputs[0]!.factsDigest);
    }
  }
});

test("source presence cannot recanonicalize another source family", () => {
  const genericSorftime = reviewRecord([
    { label: "LED lighting issue", sharePct: 6 },
  ]);
  const baseline = preprocessVocSnapshot(
    syntheticSnapshot(sourceBundles({ sorftime: genericSorftime })),
  );
  const withScooterSeller = preprocessVocSnapshot(
    syntheticSnapshot(
      sourceBundles({
        sorftime: genericSorftime,
        sellerSprite: reviewRecord(
          [{ label: "普通卖家问题", sharePct: 7 }],
          100,
          { family: "scooter" },
        ),
      }),
    ),
  );
  const sourceProjection = (
    result: ReturnType<typeof preprocessVocSnapshot>,
    sourceId: string,
  ) => ({
    metrics: result.dimensions.flatMap((item) =>
      item.themes.flatMap((theme) =>
        theme.metrics
          .filter((metric) => metric.sourceId === sourceId)
          .map((metric) => ({ themeKey: theme.key, themeLabel: theme.label, metric })),
      ),
    ),
    evidence: result.evidenceIndex.filter(
      (evidence) => evidence.sourceId === sourceId,
    ),
  });
  assert.deepEqual(
    sourceProjection(withScooterSeller, "sorftime-review-analysis"),
    sourceProjection(baseline, "sorftime-review-analysis"),
  );

  const scooterSorftime = reviewRecord(
    [{ label: "LED lighting issue", sharePct: 6 }],
    100,
    { family: "scooter" },
  );
  const scooterOnly = preprocessVocSnapshot(
    syntheticSnapshot(sourceBundles({ sorftime: scooterSorftime })),
  );
  const withConflictingLighting = preprocessVocSnapshot(
    syntheticSnapshot(
      sourceBundles({
        sorftime: scooterSorftime,
        sellerSprite: reviewRecord(
          [{ label: "普通照明问题", sharePct: 7 }],
          100,
          { family: "lighting" },
        ),
      }),
    ),
  );
  assert.deepEqual(
    sourceProjection(withConflictingLighting, "sorftime-review-analysis"),
    sourceProjection(scooterOnly, "sorftime-review-analysis"),
  );

  const alexaOnly = preprocessVocSnapshot(
    syntheticSnapshot(sourceBundles({ alexa: alexaRecord(["【Brightness】约 6% 评论提及"]) })),
  );
  const alexaWithLightingReview = preprocessVocSnapshot(
    syntheticSnapshot(
      sourceBundles({
        alexa: alexaRecord(["【Brightness】约 6% 评论提及"]),
        sorftime: reviewRecord(
          [{ label: "普通问题", sharePct: 7 }],
          100,
          { family: "lighting" },
        ),
      }),
    ),
  );
  assert.deepEqual(
    sourceProjection(alexaWithLightingReview, "alexa-voc"),
    sourceProjection(alexaOnly, "alexa-voc"),
  );
});

test("review metrics preserve canonical per-record capture time", () => {
  const snapshot = syntheticSnapshot(
    sourceBundles({
      sorftime: [
        reviewRecord([{ label: "早期问题", sharePct: 5 }], 100, {
          asin: SYNTHETIC_ASINS[0],
          fetchedAt: "2026-08-01",
        }),
        reviewRecord([{ label: "近期问题", sharePct: 6 }], 100, {
          asin: SYNTHETIC_ASINS[1],
          fetchedAt: "2026-08-10",
        }),
      ],
    }),
  );
  const result = preprocessVocSnapshot(snapshot);
  const metrics = result.dimensions
    .flatMap((item) => item.themes.flatMap((theme) => theme.metrics))
    .filter((metric) => metric.sourceId === "sorftime-review-analysis")
    .sort((left, right) =>
      left.asin < right.asin ? -1 : left.asin > right.asin ? 1 : 0,
    );
  assert.deepEqual(
    metrics.map((metric) => [metric.asin, metric.capturedAt]),
    [
      [SYNTHETIC_ASINS[0], "2026-08-01T23:59:59.999Z"],
      [SYNTHETIC_ASINS[1], "2026-08-10T23:59:59.999Z"],
    ],
  );
  assert.equal(
    result.availability.find(
      (source) => source.sourceId === "sorftime-review-analysis",
    )?.capturedAt,
    "2026-08-10T23:59:59.999Z",
  );
  assert.deepEqual(
    result.availability
      .find((source) => source.sourceId === "sorftime-review-analysis")
      ?.denominators.map((denominator) => [
        denominator.asin,
        (denominator as typeof denominator & { recordCapturedAt?: string })
          .recordCapturedAt,
        (denominator as typeof denominator & { family?: string }).family,
      ]),
    [
      [SYNTHETIC_ASINS[0], "2026-08-01T23:59:59.999Z", "generic"],
      [SYNTHETIC_ASINS[1], "2026-08-10T23:59:59.999Z", "generic"],
    ],
  );
  assert.throws(() =>
    preprocessVocSnapshot(
      syntheticSnapshot(
        sourceBundles({
          sorftime: reviewRecord(
            [{ label: "未来问题", sharePct: 5 }],
            100,
            { fetchedAt: "2026-08-11" },
          ),
        }),
      ),
    ),
  );
});

test("whitelist facts digest separates semantic facts from snapshot provenance", () => {
  const baseAlexa = alexaRecord(["【普通问题】约 5% 评论提及"]);
  const baseReview = reviewRecord(
    [{ label: "LED lighting issue", sharePct: 6 }],
    100,
    {
      family: "generic",
      blockKey: "negatives",
      blockLabel: "差评展示名",
      rowReason: "展示原因 alpha",
    },
  );
  const baseSnapshot = syntheticSnapshot(
    sourceBundles({ alexa: baseAlexa, sorftime: baseReview }),
  );
  const nonSemanticSnapshot = syntheticSnapshot(
    sourceBundles({
      alexa: {
        ...baseAlexa,
        alexaReport: {
          ...baseAlexa.alexaReport,
          title: "仅展示的新标题",
          rating: 3.5,
          prompt: "不得进入白名单的完整提示",
          overallConclusion: "不得泄漏的长结论",
        },
      },
      sorftime: reviewRecord(
        [{ label: "LED lighting issue", sharePct: 6 }],
        100,
        {
          family: "generic",
          blockKey: "negatives",
          blockLabel: "另一个展示名",
          rowReason: "不得泄漏的评论原因 beta",
        },
      ),
    }),
  );
  const base = preprocessVocSnapshot(baseSnapshot);
  const nonSemantic = preprocessVocSnapshot(nonSemanticSnapshot);
  const baseContract = base as typeof base & { factsDigest?: string };
  const nonSemanticContract = nonSemantic as typeof nonSemantic & {
    factsDigest?: string;
  };
  assert.equal(typeof baseContract.factsDigest, "string");
  assert.equal(baseContract.factsDigest, nonSemanticContract.factsDigest);
  assert.notEqual(baseSnapshot.contentHash, nonSemanticSnapshot.contentHash);
  const baseChecksums = base.availability.map(
    (source) => (source as typeof source & { sourceChecksum?: string | null }).sourceChecksum,
  );
  const changedChecksums = nonSemantic.availability.map(
    (source) => (source as typeof source & { sourceChecksum?: string | null }).sourceChecksum,
  );
  assert.notDeepEqual(baseChecksums, changedChecksums);
  assert.deepEqual(baseChecksums, [
    baseSnapshot.sources[0]?.checksum,
    baseSnapshot.sources[1]?.checksum,
    null,
  ]);
  assert.equal(base.snapshot.contentHash, baseSnapshot.contentHash);
  assert.equal(baseChecksums.every((checksum) => checksum === null || typeof checksum === "string"), true);
  assert.equal("canonicalDigest" in base, false);
  const serialized = JSON.stringify(nonSemantic);
  for (const excluded of [
    "仅展示的新标题",
    "不得进入白名单的完整提示",
    "不得泄漏的长结论",
    "另一个展示名",
    "不得泄漏的评论原因 beta",
  ]) {
    assert.equal(serialized.includes(excluded), false, excluded);
  }

  const semanticSnapshots = [
    syntheticSnapshot(
      sourceBundles({
        alexa: baseAlexa,
        sorftime: reviewRecord([{ label: "changed label", sharePct: 6 }]),
      }),
    ),
    syntheticSnapshot(
      sourceBundles({
        alexa: baseAlexa,
        sorftime: reviewRecord([{ label: "LED lighting issue", sharePct: 9 }]),
      }),
    ),
    syntheticSnapshot(
      sourceBundles({
        alexa: baseAlexa,
        sorftime: reviewRecord(
          [{ label: "LED lighting issue", sharePct: 6 }],
          100,
          { fetchedAt: "2026-08-09" },
        ),
      }),
    ),
    syntheticSnapshot(
      sourceBundles({
        alexa: baseAlexa,
        sorftime: reviewRecord(
          [{ label: "LED lighting issue", sharePct: 6 }],
          100,
          { family: "scooter" },
        ),
      }),
    ),
    syntheticSnapshot(
      sourceBundles({
        alexa: baseAlexa,
        sorftime: reviewRecord(
          [{ label: "LED lighting issue", sharePct: 6 }],
          100,
          { blockKey: "positives" },
        ),
      }),
    ),
  ];
  for (const semanticSnapshot of semanticSnapshots) {
    const semantic = preprocessVocSnapshot(semanticSnapshot) as typeof base & {
      factsDigest?: string;
    };
    assert.notEqual(semantic.factsDigest, baseContract.factsDigest);
  }
  assert.equal(
    typeof (vocPreprocessing as Record<string, unknown>)
      .parseVocDeterministicPreprocessingResult,
    "function",
  );
});

test("serialized result integrity rejects closed semantic mutations", () => {
  const result = preprocessVocSnapshot(
    syntheticSnapshot(
      sourceBundles({
        alexa: alexaRecord(["【普通问题】约 5% 评论提及"]),
        sorftime: reviewRecord([{ label: "普通问题", sharePct: 6 }]),
        sellerSprite: reviewRecord([{ label: "普通问题", sharePct: 7 }]),
      }),
    ),
  );
  type SerializedResult = ReturnType<typeof preprocessVocSnapshot>;
  const mutations: Array<
    readonly [string, (value: SerializedResult) => void]
  > = [
    ["stale facts digest", (value) => { value.factsDigest = "0".repeat(64); }],
    ["dangling evidence", (value) => {
      dimension(value, "negatives").themes[0]!.evidenceIds[0] = "f".repeat(64);
    }],
    ["cross ASIN evidence", (value) => { value.evidenceIndex[0]!.asin = SYNTHETIC_ASINS[1]; }],
    ["cross snapshot evidence", (value) => { value.evidenceIndex[0]!.snapshotId = IDS.lightingSnapshot; }],
    ["cross run evidence", (value) => { value.evidenceIndex[0]!.runId = IDS.lightingSnapshot; }],
    ["cross source evidence", (value) => { value.evidenceIndex[0]!.sourceId = "sorftime-review-analysis"; }],
    ["wrong source type", (value) => { value.evidenceIndex[0]!.sourceType = "connector"; }],
    ["wrong source reference", (value) => { value.evidenceIndex[0]!.sourceReference = VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis; }],
    ["wrong marketplace", (value) => { value.evidenceIndex[0]!.marketplace = "CA"; }],
    ["offset record time", (value) => { value.evidenceIndex[0]!.capturedAt = "2026-08-10T15:59:59.999-08:00"; }],
    ["late record time", (value) => { value.evidenceIndex[0]!.capturedAt = "2026-08-11T23:59:59.999Z"; }],
    ["wrong record key", (value) => { value.evidenceIndex[0]!.recordKey = "1".repeat(64); }],
    ["wrong dimension", (value) => { value.evidenceIndex[0]!.dimension = "positives"; }],
    ["wrong canonical key", (value) => { value.evidenceIndex[0]!.themeKey = "changed"; }],
    ["wrong family", (value) => { value.evidenceIndex[0]!.family = "scooter"; }],
    ["wrong raw label", (value) => { value.evidenceIndex[0]!.rawLabel = "changed"; }],
    ["wrong basis", (value) => {
      const evidence = value.evidenceIndex.find(
        (candidate) => candidate.basis !== "presence-only",
      );
      assert.ok(evidence);
      evidence.basis = "presence-only";
    }],
    ["orphan evidence", (value) => {
      value.evidenceIndex.push({ ...value.evidenceIndex[0]!, id: "e".repeat(64) });
    }],
    ["duplicate evidence", (value) => { value.evidenceIndex.push({ ...value.evidenceIndex[0]! }); }],
    ["duplicate target ASINs with synchronized derived fields", (value) => {
      value.snapshot.asins[2] = value.snapshot.asins[1]!;
      for (const availability of value.availability) {
        const denominatorAsins = new Set(
          availability.denominators.map((denominator) => denominator.asin),
        );
        availability.missingAsins = value.snapshot.asins.filter(
          (asin) => !denominatorAsins.has(asin),
        );
      }
    }],
    ["duplicate source", (value) => { value.availability[1] = structuredClone(value.availability[0]!); }],
    ["missing source checksum", (value) => { value.availability[0]!.sourceChecksum = null; }],
    ["wrong availability type", (value) => { value.availability[0]!.sourceType = "connector"; }],
    ["wrong availability reference", (value) => { value.availability[0]!.reference = VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis; }],
    ["wrong availability marketplace", (value) => { value.availability[0]!.marketplace = "CA"; }],
    ["offset source time", (value) => { value.availability[0]!.capturedAt = "2026-08-10T15:59:59.999-08:00"; }],
    ["wrong source status", (value) => { value.availability[0]!.status = "available"; }],
    ["wrong missing ASINs", (value) => { value.availability[0]!.missingAsins = []; }],
    ["wrong denominator", (value) => { value.availability[0]!.denominators[0]!.sampleCount = 99; }],
    ["wrong record scope time", (value) => { value.availability[0]!.denominators[0]!.recordCapturedAt = "2026-08-09T23:59:59.999Z"; }],
    ["wrong record scope family", (value) => { value.availability[0]!.denominators[0]!.family = "scooter"; }],
    ["wrong source record count", (value) => { value.availability[0]!.recordCount += 1; }],
    ["duplicate dimension", (value) => { value.dimensions[1] = structuredClone(value.dimensions[0]!); }],
    ["wrong dimension label", (value) => { value.dimensions[0]!.label = "changed"; }],
    ["duplicate theme", (value) => {
      const themes = dimension(value, "negatives").themes;
      themes.push(structuredClone(themes[0]!));
    }],
    ["wrong theme label", (value) => { dimension(value, "negatives").themes[0]!.label = "changed"; }],
    ["wrong theme family", (value) => { dimension(value, "negatives").themes[0]!.family = "scooter"; }],
    ["wrong priority", (value) => {
      dimension(value, "negatives").themes[0]!.priority = {
        level: "P3",
        reasons: ["negatives<5:1"],
        cannotDowngradeReason: null,
        safetyRule: null,
      };
    }],
    ["wrong metric", (value) => { dimension(value, "negatives").themes[0]!.metrics[0]!.mentionPct = 8; }],
    ["cross source metric", (value) => { dimension(value, "negatives").themes[0]!.metrics[0]!.sourceId = "sorftime-review-analysis"; }],
    ["cross ASIN metric", (value) => { dimension(value, "negatives").themes[0]!.metrics[0]!.asin = SYNTHETIC_ASINS[1]; }],
    ["offset metric time", (value) => { dimension(value, "negatives").themes[0]!.metrics[0]!.capturedAt = "2026-08-10T15:59:59.999-08:00"; }],
    ["wrong metric record key", (value) => { dimension(value, "negatives").themes[0]!.metrics[0]!.recordKey = "2".repeat(64); }],
    ["wrong metric raw label", (value) => { dimension(value, "negatives").themes[0]!.metrics[0]!.rawLabel = "changed"; }],
    ["duplicate metric", (value) => {
      dimension(value, "negatives").themes[0]!.metrics.push(
        structuredClone(dimension(value, "negatives").themes[0]!.metrics[0]!),
      );
    }],
    ["evidence list differs from metrics", (value) => {
      dimension(value, "negatives").themes[0]!.evidenceIds.reverse();
    }],
  ];

  for (const [name, mutate] of mutations) {
    const serialized = JSON.parse(JSON.stringify(result)) as SerializedResult;
    mutate(serialized);
    if (name !== "stale facts digest") {
      serialized.factsDigest = recomputeSerializedFactsDigest(serialized);
    }
    assert.equal(
      VocDeterministicPreprocessingResultSchema.safeParse(serialized).success,
      false,
      name,
    );
  }
});

test("public serialized result parser validates and deeply freezes JSON", () => {
  const result = preprocessVocSnapshot(
    syntheticSnapshot(
      sourceBundles({
        sorftime: reviewRecord([{ label: "普通问题", sharePct: 6 }]),
      }),
    ),
  );
  const parser = (
    vocPreprocessing as typeof vocPreprocessing & {
      parseVocDeterministicPreprocessingResult: (input: unknown) => typeof result;
    }
  ).parseVocDeterministicPreprocessingResult;
  const parsed = parser(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(parsed, result);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.availability), true);
  assert.equal(Object.isFrozen(parsed.dimensions[0]?.themes), true);
  assert.equal(Object.isFrozen(parsed.evidenceIndex[0]), true);
});

test("zero denominators and missing statistics remain unknown while safety remains P0", () => {
  const snapshot = syntheticSnapshot(
    sourceBundles({
      alexa: alexaRecord(["【普通问题】3 条", "【结构断裂】没有统计口径"], 0),
      sorftime: reviewRecord([{ label: "结构稳固", sharePct: 99 }]),
    }),
  );
  const result = preprocessVocSnapshot(snapshot);
  const ordinary = dimension(result, "negatives").themes.find(
    (theme) => theme.label === "普通问题",
  );
  const durability = dimension(result, "negatives").themes.find(
    (theme) => theme.label === "耐用性 / 结构强度",
  );
  assert.ok(ordinary);
  assert.ok(durability);
  assert.deepEqual(
    ordinary.metrics.map((metric) => [
      metric.mentionCount,
      metric.sampleCount,
      metric.mentionPct,
    ]),
    [[3, 0, null]],
  );
  assert.equal(ordinary.priority.level, "unknown");
  assert.equal(durability.priority.level, "P0");
  assert.notEqual(durability.priority.safetyRule, null);
  assert.match(durability.priority.cannotDowngradeReason ?? "", /cannot be downgraded/);
  assert.equal(result.availability[0]?.comparability, "partial");
});

test("strict boundaries reject unknown and non-finite input and output fields", () => {
  const snapshot = syntheticSnapshot(
    sourceBundles({
      sorftime: reviewRecord([{ label: "普通问题", sharePct: 5 }]),
    }),
  );
  assert.throws(() => preprocessVocSnapshot({ ...snapshot, extra: true }));
  const nonFinite = structuredClone(snapshot) as unknown as {
    payload: { records: { sorftimeReviewAnalysis: Array<{ blocks: Array<{ rows: Array<{ sharePct: number }> }> }> } };
  };
  nonFinite.payload.records.sorftimeReviewAnalysis[0]!.blocks[0]!.rows[0]!.sharePct = Number.NaN;
  assert.throws(() => preprocessVocSnapshot(nonFinite));
  for (const invalid of [Number.POSITIVE_INFINITY, -1, 101]) {
    const invalidPct = structuredClone(snapshot) as unknown as {
      payload: { records: { sorftimeReviewAnalysis: Array<{ blocks: Array<{ rows: Array<{ sharePct: number }> }> }> } };
    };
    invalidPct.payload.records.sorftimeReviewAnalysis[0]!.blocks[0]!.rows[0]!.sharePct = invalid;
    assert.throws(() => preprocessVocSnapshot(invalidPct));
  }

  const result = preprocessVocSnapshot(snapshot);
  assert.equal(
    VocDeterministicPreprocessingResultSchema.safeParse({
      ...result,
      extra: true,
    }).success,
    false,
  );
});

test("semantic facts and digest are stable across row permutation and repeated runs", () => {
  const forward = syntheticSnapshot(
    sourceBundles({
      sorftime: reviewRecord([
        { label: "普通乙", sharePct: 5 },
        { label: "普通甲", sharePct: 5 },
      ]),
    }),
  );
  const reverse = syntheticSnapshot(
    sourceBundles({
      sorftime: reviewRecord([
        { label: "普通甲", sharePct: 5 },
        { label: "普通乙", sharePct: 5 },
      ]),
    }),
  );
  assert.notEqual(forward.contentHash, reverse.contentHash);

  const first = preprocessVocSnapshot(forward);
  const repeated = preprocessVocSnapshot(forward);
  const permuted = preprocessVocSnapshot(reverse);
  assert.deepEqual(first, repeated);
  assert.deepEqual(first.dimensions, permuted.dimensions);
  assert.deepEqual(first.evidenceIndex, permuted.evidenceIndex);
  assert.equal(first.factsDigest, permuted.factsDigest);
});

test("preprocessing does not mutate callers and deeply freezes every returned fact", () => {
  const snapshot = syntheticSnapshot(
    sourceBundles({
      sorftime: reviewRecord([{ label: "普通问题", sharePct: 5 }]),
    }),
  );
  const before = structuredClone(snapshot);
  const result = preprocessVocSnapshot(snapshot);
  assert.deepEqual(snapshot, before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.dimensions), true);
  assert.equal(Object.isFrozen(result.dimensions[0]?.themes), true);
  assert.equal(Object.isFrozen(result.evidenceIndex[0]), true);
  assert.throws(() => {
    (result.snapshot.asins as string[]).push("B000000009");
  });
});

test("ordinary Node can import preprocessing without app, browser, database, or network dependencies", () => {
  const loaded = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      "import('./server/domain/voc/preprocess-voc-snapshot.ts').then(m=>{if(typeof m.preprocessVocSnapshot!=='function'||typeof m.parseVocDeterministicPreprocessingResult!=='function'||!m.VocDeterministicPreprocessingResultSchema)process.exit(2)})",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(loaded.status, 0, loaded.stderr);

  const source = readFileSync(
    new URL("../../server/domain/voc/preprocess-voc-snapshot.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*(?:react|vinext|browser|mcp|cursor|codex|sqlite|database|fetch|http)[^"']*["']/i,
  );
  assert.doesNotMatch(source, /Math\.random|Date\.now|new\s+Date\s*\(\s*\)/);
});
