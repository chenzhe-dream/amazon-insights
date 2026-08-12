import {
  categoryMeta,
  keywordMeaningTaxonomy,
  type KeywordCategory,
  type KeywordCategoryMeta,
} from "./keyword-meaning-taxonomy";
import { isNonEnglishKeyword, maybeTranslateForClassification, translateKeywordToEnglish } from "./keyword-non-english";

export type {
  KeywordCategory,
  KeywordCategoryMeta,
  KeywordMeaningGroup,
} from "./keyword-meaning-taxonomy";
export {
  categoryMeta,
  categoryColorMap,
  keywordCategoryMeta,
  keywordMeaningGroups,
  keywordMeaningTaxonomy,
} from "./keyword-meaning-taxonomy";
export { isNonEnglishKeyword, translateKeywordToEnglish } from "./keyword-non-english";

export type ClassifyKeywordContext = {
  brands?: string[];
  productNouns?: string[];
};

export type ClassifiedKeywordResult = {
  keyword: string;
  category: KeywordCategory;
  meta: KeywordCategoryMeta;
  /** 非英语词英译后用于分类的文本 */
  translatedKeyword?: string;
  /** 是否通过英译重新归类（避免误落泛需求词） */
  reclassifiedFromNonEnglish?: boolean;
};

type ClassifyRule = {
  category: KeywordCategory;
  priority: number;
  patterns: RegExp[];
};

const COLOR_WORDS =
  /\b(black|white|gold|silver|grey|gray|red|blue|green|pink|purple|yellow|orange|brown|beige|navy|teal|ivory|cream|bronze|copper|rose gold|natural wood|multicolor|multi-color|negro|blanco|rosa|azul|rojo|verde)\b/i;

const MATERIAL_WORDS =
  /\b(wooden|wood|metal|steel|aluminum|aluminium|rattan|wicker|fabric|cotton|linen|leather|plastic|silicone|rubber|bamboo|glass|ceramic|iron|brass|acrylic|polyester|nylon|mesh|madera|metalico|metálico)\b/i;

const STYLE_WORDS =
  /\b(modern|farmhouse|boho|minimalist|industrial|rustic|vintage|retro|scandinavian|mid century|contemporary|traditional|classic|luxury|coastal)\b/i;

const FUNCTION_WORDS =
  /\b(dimmable|foldable|folding|rechargeable|adjustable|height adjustable|lean.?to.?steer|3[\s-]?wheel|two.?in.?one|2.?in.?1|convertible|removable|swivel|rotat|tilt|brake|led|light.?up|glow|usb|solar|smart|bluetooth|wifi|waterproof|water resistant|portable|collaps|plegable|recargable|ajustable|impermeable)\b/i;

const BENEFIT_WORDS =
  /\b(space saving|easy to assemble|easy assembly|eye caring|eye.?care|quiet|noiseless|no.?tool|tool.?free|comfortable|smooth ride|stable|sturdy|durable|long lasting|energy saving|eco.?friendly)\b/i;

const ATTRIBUTE_WORDS =
  /\b(large|small|mini|compact|lightweight|heavy.?duty|cordless|wireless|waterproof|portable|heavy|extra wide|wide deck|non.?slip|ligero|ligera)\b/i;

const ACTIVITY_WORDS =
  /\b(camping|gardening|swimming|reading|hiking|fishing|yoga|running|skating|commut)\b/i;

const LOCATION_WORDS =
  /\b(apartment|patio|garage|dorm room|dorm|backyard|balcony|basement|entryway|hallway|nursery|playroom|living room)\b/i;

const SCENARIO_FOR =
  /\bfor (bedroom|office|camping|kitchen|bathroom|outdoor|indoor|travel|school|home|gym|nursery|playroom|living room|dining room|patio|garden|beach|party)\b/i;

const AUDIENCE_FOR =
  /\bfor (kids?|children|child|women|woman|men|man|seniors?|senior|elderly|adults?|adult|beginners?|beginner|teens?|teenagers?|toddlers?|toddler|babies|baby|infants?|infant|parents?|mom|dad)\b/i;

const GENDER_FOR = /\bfor (boys?|girls?|men|women|him|her)\b/i;

/** 人群/性别信号：含产品词时仍优先于纯产品词分类 */
const GENDER_SIGNAL =
  /\bfor (boys?|girls?|men|women|him|her)\b|\b(boys?|girls?)\s+(scooter|scooters|toy|toys|lamp|lamps|patinete|patinetes)\b|\b(mens?|womens?)\s+(scooter|scooters)\b/i;

