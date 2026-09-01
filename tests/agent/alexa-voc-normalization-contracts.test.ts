import assert from "node:assert/strict";
import test from "node:test";

import {
  MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
} from "../../shared/agent-contracts";
import {
  AlexaVocMatrixRecordSchema,
  AlexaVocNormalizationInputSchema,
  AlexaVocNormalizationOutputSchema,
} from "../../server/domain/voc/alexa-voc-normalization-contracts";
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
      record,
    }).success,
    true,
  );
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
