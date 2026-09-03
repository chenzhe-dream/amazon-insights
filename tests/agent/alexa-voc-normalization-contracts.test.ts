import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
  ManualAlexaVocNormalizedRecordSchema,
} from "../../shared/agent-contracts";
import {
  AlexaVocMatrixRecordSchema,
  AlexaVocNormalizationFactsSchema,
  AlexaVocNormalizationInputSchema,
  AlexaVocNormalizationOutputSchema,
  canonicalizeAlexaVocNormalizationOutputRecord,
  createAlexaVocNormalizationFingerprint,
} from "../../server/domain/voc/alexa-voc-normalization-contracts";
import { createStructuredResponseFormat } from "../../server/runtime/structured-response-format";
import {
  AmazonVocInsightOutputSchema,
  AmazonVocInsightShapeSchema,
} from "../../server/domain/voc/amazon-voc-insight-contracts";

const record = {
  attention: ["1. 产品质量：买家关注耐用性。"],
  positives: ["【耐用】约 6.1% 评论提及（1,264 条）"],
  negatives: ["【重量】评论分散提及（搬运时较费力）"],
  unmet: ["1. 希望产品更轻。"],
  audiences: ["人群分类｜特征", "家庭用户｜重视耐用性"],
  scenarios: ["场景｜说明与示例", "家庭使用｜日常高频使用"],
  motives: ["动机｜重要性｜说明", "可靠性｜⭐⭐⭐⭐⭐｜耐用证据"],
  captureStatus: "dialog",
  alexaReport: {
    title: "顾客评价深度分析",
    asin: "B07VY9Q95Q",
    rating: 4.5,
    reviewCount: 100,
    prompt: MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
    overallConclusion: "买家重视耐用性。",
    captureStatus: "dialog",
  },
} as const;

const factualRecord = {
  attention: [{
    title: "产品质量",
    detail: "买家关注耐用性",
    dimension: "Quality",
    mentions: 1264,
    evidenceQuote: "1,264 条提及",
  }],
  positives: [{ label: "耐用", detail: "长期使用仍稳定", mentions: 1264, evidenceQuote: "1,264 条提及" }],
  negatives: [{ label: "重量", detail: "搬运时较费力", mentions: null, evidenceQuote: null }],
  unmet: [{ detail: "希望产品更轻" }],
  audiences: [{ category: "家庭用户", detail: "重视耐用性" }],
  scenarios: [{ name: "家庭使用", detail: "日常高频使用" }],
  motives: [{ label: "可靠性", importance: 5, detail: "耐用证据", mentions: null, evidenceQuote: null }],
  overallConclusion: "买家重视耐用性。",
} as const;

const factsOnlyInstruction = "Normalization facts mode for AlexaVocNormalizationOutput@1.1.0: return all seven fact arrays and overallConclusion only; mentions and evidenceQuote are required nullable fields, and a non-null mention needs an exact raw-text quote containing that count; do not return page-header fields.";

const executionIdentity = {
  providerName: "local-fixture",
  model: {
    name: "fake-model",
    estimatedInputTokens: 100,
    maxOutputTokens: 200,
    timeoutMs: 1_000,
    pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
  },
} as const;

const renderFacts = canonicalizeAlexaVocNormalizationOutputRecord as unknown as (
  facts: unknown,
  context: unknown,
) => ReturnType<typeof ManualAlexaVocNormalizedRecordSchema.parse>;

const rendererContext = {
  asin: "B07VY9Q95Q",
  rawText: "ASIN B07VY9Q95Q 的 Alexa 报告：1,264 条提及。",
  knownMeta: {
    rating: 4.5,
    reviewCount: 20_700,
    starBreakdown: null,
    capturedAt: "2026-09-01T00:00:00.000Z",
    captureMode: "paste",
  },
} as const;

test("Alexa normalization contracts accept only complete latest-Skill matrices", () => {
  assert.equal(AlexaVocMatrixRecordSchema.safeParse(record).success, true);
  assert.equal(
    AlexaVocMatrixRecordSchema.safeParse({ ...record, evidence: [] }).success,
    false,
  );
  assert.equal(
    AlexaVocMatrixRecordSchema.safeParse({ ...record, negatives: [] }).success,
    false,
  );
  assert.equal(
    AlexaVocMatrixRecordSchema.safeParse({
      ...record,
      audiences: ["人群分类|特征", "家庭用户|重视耐用性"],
    }).success,
    false,
  );
});