const AUDIENCE_SIGNAL =
  /\bfor (kids?|children|child|toddlers?|teens?|seniors?|adults?|beginners?|babies|baby|infants?)\b|\b(kids?|children|child|toddlers?|teens?|seniors?|beginners?|babies|baby|infants?)\s+(\d+\s*[- ]?wheel\s+)?(scooter|scooters|kick scooter|toy|toys|lamp|lamps|wheel|wheels)\b|\b(scooter|scooters|kick scooter|toy|toys|lamp|lamps)\s+for\s+(kids?|children|child|toddlers?|teens?|seniors?|adults?|beginners?)\b/i;

/** 常见市场品牌（含竞品 catalog 未收录的搜索品牌 · 单复数由边界匹配） */
const MARKETPLACE_BRANDS = [
  "razor",
  "ziffy",
  "ozbozz",
  "micro",
  "globber",
  "skidee",
  "hurtle",
  "besrey",
  "allek",
  "tonbux",
  "wonder view",
  "wv wonder view",
  "philips",
  "ikea",
  "outonlife",
  "jetson",
  "gotrax",
  "segway",
  "xiaomi",
];

const GIFT_HOLIDAY =
  /\b(christmas|xmas|birthday|halloween|valentine|mother'?s day|father'?s day|easter|thanksgiving|gift|present|stocking stuffer|regalo|navidad)\b/i;

const SEASON = /\b(summer|winter|spring|fall|autumn|all season|year.?round|verano|invierno)\b/i;

const SAFETY = /\b(bpa.?free|non.?toxic|non toxic|ul listed|ce certified|fda|cpc|astm|safety certified|lead.?free|phthalate)\b/i;

const INSTALL =
  /\b(wall mounted|wall.?mount|clip on|clip.?on|freestanding|free.?standing|ceiling mount|floor standing|hanging|suction cup|adhesive|plug.?in|hardwired)\b/i;

const USAGE_CONTROL =
  /\b(remote control|touch control|app controlled|voice control|alexa|google home|timer|dimmer switch|pull chain|foot switch|motion sensor)\b/i;

const COMPAT =
  /\b(compatible with|fits|works with|for e26|for e27|for alexa|for google|for iphone|for android)\b/i;

/** 配件语境：需有 replacement/spare 等，或「产品名 + 零件」；不含三轮/大轮等产品规格 */
const ACCESSORY =
  /\b(replacement|spare|accessory|accessories|bracket|shade|bulb|charger|battery pack|cover|case|attachment|repuesto)\b/i;

const ACCESSORY_PARTS =
  /\b(replacement|spare|extra|accessory|accessories|repuesto)\s+(wheel|wheels|handlebar|grip|pad|rueda|ruedas)\b|\b(wheel|wheels|handlebar|grip|pad|rueda|ruedas)\s+(replacement|spare|set|pack|kit|only)\b|\b(scooter|kick scooter|lamp|lamps)\s+(wheel|wheels|handlebar|grip|shade|bulb)s?\b/i;

/** 轮数/大轮等为产品本体描述（如 3 wheel scooter），不是配件词 */
const PRODUCT_WHEEL_SPEC =
  /\b(\d+|three|3|two|2|big|light.?up)\s*[- ]?(wheel|wheels)\b|\b(wheel|wheels)\s+(scooter|scooters)\b|\b(scooter|scooters)\s+(\d+|three|3|two|2)\s*[- ]?(wheel|wheels)\b|\b\d+\s*wheel\s+scooter\b|\bthree\s+wheel\b|\bbig\s+wheel\b/i;

const ALTERNATIVE =
  /\b(alternative to|alternative|replacement for|better than|vs\.?|versus|compare|similar to|like the|instead of)\b/i;

const PAIN_NEED =
  /\b(for dark|dark corner|small space|small room|storage for|lighting for|solution for|help with|problem|fix for|need for)\b/i;

const BROAD_DEMAND = /\b(ideas|inspiration|best|top|review|guide|how to|what is|recommend)\b/i;

