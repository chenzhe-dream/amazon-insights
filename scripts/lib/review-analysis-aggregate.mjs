import { detectProductFamily } from "./product-family.mjs";
import { translateReviewReason } from "./review-label-zh.mjs";
import { germanReviewMatches, isGermanGenericPraise } from "./german-review-themes.mjs";

const blockLabels = {
  consumerProfile: "消费者画像",
  scenarios: "使用场景",
  unmet: "未满足需求候选",
  positives: "好评点",
  negatives: "差评点",
  motives: "购买动机",
};

const scooterThemeRules = {
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
    { label: "发光轮", patterns: [/light\s*up|glow(?:ing)?\s+wheel|flash(?:ing)?\s+wheel/i], stars: "positive" },
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
    { label: "发光功能", patterns: [/light\s*up|glow(?:ing)?\s+wheel/i], stars: "any" },
    { label: "可调节性", patterns: [/adjust(?:able)?|grow\s+with|multiple\s+height/i], stars: "any" },
    { label: "新手稳定性", patterns: [/three\s+wheel|3\s+wheel|stable|beginner|first\s+scooter/i], stars: "any" },
  ],
};

const lightingThemeRules = {
  consumerProfile: [
    { label: "客厅使用", patterns: [/living\s*room|family\s*room|sofa|couch/i], stars: "any" },
    { label: "卧室使用", patterns: [/bedroom|nightstand|beside\s+the\s+bed|guest\s+room/i], stars: "any" },
    { label: "公寓/小户型", patterns: [/apartment|small\s+space|studio|renter|tiny\s+home/i], stars: "any" },
    { label: "办公室", patterns: [/\boffice\b|home\s+office|desk/i], stars: "any" },
    { label: "送礼对象", patterns: [/gift\s+for|bought\s+(?:this\s+)?for\s+(?:my|his|her)\s+(?:wife|mom|mother|husband|parent)/i], stars: "any" },
  ],
  scenarios: [
    { label: "客厅角落", patterns: [/living\s*room|corner\s+(?:of\s+the\s+)?(?:room|living)|beside\s+(?:the\s+)?(?:sofa|couch)/i], stars: "any" },
    { label: "卧室/床头", patterns: [/bedroom|nightstand|bedside|next\s+to\s+(?:the\s+)?bed/i], stars: "any" },
    { label: "置物展示", patterns: [/stor(?:e|age|ing)|display|photo|plant|book|shelf/i], stars: "any" },
    { label: "阅读/氛围照明", patterns: [/read(?:ing)?|ambient|mood\s+light|soft\s+light|night\s+light/i], stars: "any" },
    { label: "装饰搭配", patterns: [/decor|aesthetic|matches?\s+(?:my|the)\s+(?:room|furniture|style)/i], stars: "any" },
    { label: "节日礼物", patterns: [/christmas\s+gift|holiday\s+gift|birthday\s+gift|housewarming/i], stars: "any" },
  ],
  unmet: [
    { label: "灯体不稳/晃动", patterns: [/wobbly|wobble|tip(?:s|ped|ping)?|unstable|leans?/i], stars: "negative" },
    { label: "灯罩颜色/透光", patterns: [/shade.{0,30}(color|yellow|cheap|thin)|too\s+(?:bright|dim|harsh)|glare/i], stars: "negative" },
    { label: "安装说明不清", patterns: [/instruction|confus(?:ed|ing)\s+assembl|missing\s+(?:screw|part|piece)|hard\s+to\s+assembl/i], stars: "negative" },
    { label: "板材/做工偏弱", patterns: [/particle\s+board|mdf|flimsy|cheap\s+(?:wood|material)|chipped/i], stars: "negative" },
    { label: "层板空间不足", patterns: [/shelf.{0,30}(small|narrow|tiny)|not\s+enough\s+(?:space|room|storage)/i], stars: "negative" },
    { label: "灯泡/色温问题", patterns: [/bulb.{0,30}(burn|die|dim|not\s+included)|color\s+temperature|cct/i], stars: "negative" },
  ],
  positives: [
    { label: "置物收纳", patterns: [/stor(?:e|age)|display|shelf|photo|plant|book/i], stars: "positive" },
    { label: "三色温/照明", patterns: [/color\s+temperature|3000k|soft\s+light|bright(?:ness)?|led\s+bulb|three\s+color|3\s+color/i], stars: "positive" },
    { label: "安装便捷", patterns: [/easy\s+assembl|quick\s+assembl|simple\s+assembl|took\s+\d+\s+minute/i], stars: "positive" },
    { label: "结构稳固", patterns: [/sturd(?:y|ier)|solid|well\s+built|stable|doesn'?t\s+wobble/i], stars: "positive" },
    { label: "外观装饰", patterns: [/looks?\s+(?:expensive|nice|great)|aesthetic|decor|beautiful|stylish/i], stars: "positive" },
    { label: "节省空间", patterns: [/space[\s-]?saving|small\s+footprint|fits?\s+(?:perfectly|in\s+the\s+corner)/i], stars: "positive" },
  ],
  negatives: [
    { label: "晃动不稳", patterns: [/wobbly|wobble|tip(?:s|ped)?|unstable/i], stars: "negative" },
    { label: "安装困难", patterns: [/hard\s+to\s+assembl|confus(?:ed|ing)|missing\s+part|instruction/i], stars: "negative" },
    { label: "材质偏廉价", patterns: [/cheap\s+(?:look|material|wood)|flimsy|particle\s+board|chipped/i], stars: "negative" },
    { label: "亮度/刺眼", patterns: [/too\s+(?:bright|dim|harsh)|glare|not\s+bright\s+enough/i], stars: "negative" },
    { label: "运输破损", patterns: [/arrived\s+damaged|broken\s+in\s+shipping|box\s+was\s+destroyed/i], stars: "negative" },
  ],
  motives: [
    { label: "灯架一体", patterns: [/lamp.{0,20}shelf|shelf.{0,20}lamp|storage.{0,20}light|light.{0,20}storage/i], stars: "any" },
    { label: "性价比", patterns: [/affordable|good\s+price|value\s+for\s+money|worth\s+the\s+price|cheap/i], stars: "any" },
    { label: "小户型家具", patterns: [/apartment|small\s+space|studio|corner/i], stars: "any" },
    { label: "装饰风格", patterns: [/decor|aesthetic|matches?\s+my|farmhouse|modern|minimal/i], stars: "any" },
    { label: "礼物购买", patterns: [/gift|housewarming|birthday|christmas/i], stars: "any" },
  ],
};

const genericThemeRules = {
  consumerProfile: [
    { label: "儿童使用", patterns: [/\b(?:kids?|children|child|toddlers?)\b/i], stars: "any" },
    { label: "家庭使用", patterns: [/family|household|we\s+use/i], stars: "any" },
    { label: "送礼对象", patterns: [/gift\s+for|bought\s+for/i], stars: "any" },
  ],
  scenarios: [
    { label: "室内使用", patterns: [/\bindoor\b/i], stars: "any" },
    { label: "平衡活动", patterns: [/\bbalance\s+board\b|\b(?:exercise|practice|training)\s+balance\b|\bwhile\s+[^.!?]{0,30}\bbalancing\b/i], stars: "any" },
    { label: "学习间隙休息", patterns: [/\b(?:homeschooling|school|study|learning)\s+breaks?\b/i], stars: "any" },
    { label: "日常家用", patterns: [/home|house|daily|everyday/i], stars: "any" },
    { label: "礼物场景", patterns: [/gift|birthday|christmas|holiday/i], stars: "any" },
  ],
  unmet: [
    { label: "品控改进", patterns: [/quality\s+control|missing\s+part|defect|qc/i], stars: "negative" },
    { label: "耐用性", patterns: [/not\s+durable|\bbroke\b|fell\s+apart/i], stars: "negative" },
  ],
  positives: [
    { label: "安装便捷", patterns: [/easy\s+assembl|quick\s+assembl|simple\s+assembl/i], stars: "positive" },
    { label: "结构稳固", patterns: [/sturd(?:y|ier)|solid|well\s+built|stable/i], stars: "positive" },
    { label: "外观颜值", patterns: [/looks?\s+(?:nice|great)|beautiful|stylish/i], stars: "positive" },
  ],
  negatives: [
    { label: "品控问题", patterns: [/poor\s+quality|cheap\s+material|defect|fell\s+apart/i], stars: "negative" },
    { label: "使用寿命短", patterns: [/broke\s+within|lasted\s+(?:a\s+)?(?:week|month)|stopped\s+working/i], stars: "negative" },
  ],
  motives: [
    { label: "性价比", patterns: [/affordable|good\s+price|value\s+for\s+money|worth\s+the\s+price/i], stars: "any" },
    { label: "礼物购买", patterns: [/gift|birthday|christmas/i], stars: "any" },
  ],
};

export function detectReviewFamily(context = {}) {
  if (context.family === "scooter" || context.family === "lighting" || context.family === "generic") {
    return context.family;
  }
  return detectProductFamily(context);
}

export function customersSayFilters(family) {
  if (family === "lighting") {
    return {
      consumerProfile: /living|bedroom|apartment|office|adult|family|guest|renter|home|wife|husband|parent/i,
      scenarios: /living|bedroom|corner|office|nightstand|storage|gift|indoor|decor|apartment|shelf/i,
      motives: /value|gift|quality|light|bright|storage|assembl|sturd|price|decor|ease/i,
    };
  }
  if (family === "generic") {
    return {
      consumerProfile: /family|adult|home|gift|parent|wife|husband|kid|child|office|apartment|guest|renter/i,
      scenarios: /home|gift|indoor|daily|office|room|bedroom|living|outdoor|travel|kitchen|corner|desk/i,
      motives: /value|gift|quality|price|ease|durability|sturd|look|design|size|storage|light|bright|assembl/i,
    };
  }
  return {
    consumerProfile: /age|toddler|kid|child|grand/i,
    scenarios: /gift|outdoor|travel|birthday|fun|maneuver/i,
    motives: /value|gift|quality|light|adjust|ease|fun|age|durability|sturd/i,
  };
}

function themeRulesFor(family) {
  if (family === "lighting") return lightingThemeRules;
  if (family === "generic") return genericThemeRules;
  return scooterThemeRules;
}

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

function aggregateBlock(reviews, key, family, marketplace, limit = 5) {
  const rules = themeRulesFor(family)[key] ?? [];
  const total = reviews.length || 1;
  const hits = new Map();

  reviews.forEach(review => {
    const bucket = starBucket(review.star);
    const text = reviewText(review);
    if (!text) return;
    const reviewHits = new Map();

    rules.forEach(rule => {
      if (rule.stars === "positive" && bucket !== "positive") return;
      if (rule.stars === "negative" && bucket !== "negative") return;
      if (!rule.patterns.some(pattern => pattern.test(text))) return;
      reviewHits.set(rule.label, snippet(text, rule.patterns[0]));
    });
    if (marketplace === 'DE') {
      for (const match of germanReviewMatches(text, key, bucket)) reviewHits.set(match.label, match.reason);
    }
    for (const [label, reason] of reviewHits) {
      const current = hits.get(label) ?? { count: 0, reason: "" };
      current.count += 1;
      if (!current.reason) current.reason = reason;
      hits.set(label, current);
    }
  });

  return {
    key,
    label: blockLabels[key],
    rows: [...hits.entries()]
      .map(([label, entry]) => ({
        label,
        sharePct: Number(((entry.count / total) * 100).toFixed(2)),
        metricKind: "review_sample_incidence",
        numerator: entry.count,
        denominator: reviews.length,
        reason: translateReviewReason(label, entry.reason, family),
      }))
      .filter(row => row.sharePct >= 2 || family === "scooter")
      .sort((a, b) => b.sharePct - a.sharePct || a.label.localeCompare(b.label, "zh-CN"))
      .slice(0, limit),
  };
}

export function buildReviewAnalysisFromRecords(asin, marketplace, reviews, fetchedAt, context = {}) {
  const family = detectReviewFamily(context);
  if (!reviews.length) {
    return {
      asin,
      marketplace,
      sampledReviews: 0,
      fetchedAt,
      status: "pending",
      statusMessage: "卖家精灵 review 接口未返回评论样本",
      blocks: [],
      family,
    };
  }

  const keys = ["consumerProfile", "scenarios", "unmet", "positives", "negatives", "motives"];
  const genericPraiseOnly = marketplace === 'DE' && reviews.every(review =>
    starBucket(review.star) === 'positive' && isGermanGenericPraise(reviewText(review)));
  return {
    asin,
    marketplace,
    sampledReviews: reviews.length,
    fetchedAt,
    status: "ready",
    ...(genericPraiseOnly ? {statusMessage:'仅有笼统好评（原文：Super），缺少具体主题，待补充。'} : {}),
    family,
    blocks: keys.map(key => aggregateBlock(reviews, key, family, marketplace)),
  };
}