test("Alexa normalization fingerprints bind identical raw input to trusted marketplace and ASIN", () => {
  const fingerprint = (asin: string) => createAlexaVocNormalizationFingerprint({
    marketplace: "US",
    asin,
    rawReportSha256: "a".repeat(64),
    executionIdentity,
  });

  assert.notEqual(fingerprint("B0NORM0001"), fingerprint("B0NORM0002"));
});

test("Alexa normalization contracts reject non-matrix prose and invalid motive stars", () => {
  for (const invalid of [
    { ...record, attention: ["x"] },
    { ...record, positives: ["plain"] },
    { ...record, negatives: ["bad"] },
    { ...record, unmet: ["no-number"] },
    { ...record, motives: ["动机｜重要性｜说明", "a｜not-stars｜c"] },
  ]) {
    assert.equal(AlexaVocMatrixRecordSchema.safeParse(invalid).success, false);
  }
});

test("Alexa normalization input and output expose exact strict wire fields", () => {
  const input = {
    schemaVersion: "1.0.0",
    kind: "alexa-voc-normalization-input",
    marketplace: "US",
    asin: "B07VY9Q95Q",
    rawText: "Alexa report",
    normalizationInstructions: factsOnlyInstruction,
    knownMeta: {
      rating: null,
      reviewCount: null,
      capturedAt: "2026-09-01T00:00:00.000Z",
      captureMode: "paste",
    },
  };
  assert.equal(AlexaVocNormalizationInputSchema.safeParse(input).success, true);
  assert.equal(
    AlexaVocNormalizationInputSchema.safeParse({ ...input, evidence: [] }).success,
    false,
  );
  assert.equal(
    AlexaVocNormalizationOutputSchema.safeParse({
      schemaVersion: "1.0.0",
      kind: "alexa-voc-normalization-result",
      record: factualRecord,
    }).success,
    true,
  );
});

test("Alexa normalization facts runtime mode is declared by the business Skill", () => {
  const skill = readFileSync(resolve("skills-src/alexa-for-shopping-voc/SKILL.md"), "utf8");
  assert.ok(skill.includes("### Normalization facts mode"));
  assert.ok(skill.includes(factsOnlyInstruction));
  assert.ok(skill.includes("evidenceQuote"));
});

test("Alexa normalization strict output accepts complete facts and compiles without matrix-string refinements", () => {
  const output = {
    schemaVersion: "1.0.0",
    kind: "alexa-voc-normalization-result",
    record: factualRecord,
  } as const;

  assert.equal(AlexaVocNormalizationOutputSchema.safeParse(output).success, true);
  assert.equal(
    createStructuredResponseFormat(
      AlexaVocNormalizationOutputSchema,
      "AlexaVocNormalizationOutput@1.1.0",
    ).format.strict,
    true,
  );
  const missingMentions = structuredClone(output);
  Reflect.deleteProperty(missingMentions.record.attention[0], "mentions");
  assert.equal(AlexaVocNormalizationOutputSchema.safeParse(missingMentions).success, false);
  const missingEvidenceQuote = structuredClone(output);
  Reflect.deleteProperty(missingEvidenceQuote.record.attention[0], "evidenceQuote");
  assert.equal(AlexaVocNormalizationOutputSchema.safeParse(missingEvidenceQuote).success, false);
  assert.equal(
    AlexaVocNormalizationOutputSchema.safeParse({
      ...output,
      record: { ...factualRecord, attention: ["1. 产品质量：买家关注耐用性。"] },
    }).success,
    false,
  );
});

test("Alexa normalization renderer creates the legacy matrix deterministically from trusted scope and complete facts", () => {
  const rendered = renderFacts(factualRecord, rendererContext);
  assert.deepEqual(rendered, {
    asin: "B07VY9Q95Q",
    attention: ["1. 产品质量：买家关注耐用性（Quality 1,264 条提及，约 6.1%）。"],
    positives: ["【耐用】约 6.1% 评论提及（1,264 条）"],
    negatives: ["【重量】暂无数据：搬运时较费力"],
    unmet: ["1. 希望产品更轻。"],
    audiences: ["人群分类｜特征", "家庭用户｜重视耐用性"],
    scenarios: ["场景｜说明与示例", "家庭使用｜日常高频使用"],
    motives: ["动机｜重要性｜说明", "可靠性｜⭐⭐⭐⭐⭐｜耐用证据"],
    captureStatus: "dialog",
    alexaReport: {
      title: "顾客评价深度分析",
      asin: "B07VY9Q95Q",
      rating: 4.5,
      reviewCount: 20_700,
      prompt: MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
      overallConclusion: "买家重视耐用性。",
      captureStatus: "dialog",
    },
  });
});

