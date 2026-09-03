import type { ManualAlexaVocRecord } from "../shared/agent-contracts";

export type ManualVocDimensionKey =
  | "attention"
  | "positives"
  | "negatives"
  | "unmet"
  | "audiences"
  | "scenarios"
  | "motives";

export const manualVocDisplayMeta = {
  source: "Alexa for Shopping 对话框",
  scope: "Customer Review（经 Alexa 整理）· PostgreSQL 当前版本",
  prompt: "这个产品的顾客关注点是什么，好评点是什么，差评点是什么，未被满足的需求是什么，使用人群是谁，使用场景是什么，核心购买动机是什么。",
} as const;

export const manualVocWorkflow = [
  { step: "推荐", approach: "竞品概览输入 ASIN →「开始全自动分析」，基础数据完成后手工补充 Alexa VOC" },
  { step: "手工录入", approach: "商品页提交七问并展开 See more 后，复制全文到下方粘贴录入" },
] as const;

export const manualVocDimensions: ReadonlyArray<Readonly<{
  label: string;
  description: string;
  key: ManualVocDimensionKey;
  verified: boolean;
  formatHint: string;
}>> = [
  { label: "顾客关注点", description: "购买时最在意什么、关注哪些方面", key: "attention", verified: true, formatHint: "1–5 编号列表" },
  { label: "好评点", description: "用户满意什么、为什么推荐", key: "positives", verified: true, formatHint: "【分类】+ 提及占比" },
  { label: "差评点", description: "用户抱怨什么、哪里出了问题", key: "negatives", verified: true, formatHint: "【分类】+ 提及占比" },
  { label: "未被满足的需求", description: "用户希望改进什么、缺什么", key: "unmet", verified: true, formatHint: "1–5 编号列表" },
  { label: "使用人群", description: "谁在买、给谁买、什么人群在用", key: "audiences", verified: true, formatHint: "表格式 · 人群分类｜特征" },
  { label: "使用场景", description: "在哪用、什么时候用、怎么用", key: "scenarios", verified: true, formatHint: "表格式 · 场景｜说明" },
  { label: "购买动机", description: "为什么买、什么驱动了购买决策", key: "motives", verified: true, formatHint: "表格式 · 动机｜★★★★★｜说明" },
];

export function manualVocSourceBadge(record: ManualAlexaVocRecord | null) {
  if (!record) return null;
  return record.source === "postgres"
    ? `Manual Alexa · PostgreSQL r${record.revision}`
    : `Stale legacy static · generation ${record.generation ?? "?"}`;
}
