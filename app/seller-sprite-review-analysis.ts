export type ReviewAnalysisRow = {
  label: string;
  sharePct: number;
  reason: string;
  metricKind?: "review_sample_incidence" | "customers_say_topic_share";
  numerator?: number;
  denominator?: number;
};

export type ReviewAnalysisBlockKey =
  | "consumerProfile"
  | "scenarios"
  | "unmet"
  | "positives"
  | "negatives"
  | "motives";

export type ReviewAnalysisBlock = {
  key: ReviewAnalysisBlockKey;
  label: string;
  rows: ReviewAnalysisRow[];
};

export type SellerSpriteReviewRecord = {
  author?: string;
  title?: string;
  content?: string;
  star?: number;
  authorLabels?: string[];
  verified?: boolean;
};

export type SellerSpriteReviewAnalysisRecord = {
  asin: string;
  marketplace: string;
  sampledReviews: number;
  mentionTopics?: number;
  fetchedAt: string;
  status: "ready" | "pending" | "error";
  terminalReason?: "valid-empty";
  sourceProvider?: "sorftime" | "sellerSprite";
  statusMessage?: string;
  family?: "scooter" | "lighting" | "generic";
  blocks: ReviewAnalysisBlock[];
};

type ThemeRule = {
  label: string;
  patterns: RegExp[];
  stars?: "positive" | "negative" | "any";
};

const blockLabels: Record<ReviewAnalysisBlockKey, string> = {
  consumerProfile: "消费者画像",
  scenarios: "使用场景",
  unmet: "未满足需求候选",
  positives: "好评",
  negatives: "差评",
  motives: "购买动机",
};