test("Alexa normalization renderer keeps unknown or partial statistics explicit without inventing percentages", () => {
  const noStats = AlexaVocNormalizationFactsSchema.parse({
    ...factualRecord,
    attention: factualRecord.attention.map((fact, index) =>
      index === 0 ? { ...fact, mentions: null } : fact,
    ),
    positives: factualRecord.positives.map((fact, index) =>
      index === 0 ? { ...fact, mentions: null } : fact,
    ),
  });
  const rendered = renderFacts(noStats, {
    ...rendererContext,
    knownMeta: { ...rendererContext.knownMeta, reviewCount: 0 },
  });
  assert.equal(rendered.attention[0], "1. 产品质量：买家关注耐用性。");
  assert.equal(rendered.positives[0], "【耐用】暂无数据：长期使用仍稳定");
  assert.equal(rendered.negatives[0], "【重量】暂无数据：搬运时较费力");
  assert.equal(rendered.alexaReport.reviewCount, 0);
  assert.equal("starBreakdown" in rendered.alexaReport, false);
  assert.equal("captureNote" in rendered.alexaReport, false);
});

test("Alexa normalization renderer drops model mention counts without an exact raw evidence quote", () => {
  const rendered = renderFacts(factualRecord, {
    ...rendererContext,
    rawText: "ASIN B07VY9Q95Q 的 Alexa 报告，不提供提及统计。",
  });
  assert.equal(rendered.attention[0], "1. 产品质量：买家关注耐用性。");
  assert.equal(rendered.positives[0], "【耐用】暂无数据：长期使用仍稳定");
});

test("Alexa normalization renderer drops an evidence quote whose count disagrees with the fact", () => {
  const rendered = renderFacts({
    ...factualRecord,
    attention: [{ ...factualRecord.attention[0], evidenceQuote: "1,263 条提及" }],
  }, {
    ...rendererContext,
    rawText: "ASIN B07VY9Q95Q 的 Alexa 报告：1,263 条提及。",
  });
  assert.equal(rendered.attention[0], "1. 产品质量：买家关注耐用性。");
});

test("Alexa normalization renderer requires a mention marker rather than accepting a review header as evidence", () => {
  const rendered = renderFacts({
    ...factualRecord,
    positives: [{
      ...factualRecord.positives[0],
      mentions: 20_700,
      evidenceQuote: "4.7 stars · 20,700 reviews",
    }],
  }, {
    ...rendererContext,
    rawText: "ASIN B07VY9Q95Q\n4.7 stars · 20,700 reviews",
  });
  assert.equal(rendered.positives[0], "【耐用】暂无数据：长期使用仍稳定");

  const chineseReviewHeader = renderFacts({
    ...factualRecord,
    positives: [{
      ...factualRecord.positives[0],
      mentions: 20_700,
      evidenceQuote: "4.7 星 · 20,700 条评论",
    }],
  }, {
    ...rendererContext,
    rawText: "ASIN B07VY9Q95Q\n4.7 星 · 20,700 条评论",
  });
  assert.equal(chineseReviewHeader.positives[0], "【耐用】暂无数据：长期使用仍稳定");

  const separatedReviewCount = renderFacts({
    ...factualRecord,
    positives: [{
      ...factualRecord.positives[0],
      mentions: 20_700,
      evidenceQuote: "买家提到耐用性；共 20,700 条评论",
    }],
  }, {
    ...rendererContext,
    rawText: "ASIN B07VY9Q95Q\n买家提到耐用性；共 20,700 条评论",
  });
  assert.equal(separatedReviewCount.positives[0], "【耐用】暂无数据：长期使用仍稳定");

  const supported = renderFacts({
    ...factualRecord,
    attention: [{ ...factualRecord.attention[0], evidenceQuote: "提及次数：1,264次" }],
  }, {
    ...rendererContext,
    rawText: "ASIN B07VY9Q95Q 的 Alexa 报告：提及次数：1,264次。",
  });
  assert.equal(supported.attention[0], "1. 产品质量：买家关注耐用性（Quality 1,264 条提及，约 6.1%）。");

  const englishSupported = renderFacts({
    ...factualRecord,
    attention: [{ ...factualRecord.attention[0], evidenceQuote: "mentioned 1,264 times" }],
  }, {
    ...rendererContext,
    rawText: "ASIN B07VY9Q95Q Alexa report: mentioned 1,264 times.",
  });
  assert.equal(englishSupported.attention[0], "1. 产品质量：买家关注耐用性（Quality 1,264 条提及，约 6.1%）。");
});

