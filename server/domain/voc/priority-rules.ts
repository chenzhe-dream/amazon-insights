import {
  compareCodePoints,
  type VocDimension,
} from "./theme-normalization";

export type VocPriorityLevel = "P0" | "P1" | "P2" | "P3" | "unknown";

export type VocSafetyRule =
  | "safety"
  | "compliance"
  | "unusable"
  | "structural-failure"
  | "severe-damage"
  | "concentrated-return";

export type VocPriorityFact = Readonly<{
  dimension: VocDimension;
  mentionPct: number | null;
  label: string;
}>;

export type VocPriorityDecision = Readonly<{
  level: VocPriorityLevel;
  reasons: readonly string[];
  cannotDowngradeReason: string | null;
  safetyRule: VocSafetyRule | null;
}>;

const SAFETY_RULES: readonly Readonly<{
  id: VocSafetyRule;
  pattern: RegExp;
}>[] = Object.freeze([
  {
    id: "safety",
    pattern: /安全|漏电|触电|过热|起火|火灾|刹车|brake|electric\s*shock|electrocution|overheat|\bfire\b/i,
  },
  {
    id: "compliance",
    pattern: /合规|认证|astm|cpsia|\bul\b|\betl\b|compliance|regulatory/i,
  },
  {
    id: "unusable",
    pattern: /无法使用|不能使用|无法正常|完全失效|stopped\s+working|unusable|inoperable/i,
  },
  {
    id: "structural-failure",
    pattern: /结构失效|结构断裂|断裂|折断|松脱|脱落|坍塌|collapse|break|broke|broken|snap|structural\s+failure/i,
  },
  {
    id: "severe-damage",
    pattern: /严重损坏|严重破损|爆裂|爆炸|severe\s+damage|catastrophic/i,
  },
  {
    id: "concentrated-return",
    pattern: /集中退货|大量退货|退货潮|mass\s+return|return\s+spike/i,
  },
]);

const DECISION_DIMENSIONS = new Set<VocDimension>([
  "positives",
  "negatives",
  "unmet",
]);

export function classifyVocPriority(
  facts: readonly VocPriorityFact[],
): VocPriorityDecision {
  const safetyMatch = firstSafetyMatch(facts);
  if (safetyMatch) {
    return decision(
      "P0",
      [`safety:${safetyMatch.id}`],
      `${safetyMatch.id} is fail-closed P0 and cannot be downgraded by frequency, missing data, or source conflict`,
      safetyMatch.id,
    );
  }

  const numericFacts = facts.filter(
    (fact) =>
      DECISION_DIMENSIONS.has(fact.dimension) &&
      fact.mentionPct !== null &&
      Number.isFinite(fact.mentionPct),
  ) as Array<VocPriorityFact & { mentionPct: number }>;
  const highNegatives = numericFacts.filter(
    (fact) => fact.dimension === "negatives" && fact.mentionPct > 10,
  );
  const highPositiveOrUnmet = numericFacts.filter(
    (fact) =>
      (fact.dimension === "positives" || fact.dimension === "unmet") &&
      fact.mentionPct > 10,
  );
  if (highNegatives.length > 0) {
    return decision(
      "P0",
      [
        ...highNegatives.map((fact) => `negative>10:${fact.mentionPct}`),
        ...highPositiveOrUnmet.map(
          (fact) => `${fact.dimension}>10:${fact.mentionPct}`,
        ),
      ],
      "negative mentionPct above 10 is P0 and cannot be downgraded by other source facts",
      null,
    );
  }

  if (highPositiveOrUnmet.length > 0) {
    return decision(
      "P1",
      highPositiveOrUnmet.map(
        (fact) => `${fact.dimension}>10:${fact.mentionPct}`,
      ),
      null,
      null,
    );
  }

  const mid = numericFacts.filter(
    (fact) => fact.mentionPct >= 5 && fact.mentionPct <= 10,
  );
  if (mid.length > 0) {
    return decision(
      "P2",
      mid.map((fact) => `${fact.dimension}:5..10:${fact.mentionPct}`),
      null,
      null,
    );
  }

  if (numericFacts.length > 0) {
    return decision(
      "P3",
      numericFacts.map((fact) => `${fact.dimension}<5:${fact.mentionPct}`),
      null,
      null,
    );
  }

  return decision("unknown", ["no-known-decision-percentage"], null, null);
}

export function priorityRank(level: string) {
  if (level === "P0") return 0;
  if (level === "P1") return 1;
  if (level === "P2") return 2;
  if (level === "P3") return 3;
  return 4;
}

export function legacyNegativePriorityDisplay(
  mentionPct: number,
  severity: "高" | "中" | "低",
) {
  if (severity === "高" || mentionPct >= 10) {
    return "是 · 建议 P0/P1 解决" as const;
  }
  if (severity === "中") return "建议验证后解决" as const;
  return "观察，勿堆低频功能" as const;
}

export function legacyPositivePriorityDisplay(
  mentionPct: number,
  valueLevel: "高" | "中" | "低",
) {
  if (valueLevel === "高" || mentionPct >= 10) {
    return "是 · P0 必须保留并强化" as const;
  }
  if (valueLevel === "中") return "建议保留为 P1 卖点" as const;
  return "可保留，勿过度投入" as const;
}

function firstSafetyMatch(facts: readonly VocPriorityFact[]) {
  for (const rule of SAFETY_RULES) {
    const fact = facts.find((candidate) => rule.pattern.test(candidate.label));
    if (fact) return { id: rule.id, fact };
  }
  return null;
}

function decision(
  level: VocPriorityLevel,
  reasons: readonly string[],
  cannotDowngradeReason: string | null,
  safetyRule: VocSafetyRule | null,
): VocPriorityDecision {
  const sortedReasons = Object.freeze([...new Set(reasons)].sort(compareCodePoints));
  return Object.freeze({
    level,
    reasons: sortedReasons,
    cannotDowngradeReason,
    safetyRule,
  });
}
