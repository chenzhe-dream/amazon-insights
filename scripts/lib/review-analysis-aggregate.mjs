import { translateReviewReason } from "./review-label-zh.mjs";

const blockLabels = {
  consumerProfile: "消费者画像",
  scenarios: "使用场景",
  unmet: "未被满足的需求",
  positives: "好评点",
  negatives: "差评点",
  motives: "购买动机",
};

const themeRules = {
  consumerProfile: [
    { label: "孙女/外孙女", patterns: [/grand\s*daughter/i], stars: "any" },
    { label: "孙子/外孙", patterns: [/grand\s*son/i], stars: "any" },
    { label: "儿子", patterns: [/\bson\b/i], stars: "any" },
    { label: "女儿", patterns: [/\bdaughter\b/i], stars: "any" },
    { label: "侄女/外甥女", patterns: [/\bniece\b/i], stars: "any" },
    { label: "生日相关", patterns: [/birthday/i], stars: "any" },
    { label: "圣诞相关", patterns: [/christmas|xmas/i], stars: "any" },
    { label: "公园/户外", patterns: [/\bpark\b/i], stars: "any" },
    { label: "骑行使用", patterns: [/ride(?:s|ing)?\s+(?:the\s+)?scooter/i], stars: "any" },
  ],
  scenarios: [
    { label: "生日礼物", patterns: [/birthday\s+gift|gift\s+for\s+(?:his|her|my)/i], stars: "any" },
    { label: "圣诞礼物", patterns: [/christmas\s+gift|holiday\s+gift|xmas\s+gift/i], stars: "any" },
    { label: "平衡/发育训练", patterns: [/balance|coordination|motor\s+skill|development/i], stars: "any" },
    { label: "户外玩耍", patterns: [/outdoor|outside|neighborhood|sidewalk|pavement|park/i], stars: "any" },
    { label: "室内使用", patterns: [/indoor|inside|basement|garage/i], stars: "any" },
    { label: "第一辆滑板车", patterns: [/first\s+scooter|starter\s+scooter|beginner/i], stars: "any" },
  ],
  unmet: [
    { label: "刹车耐用性", patterns: [/brake.{0,40}(break|snap|fail|cheap|plastic)|need.{0,20}metal\s+brake/i], stars: "negative" },
    { label: "手把强度", patterns: [/handle\s*bar.{0,40}(break|bend|weak|snap)|stronger\s+handle/i], stars: "negative" },
    { label: "硬件升级", patterns: [/better\s+(?:hardware|parts|quality)|metal\s+instead\s+of\s+plastic/i], stars: "negative" },
    { label: "品控改进", patterns: [/quality\s+control|missing\s+part|defect|qc/i], stars: "negative" },
    { label: "脚踏板高度", patterns: [/foot\s*plate|deck.{0,30}(high|low|flat)|hard\s+to\s+kick/i], stars: "negative" },
  ],
  positives: [
    { label: "发光轮", patterns: [/light\s*up|led|glow(?:ing)?\s+wheel|flash(?:ing)?\s+wheel/i], stars: "positive" },
    { label: "可调手把", patterns: [/adjust(?:able)?\s+handle|handle\s*bar.{0,20}adjust/i], stars: "positive" },
    { label: "结构稳固", patterns: [/sturd(?:y|ier)|solid|well\s+built|stable/i], stars: "positive" },
    { label: "安装便捷", patterns: [/easy\s+assembl|quick\s+assembl|5\s+minute|simple\s+assembl/i], stars: "positive" },
    { label: "外观配色", patterns: [/bright\s+color|colorful|cute|love\s+the\s+color/i], stars: "positive" },
    { label: "骑行顺滑", patterns: [/smooth\s+ride|rides?\s+smooth|glides?\s+well/i], stars: "positive" },
  ],
  negatives: [
    { label: "刹车损坏", patterns: [/brake.{0,30}(break|snap|fail|broke|stopped)/i], stars: "negative" },
    { label: "手把断裂", patterns: [/handle\s*bar.{0,30}(break|snap|broke|bent)/i], stars: "negative" },
    { label: "品控问题", patterns: [/poor\s+quality|cheap\s+material|defect|fell\s+apart/i], stars: "negative" },
    { label: "塑料部件", patterns: [/plastic.{0,30}(break|cheap|flimsy)|too\s+much\s+plastic/i], stars: "negative" },
    { label: "使用寿命短", patterns: [/broke\s+within|lasted\s+(?:a\s+)?(?:week|month)|stopped\s+working|died\s+after/i], stars: "negative" },
    { label: "轮子故障", patterns: [/wheel.{0,30}(break|broke|crack|fall\s+off)/i], stars: "negative" },
    { label: "转向困难", patterns: [/turn(?:ing)?|steer(?:ing)?|lean.?to.?steer.{0,30}(hard|difficult|doesn't)/i], stars: "negative" },
  ],
  motives: [
    { label: "礼物购买", patterns: [/gift|birthday|christmas|grand(?:son|daughter)/i], stars: "any" },
    { label: "孩子喜欢", patterns: [/loves?\s+it|wanted\s+a\s+scooter|excited|obsessed/i], stars: "positive" },
    { label: "性价比", patterns: [/affordable|good\s+price|value\s+for\s+money|worth\s+the\s+price/i], stars: "any" },
    { label: "发光功能", patterns: [/light\s*up|led|glow(?:ing)?\s+wheel/i], stars: "any" },
    { label: "可调节性", patterns: [/adjust(?:able)?|grow\s+with|multiple\s+height/i], stars: "any" },
    { label: "新手稳定性", patterns: [/three\s+wheel|3\s+wheel|stable|beginner|first\s+scooter/i], stars: "any" },
  ],
};

function reviewText(review) {
  return `${review.title ?? ""} ${review.content ?? ""}`.replace(/\s+/g, " ").trim();
}

function starBucket(star) {
  if (!star) return "neutral";
  if (star >= 4) return "positive";
  if (star <= 3) return "negative";
  return "neutral";
}

function snippet(text, pattern, max = 140) {
  const match = text.match(pattern);
  if (!match || match.index === undefined) return text.slice(0, max);
  const start = Math.max(0, match.index - 40);
  return text.slice(start, start + max).trim();
}

function aggregateBlock(reviews, key, limit = 5) {
  const rules = themeRules[key];
  const total = reviews.length || 1;
  const hits = new Map();

  reviews.forEach(review => {
    const bucket = starBucket(review.star);
    const text = reviewText(review);
    if (!text) return;

    rules.forEach(rule => {
      if (rule.stars === "positive" && bucket !== "positive") return;
      if (rule.stars === "negative" && bucket !== "negative") return;
      if (!rule.patterns.some(pattern => pattern.test(text))) return;
      const current = hits.get(rule.label) ?? { count: 0, reason: "" };
      current.count += 1;
      if (!current.reason) current.reason = snippet(text, rule.patterns[0]);
      hits.set(rule.label, current);
    });
  });

  return {
    key,
    label: blockLabels[key],
    rows: [...hits.entries()]
      .map(([label, entry]) => ({
        label,
        sharePct: Number(((entry.count / total) * 100).toFixed(2)),
        reason: translateReviewReason(label, entry.reason),
      }))
      .sort((a, b) => b.sharePct - a.sharePct || a.label.localeCompare(b.label, "zh-CN"))
      .slice(0, limit),
  };
}

export function buildReviewAnalysisFromRecords(asin, marketplace, reviews, fetchedAt) {
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

  const keys = ["consumerProfile", "scenarios", "unmet", "positives", "negatives", "motives"];
  return {
    asin,
    marketplace,
    sampledReviews: reviews.length,
    fetchedAt,
    status: "ready",
    blocks: keys.map(key => aggregateBlock(reviews, key)),
  };
}