const SIZE_SPEC =
  /\b(\d+(\.\d+)?\s*(inch|inches|in|cm|mm|ft|feet|"|')\b|\d+\s*w\b|\d+\s*kw\b|\d+\s*l\b|\d+\s*ml\b|\d+\s*oz\b|set of \d+|\d+\s*pack|pack of \d+)\b/i;

const SHAPE =
  /\b(arc|tripod|tree.?shaped|tree shaped|a.?frame|l.?shaped|u.?shaped|round|square|rectangular|curved|telescop)\b/i;

const CATEGORY_WORDS =
  /\b(lighting|lamp|lamps|furniture|home decor|outdoor toys|kids toys|toys|scooter|scooters|sport|sports|kitchen|bedroom|bathroom|garden|patio|juguetes|juguete)\b/i;

const CORE_PRODUCT =
  /\b(floor lamp|table lamp|desk lamp|lamp shade|kids? scooter|kid scooter|children'?s? scooter|kick scooter|scooter for|scooter with|3 wheel scooter|toddler scooter|baby scooter)\b/i;

const classifyRules: ClassifyRule[] = [
  {
    category: "age",
    priority: 100,
    patterns: [
      /\b\d+\s*[-–]\s*\d+\b/,
      /\b\d+\s*\+\b/,
      /\b\d+\s*year/i,
      /\bage\s*\d/i,
      /\bmonths?\s*old/i,
      /\bages?\s*\d/i,
      /\bfor (toddlers|kids ages|children ages)/i,
      /\b\d+\s*años?\b/i,
      /\b\d+\s*to \d+\s*years?\b/i,
      /岁/,
      /月龄/,
    ],
  },
  {
    category: "audience",
    priority: 99,
    patterns: [
      GENDER_FOR,
      GENDER_SIGNAL,
      /\b(boys?|girls?|niñas?|ninas?)\s+(scooter|scooters|toy|toys|lamp|lamps|patinete|patinetes)\b/i,
    ],
  },
  { category: "brand_competitor", priority: 98, patterns: [ALTERNATIVE] },
  { category: "attribute_spec", priority: 97, patterns: [COMPAT] },
  { category: "attribute_spec", priority: 96, patterns: [SAFETY] },
  { category: "attribute_spec", priority: 95, patterns: [SIZE_SPEC] },
  { category: "material_style", priority: 94, patterns: [COLOR_WORDS] },
  { category: "material_style", priority: 93, patterns: [MATERIAL_WORDS] },
  { category: "attribute_spec", priority: 92, patterns: [INSTALL] },
  { category: "function", priority: 91, patterns: [USAGE_CONTROL] },
  { category: "holiday_season", priority: 90, patterns: [GIFT_HOLIDAY] },
  { category: "holiday_season", priority: 89, patterns: [SEASON] },
  { category: "attribute_spec", priority: 89, patterns: [PRODUCT_WHEEL_SPEC] },
  {
    category: "attribute_spec",
    priority: 88,
    patterns: [ACCESSORY, ACCESSORY_PARTS],
  },
  { category: "pain_need", priority: 87, patterns: [PAIN_NEED] },
  { category: "benefit", priority: 86, patterns: [BENEFIT_WORDS] },
  { category: "function", priority: 85, patterns: [FUNCTION_WORDS] },
  { category: "attribute_spec", priority: 84, patterns: [ATTRIBUTE_WORDS] },
  { category: "attribute_spec", priority: 83, patterns: [SHAPE] },
  { category: "material_style", priority: 82, patterns: [STYLE_WORDS] },
  { category: "scenario", priority: 81, patterns: [LOCATION_WORDS] },
  { category: "scenario", priority: 80, patterns: [ACTIVITY_WORDS] },
  { category: "scenario", priority: 79, patterns: [SCENARIO_FOR, /\b(outdoor|indoor|exterior|interior)\b/i] },
  {
    category: "audience",
    priority: 78,
    patterns: [
      AUDIENCE_FOR,
      AUDIENCE_SIGNAL,
      /\b(kids?|children|child|seniors?|beginners?|toddlers?|teens?|niños?|niñas?|ninos?|ninas?|kinder|enfants)\b/i,
      /\bpara (niños?|niñas?|ninos?|ninas?)\b/i,
    ],
  },
  {
    category: "core_product",
    priority: 50,
    patterns: [
      CORE_PRODUCT,
      /\b(scooters?|kick scooters?|floor lamps?|table lamps?|desk lamps?|patinete|patinetes|patinetas|monopatines?|monopatin)\b/i,
    ],
  },
  { category: "category", priority: 40, patterns: [CATEGORY_WORDS] },
  { category: "category", priority: 30, patterns: [BROAD_DEMAND] },
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildBrandPatterns(brands: string[]) {
  const merged = [...new Set([...MARKETPLACE_BRANDS, ...brands.filter(Boolean).map(item => item.trim())])];
  return merged.map(brand => new RegExp(`\\b${escapeRegExp(brand)}\\b`, "i"));
}

function keywordContainsBrand(text: string, context: ClassifyKeywordContext) {
  return buildBrandPatterns(context.brands ?? []).some(pattern => pattern.test(text));
}

/** 产品词命中后，若含品牌/人群/性别语义则改判更高优先级类别 */
function refineProductCategory(text: string, category: KeywordCategory, context: ClassifyKeywordContext): KeywordCategory {
  if (category !== "core_product") return category;
  if (GENDER_SIGNAL.test(text)) return "audience";
  if (keywordContainsBrand(text, context)) return "brand_competitor";
  if (AUDIENCE_SIGNAL.test(text)) return "audience";
  return category;
}

function buildProductNounPatterns(nouns: string[]) {
  return nouns.filter(Boolean).map(noun => new RegExp(`\\b${escapeRegExp(noun.trim())}\\b`, "i"));
}

function shouldRetranslateNonEnglish(keyword: string) {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return false;
  if (isNonEnglishKeyword(keyword)) return true;
  return translateKeywordToEnglish(keyword) !== normalized;
}

function classifyKeywordCore(
  keyword: string,
  context: ClassifyKeywordContext,
  options: { defaultCategory?: KeywordCategory } = {},
): KeywordCategory {
  const text = keyword.trim().toLowerCase();
  let best: { category: KeywordCategory; priority: number } | null = null;

  const brandPatterns = buildBrandPatterns(context.brands ?? []);
  for (const pattern of brandPatterns) {
    if (pattern.test(text)) {
      const priority = 94;
      if (!best || priority > best.priority) best = { category: "brand_competitor", priority };
    }
  }

  for (const rule of classifyRules) {
    if (rule.category === "attribute_spec" && rule.patterns.some(p => p === ACCESSORY || p === ACCESSORY_PARTS)) {
      if (PRODUCT_WHEEL_SPEC.test(text) && !ACCESSORY_PARTS.test(text)) continue;
    }
    if (rule.patterns.some(pattern => pattern.test(text))) {
      if (!best || rule.priority > best.priority) {
        best = { category: rule.category, priority: rule.priority };
      }
    }
  }

  const productPatterns = buildProductNounPatterns(context.productNouns ?? []);
  if (productPatterns.some(pattern => pattern.test(text))) {
    if (!best || 55 > best.priority) best = { category: "core_product", priority: 55 };
  }

  const resolved = best?.category ?? options.defaultCategory ?? "category";
  return refineProductCategory(text, resolved, context);
}

/** 按关键词含义分类 · 全项目统一入口 */
export function classifyKeyword(keyword: string, context: ClassifyKeywordContext = {}): KeywordCategory {
  return classifyKeywordDetailed(keyword, context).category;
}

/** 返回分类 + 元数据，便于页面展示与后续模块调用 */
export function classifyKeywordDetailed(keyword: string, context: ClassifyKeywordContext = {}): ClassifiedKeywordResult {
  const primaryCategory = classifyKeywordCore(keyword, context);

  const needsRetranslate =
    primaryCategory === "category" && shouldRetranslateNonEnglish(keyword);

  if (!needsRetranslate) {
    return { keyword, category: primaryCategory, meta: categoryMeta(primaryCategory) };
  }

  const { translated, usedTranslation } = maybeTranslateForClassification(keyword);
  const translatedCategory = classifyKeywordCore(translated, context, { defaultCategory: "core_product" });

  if (translatedCategory !== "category") {
    return {
      keyword,
      category: translatedCategory,
      meta: categoryMeta(translatedCategory),
      translatedKeyword: usedTranslation ? translated : undefined,
      reclassifiedFromNonEnglish: usedTranslation,
    };
  }

  return {
    keyword,
    category: primaryCategory,
    meta: categoryMeta(primaryCategory),
    translatedKeyword: usedTranslation ? translated : undefined,
  };
}

/** 批量分类 */
export function classifyKeywords(keywords: string[], context: ClassifyKeywordContext = {}): ClassifiedKeywordResult[] {
  return keywords.map(keyword => classifyKeywordDetailed(keyword, context));
}

/** 获取某分组下所有类别 ID */
export function categoriesInGroup(group: KeywordCategoryMeta["group"]) {
  return keywordMeaningTaxonomy.filter(item => item.group === group).map(item => item.id);
}
