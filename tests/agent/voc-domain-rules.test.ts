import assert from "node:assert/strict";
import test from "node:test";

import {
  VOC_DIMENSIONS,
  canonicalTheme,
  compareCodePoints,
  parseAlexaThemeObservation,
} from "../../server/domain/voc/theme-normalization";
import {
  classifyVocPriority,
  legacyNegativePriorityDisplay,
  legacyPositivePriorityDisplay,
  priorityRank,
} from "../../server/domain/voc/priority-rules";

test("theme normalization preserves current ordered family and dimension rules", () => {
  assert.deepEqual(VOC_DIMENSIONS, [
    "attention",
    "positives",
    "negatives",
    "unmet",
    "audiences",
    "scenarios",
    "motives",
  ]);
  assert.deepEqual(
    canonicalTheme("  LEAN-to-steer  ", "negatives", "scooter"),
    {
      key: "lean-to-steer转向体验",
      label: "Lean-to-steer 转向体验",
    },
  );
  assert.deepEqual(canonicalTheme("Brightness", "positives", "lighting"), {
    key: "led照明/色温",
    label: "LED 照明 / 色温",
  });
  assert.deepEqual(canonicalTheme("  GREAT   QUALITY  ", "positives", "generic"), {
    key: "产品质量",
    label: "产品质量",
  });
  assert.deepEqual(canonicalTheme("生日礼物", "scenarios", "generic"), {
    key: "礼物/节日赠礼",
    label: "礼物 / 节日赠礼",
  });
  assert.deepEqual(canonicalTheme("生日礼物", "negatives", "generic"), {
    key: "生日礼物",
    label: "生日礼物",
  });
});

test("Alexa parsing preserves raw counts, denominators, unknowns, and precedence", () => {
  assert.deepEqual(
    parseAlexaThemeObservation(
      "【耐用性】约 12.5% 评论提及（25 条）",
      "positives",
      200,
    ),
    {
      rawLabel: "耐用性",
      mentionCount: 25,
      sampleCount: 200,
      mentionPct: 12.5,
      basis: "explicit-percentage",
    },
  );
  assert.deepEqual(
    parseAlexaThemeObservation("【断裂】3 条", "negatives", 0),
    {
      rawLabel: "断裂",
      mentionCount: 3,
      sampleCount: 0,
      mentionPct: null,
      basis: "mention-count",
    },
  );
  assert.deepEqual(
    parseAlexaThemeObservation("希望提供备件，售后更清楚。", "unmet", 40),
    {
      rawLabel: "提供备件",
      mentionCount: null,
      sampleCount: 40,
      mentionPct: null,
      basis: "presence-only",
    },
  );
  assert.deepEqual(
    parseAlexaThemeObservation("1. 产品质量：顾客最关心做工（10 次提及）。", "attention", 50),
    {
      rawLabel: "产品质量",
      mentionCount: 10,
      sampleCount: 50,
      mentionPct: 20,
      basis: "mention-count",
    },
  );
});

test("priority thresholds use independent facts and exact published boundaries", () => {
  assert.equal(
    classifyVocPriority([
      { dimension: "positives", mentionPct: 5, label: "普通优点" },
    ]).level,
    "P2",
  );
  assert.equal(
    classifyVocPriority([
      { dimension: "negatives", mentionPct: 10, label: "普通问题" },
    ]).level,
    "P2",
  );
  assert.equal(
    classifyVocPriority([
      { dimension: "negatives", mentionPct: 10.01, label: "普通问题" },
    ]).level,
    "P0",
  );
  assert.equal(
    classifyVocPriority([
      { dimension: "positives", mentionPct: 10.01, label: "普通优点" },
    ]).level,
    "P1",
  );
  assert.equal(
    classifyVocPriority([
      { dimension: "unmet", mentionPct: 10.01, label: "普通需求" },
    ]).level,
    "P1",
  );
  assert.equal(
    classifyVocPriority([
      { dimension: "negatives", mentionPct: 4.99, label: "普通问题" },
      { dimension: "positives", mentionPct: 4.5, label: "普通优点" },
    ]).level,
    "P3",
  );
  assert.equal(
    classifyVocPriority([
      { dimension: "negatives", mentionPct: null, label: "普通问题" },
    ]).level,
    "unknown",
  );
});

test("safety rules fail closed despite low, missing, or conflicting percentages", () => {
  const low = classifyVocPriority([
    { dimension: "negatives", mentionPct: 0.1, label: "刹车断裂" },
  ]);
  assert.equal(low.level, "P0");
  assert.notEqual(low.safetyRule, null);
  assert.match(low.cannotDowngradeReason ?? "", /P0/);

  const missing = classifyVocPriority([
    { dimension: "negatives", mentionPct: null, label: "漏电风险" },
  ]);
  assert.equal(missing.level, "P0");
  assert.equal(missing.safetyRule, "safety");

  const conflict = classifyVocPriority([
    { dimension: "positives", mentionPct: 80, label: "结构稳固" },
    { dimension: "negatives", mentionPct: 0.01, label: "结构断裂" },
  ]);
  assert.equal(conflict.level, "P0");
  assert.notEqual(conflict.cannotDowngradeReason, null);
});

test("safety escalation is limited to closed problem dimensions", () => {
  assert.equal(
    classifyVocPriority([
      {
        dimension: "positives",
        mentionPct: 20,
        label: "安全稳定的刹车设计",
      },
    ]).level,
    "P1",
  );
  for (const dimension of ["motives", "audiences", "scenarios"] as const) {
    const decision = classifyVocPriority([
      { dimension, mentionPct: null, label: "夜间安全骑行" },
    ]);
    assert.equal(decision.level, "unknown", dimension);
    assert.equal(decision.safetyRule, null, dimension);
  }
  for (const dimension of ["negatives", "unmet", "attention"] as const) {
    const decision = classifyVocPriority([
      { dimension, mentionPct: null, label: "刹车失效安全问题" },
    ]);
    assert.equal(decision.level, "P0", dimension);
    assert.notEqual(decision.safetyRule, null, dimension);
    assert.match(decision.cannotDowngradeReason ?? "", /cannot be downgraded/);
  }
});

test("priority and code-point ordering have deterministic tie breaks", () => {
  assert.deepEqual(
    ["灯", "A", "a", "中"].sort(compareCodePoints),
    ["A", "a", "中", "灯"],
  );
  assert.deepEqual(
    ["unknown", "P3", "P1", "P0", "P2"].sort(
      (left, right) => priorityRank(left) - priorityRank(right),
    ),
    ["P0", "P1", "P2", "P3", "unknown"],
  );
});

test("legacy priority display differences stay explicit in the shared compatibility projection", () => {
  assert.equal(
    legacyNegativePriorityDisplay(10, "中"),
    "是 · 建议 P0/P1 解决",
  );
  assert.equal(
    legacyPositivePriorityDisplay(10, "中"),
    "是 · P0 必须保留并强化",
  );
  assert.equal(
    legacyNegativePriorityDisplay(7, "低"),
    "观察，勿堆低频功能",
  );
  assert.equal(
    legacyPositivePriorityDisplay(7, "低"),
    "可保留，勿过度投入",
  );
});