const themeRules: Record<ReviewAnalysisBlockKey, ThemeRule[]> = {
  consumerProfile: [
    { label: "granddaughter", patterns: [/grand\s*daughter/i], stars: "any" },
    { label: "grandson", patterns: [/grand\s*son/i], stars: "any" },
    { label: "son", patterns: [/\bson\b/i], stars: "any" },
    { label: "daughter", patterns: [/\bdaughter\b/i], stars: "any" },
    { label: "niece", patterns: [/\bniece\b/i], stars: "any" },
    { label: "nephew", patterns: [/\bnephew\b/i], stars: "any" },
    { label: "birthday", patterns: [/birthday/i], stars: "any" },
    { label: "Christmas", patterns: [/christmas|xmas/i], stars: "any" },
    { label: "park", patterns: [/\bpark\b/i], stars: "any" },
    { label: "driveway", patterns: [/driveway/i], stars: "any" },
    { label: "ride scooter", patterns: [/ride(?:s|ing)?\s+(?:the\s+)?scooter/i], stars: "any" },
    { label: "assemble scooter", patterns: [/assembl(?:e|ed|ing)\s+(?:the\s+)?scooter/i], stars: "any" },
  ],
  scenarios: [
    { label: "birthday gift", patterns: [/birthday\s+gift|gift\s+for\s+(?:his|her|my)\s+(?:son|daughter|grand)/i], stars: "any" },
    { label: "Christmas gift", patterns: [/christmas\s+gift|holiday\s+gift|xmas\s+gift/i], stars: "any" },
    { label: "childhood development", patterns: [/balance|coordination|motor\s+skill|development/i], stars: "any" },
    { label: "outdoor play", patterns: [/outdoor|outside|neighborhood|sidewalk|pavement|park/i], stars: "any" },
    { label: "indoor use", patterns: [/indoor|inside|basement|garage/i], stars: "any" },
    { label: "first scooter", patterns: [/first\s+scooter|starter\s+scooter|beginner/i], stars: "any" },
  ],
  unmet: [
    { label: "durable brake", patterns: [/brake.{0,40}(break|snap|fail|cheap|plastic)|need.{0,20}metal\s+brake/i], stars: "negative" },
    { label: "stronger handlebar", patterns: [/handle\s*bar.{0,40}(break|bend|weak|snap)|stronger\s+handle/i], stars: "negative" },
    { label: "improved hardware", patterns: [/better\s+(?:hardware|parts|quality)|metal\s+instead\s+of\s+plastic/i], stars: "negative" },
    { label: "better quality control", patterns: [/quality\s+control|missing\s+part|defect|qc/i], stars: "negative" },
    { label: "flatter foot plate", patterns: [/foot\s*plate|deck.{0,30}(high|low|flat)|hard\s+to\s+kick/i], stars: "negative" },
    { label: "spare parts support", patterns: [/spare\s+part|replacement\s+part|can't\s+find\s+part/i], stars: "negative" },
  ],
  positives: [
    { label: "light up wheels", patterns: [/light\s*up|led|glow(?:ing)?\s+wheel|flash(?:ing)?\s+wheel/i], stars: "positive" },
    { label: "adjustable handlebar", patterns: [/adjust(?:able)?\s+handle|handle\s*bar.{0,20}adjust/i], stars: "positive" },
    { label: "sturdy construction", patterns: [/sturd(?:y|ier)|solid|well\s+built|stable/i], stars: "positive" },
    { label: "easy assembly", patterns: [/easy\s+assembl|quick\s+assembl|5\s+minute|simple\s+assembl/i], stars: "positive" },
    { label: "bright colors", patterns: [/bright\s+color|colorful|cute|love\s+the\s+color/i], stars: "positive" },
    { label: "smooth ride", patterns: [/smooth\s+ride|rides?\s+smooth|glides?\s+well/i], stars: "positive" },
    { label: "great gift", patterns: [/great\s+gift|perfect\s+gift|love(?:d)?\s+it/i], stars: "positive" },
  ],
  negatives: [
    { label: "broken brake", patterns: [/brake.{0,30}(break|snap|fail|broke|stopped)/i], stars: "negative" },
    { label: "handlebar breaking", patterns: [/handle\s*bar.{0,30}(break|snap|broke|bent)/i], stars: "negative" },
    { label: "poor quality control", patterns: [/poor\s+quality|cheap\s+material|defect|fell\s+apart/i], stars: "negative" },
    { label: "plastic components", patterns: [/plastic.{0,30}(break|cheap|flimsy)|too\s+much\s+plastic/i], stars: "negative" },
    { label: "short lifespan", patterns: [/broke\s+within|lasted\s+(?:a\s+)?(?:week|month)|stopped\s+working|died\s+after/i], stars: "negative" },
    { label: "wheel failure", patterns: [/wheel.{0,30}(break|broke|crack|fall\s+off)/i], stars: "negative" },
    { label: "steering difficulty", patterns: [/turn(?:ing)?|steer(?:ing)?|lean.?to.?steer.{0,30}(hard|difficult|doesn't)/i], stars: "negative" },
  ],
  motives: [
    { label: "gift purchase", patterns: [/gift|birthday|christmas|grand(?:son|daughter)/i], stars: "any" },
    { label: "child's interest", patterns: [/loves?\s+it|wanted\s+a\s+scooter|excited|obsessed/i], stars: "positive" },
    { label: "affordable price", patterns: [/affordable|good\s+price|value\s+for\s+money|worth\s+the\s+price/i], stars: "any" },
    { label: "light-up feature", patterns: [/light\s*up|led|glow(?:ing)?\s+wheel/i], stars: "any" },
    { label: "adjustability", patterns: [/adjust(?:able)?|grow\s+with|multiple\s+height/i], stars: "any" },
    { label: "stability for beginners", patterns: [/three\s+wheel|3\s+wheel|stable|beginner|first\s+scooter/i], stars: "any" },
  ],
};

function reviewText(review: SellerSpriteReviewRecord) {
  return `${review.title ?? ""} ${review.content ?? ""}`.replace(/\s+/g, " ").trim();
}

function starBucket(star?: number): "positive" | "negative" | "neutral" {
  if (!star) return "neutral";
  if (star >= 4) return "positive";
  if (star <= 3) return "negative";
  return "neutral";
}

function snippet(text: string, pattern: RegExp, max = 140) {
  const match = text.match(pattern);
  if (!match || match.index === undefined) return text.slice(0, max);
  const start = Math.max(0, match.index - 40);
  return text.slice(start, start + max).trim();
}

function aggregateBlock(
  reviews: SellerSpriteReviewRecord[],
  key: ReviewAnalysisBlockKey,
  limit = 5
): ReviewAnalysisBlock {
  const rules = themeRules[key];
  const total = reviews.length || 1;
  const hits = new Map<string, { count: number; reason: string }>();

  reviews.forEach(review => {
    const bucket = starBucket(review.star);
    const text = reviewText(review);
    if (!text) return;

    rules.forEach(rule => {
      if (rule.stars === "positive" && bucket !== "positive") return;
      if (rule.stars === "negative" && bucket !== "negative") return;
      const matched = rule.patterns.some(pattern => pattern.test(text));
      if (!matched) return;
      const current = hits.get(rule.label) ?? { count: 0, reason: "" };
      current.count += 1;
      if (!current.reason) current.reason = snippet(text, rule.patterns[0]);
      hits.set(rule.label, current);
    });
  });

  const rows = [...hits.entries()]
    .map(([label, entry]) => ({
      label,
      sharePct: Number(((entry.count / total) * 100).toFixed(2)),
      metricKind: "review_sample_incidence" as const,
      numerator: entry.count,
      denominator: reviews.length,
      reason: entry.reason,
    }))
    .sort((a, b) => b.sharePct - a.sharePct || a.label.localeCompare(b.label))
    .slice(0, limit);

  return { key, label: blockLabels[key], rows };
}

export function buildReviewAnalysisFromRecords(
  asin: string,
  marketplace: string,
  reviews: SellerSpriteReviewRecord[],
  fetchedAt = new Date().toISOString().slice(0, 10)
): SellerSpriteReviewAnalysisRecord {
  if (!reviews.length) {
    return {
      asin,
      marketplace,
      sampledReviews: 0,
      fetchedAt,
      status: "pending",
      statusMessage: "卖家精灵 review 接口未返回评论样本",
      blocks: [],
    };
  }

  const keys: ReviewAnalysisBlockKey[] = [
    "consumerProfile",
    "scenarios",
    "unmet",
    "positives",
    "negatives",
    "motives",
  ];

  return {
    asin,
    marketplace,
    sampledReviews: reviews.length,
    fetchedAt,
    status: "ready",
    blocks: keys.map(key => aggregateBlock(reviews, key)),
  };
}

export const sorftimeReviewAnalysisMeta = {
  source: "Sorftime MCP · product_customers_say + product_reviews",
  method: "Customers Say 主题 mention 占比 + 近一年评论关键词聚类",
  syncCommand: "npm run review:sync",
  emptyMessage: "待运行 review:sync 从 Sorftime MCP 拉取评论分析",
};

export const sellerSpriteMcpReviewAnalysisMeta = {
  source: "卖家精灵 MCP · review",
  method: "POST review · 近一年评论样本关键词聚类 · 六维分类占比",
  syncCommand: "npm run review:sellersprite:sync",
  emptyMessage: "待运行 review:sellersprite:sync 从卖家精灵 MCP 拉取评论分析",
};

/** @deprecated use sorftimeReviewAnalysisMeta */
export const sellerSpriteReviewAnalysisMeta = sorftimeReviewAnalysisMeta;

export const reviewAnalysisBarPalette: Record<ReviewAnalysisBlockKey, string> = {
  consumerProfile: "#9B72D4",
  scenarios: "#5DAFE8",
  unmet: "#F0923E",
  positives: "#6BCB9A",
  negatives: "#E85D5D",
  motives: "#F5C451",
};

export const reviewAnalysisDimensions: Array<{
  key: ReviewAnalysisBlockKey;
  label: string;
  formatHint: string;
}> = [
  { key: "consumerProfile", label: "消费者画像", formatHint: "【分类】+ 提及占比" },
  { key: "scenarios", label: "使用场景", formatHint: "【分类】+ 提及占比" },
  { key: "unmet", label: "未满足需求候选", formatHint: "基于负向证据的候选项" },
  { key: "positives", label: "好评点", formatHint: "【分类】+ 提及占比" },
  { key: "negatives", label: "差评点", formatHint: "【分类】+ 提及占比" },
  { key: "motives", label: "购买动机", formatHint: "【分类】+ 提及占比" },
];

export function formatReviewSharePct(sharePct: number) {
  return sharePct >= 1 ? sharePct.toFixed(1) : sharePct.toFixed(2);
}

function evidenceFraction(row: ReviewAnalysisRow, unit: "条" | "次") {
  return Number.isFinite(row.numerator) && Number.isFinite(row.denominator) && row.denominator! > 0
    ? `（${row.numerator}/${row.denominator} ${unit}）`
    : "";
}

function validMetricTuple(row: ReviewAnalysisRow, sampledReviews?: number) {
  if (!Number.isInteger(row.numerator) || !Number.isInteger(row.denominator) || row.denominator! <= 0 || row.numerator! < 0 || row.numerator! > row.denominator!) return false;
  if (row.sharePct !== Number(((row.numerator! / row.denominator!) * 100).toFixed(2))) return false;
  return row.metricKind !== "review_sample_incidence" || sampledReviews === undefined || row.denominator === sampledReviews;
}

export function formatReviewAnalysisItem(row: ReviewAnalysisRow, sampledReviews?: number) {
  const percentage = formatReviewSharePct(row.sharePct);
  if (row.metricKind === "review_sample_incidence" && validMetricTuple(row, sampledReviews)) {
    return `【${row.label}】约 ${percentage}% 评论样本提及${evidenceFraction(row, "条")}`;
  }
  if (row.metricKind === "customers_say_topic_share" && validMetricTuple(row, sampledReviews)) {
    return `【${row.label}】占 Customers Say 主题提及约 ${percentage}%${evidenceFraction(row, "次")}`;
  }
  return `【${row.label}】${percentage}%（旧缓存未记录指标口径）`;
}

export function reviewMetricExplanation(row: ReviewAnalysisRow, sampledReviews?: number) {
  if (!validMetricTuple(row, sampledReviews)) return "该记录的分母不可用、指标证据不完整或与评论样本数不一致，因此按未知口径展示，不推算。";
  const denominatorAvailable = Number.isFinite(row.denominator) && row.denominator! > 0;
  if (!denominatorAvailable) return "该记录的分母不可用，因此不推算计数或重新解释百分比。";
  if (row.metricKind === "review_sample_incidence") {
    return `评论样本发生率：${row.numerator}/${row.denominator} 条评论提及该主题。同一条评论可提及多个主题，各行比例可能重叠，合计不要求等于 100%。`;
  }
  if (row.metricKind === "customers_say_topic_share") {
    return `Customers Say 主题提及份额：${row.numerator}/${row.denominator} 次主题提及归于该主题。同一条评论可提及多个主题，不能解读为评论占比或好评/差评率。`;
  }
  return "旧缓存未记录指标来源、分子或分母；保留原值展示，但不解释为评论发生率。";
}