test("Alexa normalization renderer sanitizes structural fact characters before strict matrix validation", () => {
  const rendered = renderFacts({
    ...factualRecord,
    positives: [{
      ...factualRecord.positives[0],
      label: "耐用】注入｜",
      detail: "长期：稳定｜可靠",
    }],
  }, rendererContext);
  assert.equal(rendered.positives[0], "【耐用 注入】约 6.1% 评论提及（1,264 条）");
  const { asin, ...matrix } = rendered;
  assert.equal(asin, "B07VY9Q95Q");
  assert.equal(AlexaVocMatrixRecordSchema.safeParse(matrix).success, true);
});

test("Alexa normalization renderer binds output to trusted scope regardless of report prose", () => {
  for (const rawText of [
    "ASIN B0NORM0001 的 Alexa 报告",
    "ASIN B1OTHER001 的 Alexa 报告",
    "ASIN: 1234567890 的 Alexa 报告",
    "Buyers value brightness control.",
  ]) {
    const rendered = renderFacts(factualRecord, { ...rendererContext, rawText });
    assert.equal(rendered.asin, rendererContext.asin);
  }
});

test("Amazon VOC insight contracts require seven ordered business sections and positioning compatibility", () => {
  const row = {
    label: "耐用性",
    frequency: "暂无数据",
    feedback: "买家重视耐用性。",
    impact: "high",
    implication: "保留成熟结构。",
  } as const;
  const insight = {
    summary: "建议验证更轻且耐用的产品方向。",
    sevenDimensions: [
      "attention",
      "positives",
      "negatives",
      "unmet",
      "scenarios",
      "audiences",
      "motives",
    ].map((dimension) => ({ dimension, rows: [row] })),
    negativePriorities: [{
      issue: "重量偏大",
      frequency: "暂无数据",
      severity: "medium",
      industryCommon: true,
      affectedStages: ["conversion"],
      shouldSolve: true,
      direction: "减重并保持强度。",
    }],
    unmetOpportunities: [{
      need: "更轻",
      audience: "家庭用户",
      scenario: "日常使用",
      competitorCoverage: "覆盖不足",
      marketValue: "high",
      difficulty: "medium",
      proposal: "验证轻量材料。",
    }],
    productDirections: [1, 2, 3].map((index) => ({
      name: `方向${index}`,
      positioning: "轻量耐用",
      audience: "家庭用户",
      scenario: "日常使用",
      painPoints: ["重量"],
      baseFunctions: ["耐用"],
      differentiators: ["轻量"],
      avoid: [],
      specification: "待验证",
      accessories: [],
      priceBand: "待验证",
      sellingPoints: ["轻量耐用"],
      competitorDifference: "更轻",
      qualityRisks: [],
      compliancePatentRisks: [],
      difficulty: "medium",
      priority: "P1",
    })),
    scoredOpportunities: [{
      rank: 1,
      opportunity: "轻量耐用",
      demandEvidence: ["VOC 重量反馈"],
      marketEvidence: ["暂无数据，需验证"],
      scores: {
        demandFrequency: 3,
        painIntensity: 3,
        marketSpace: 3,
        competitorGap: 3,
        differentiation: 3,
        premiumPotential: 3,
        feasibility: 3,
        total: 60,
      },
      difficulty: "medium",
      conclusion: "建议验证",
    }],
    finalDecision: {
      enterCategory: true,
      recommendedDirection: "轻量耐用",
      topPainPoints: ["重量", "耐用", "使用便利"],
      matureSellingPoints: ["稳定", "可靠", "易用"],
      pseudoDemands: [],
      priceBand: "待验证",
      targetAudience: "家庭用户",
      competitorDifference: "轻量",
      validationsNeeded: ["市场规模"],
      recommendation: "建议小批量测试",
    },
  };

  assert.equal(AmazonVocInsightShapeSchema.safeParse(insight).success, true);
  assert.equal(
    AmazonVocInsightShapeSchema.safeParse({
      ...insight,
      sevenDimensions: [...insight.sevenDimensions].reverse(),
    }).success,
    false,
  );
  assert.equal(
    AmazonVocInsightOutputSchema.safeParse({
      schemaVersion: "1.0.0",
      kind: "amazon-voc-insight-result",
      insight,
      positioningProjection: {},
    }).success,
    false,
  );
});
