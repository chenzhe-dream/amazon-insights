/** 关键词按含义分类 · 12 标签标准词表（全项目统一引用） */
export type KeywordMeaningGroup =
  | "product"
  | "feature"
  | "people"
  | "spec"
  | "marketing";

export type KeywordCategory =
  | "core_product"
  | "category"
  | "function"
  | "benefit"
  | "pain_need"
  | "audience"
  | "age"
  | "scenario"
  | "attribute_spec"
  | "material_style"
  | "holiday_season"
  | "brand_competitor";

export type KeywordCategoryMeta = {
  id: KeywordCategory;
  label: string;
  shortLabel: string;
  description: string;
  examples: string[];
  group: KeywordMeaningGroup;
  groupLabel: string;
  color: string;
  listingHint: string;
};

const GROUP_LABELS: Record<KeywordMeaningGroup, string> = {
  product: "产品定位",
  feature: "功能与需求",
  people: "人群与场景",
  spec: "规格与风格",
  marketing: "营销相关",
};

const PALETTE = [
  "#2F80ED",
  "#7A67D8",
  "#29A7C7",
  "#F0A020",
  "#E65B6A",
  "#26A269",
  "#D45D9E",
  "#6C86B6",
  "#D26A3A",
  "#18A0A8",
  "#9B72D4",
  "#55A630",
];

function meta(
  id: KeywordCategory,
  label: string,
  shortLabel: string,
  description: string,
  examples: string[],
  group: KeywordMeaningGroup,
  listingHint: string,
  colorIndex: number,
): KeywordCategoryMeta {
  return {
    id,
    label,
    shortLabel,
    description,
    examples,
    group,
    groupLabel: GROUP_LABELS[group],
    color: PALETTE[colorIndex % PALETTE.length],
    listingHint,
  };
}

/** 12 类关键词含义分类标准 */
export const keywordMeaningTaxonomy: KeywordCategoryMeta[] = [
  meta("core_product", "产品词", "产品", "直接描述产品是什么", ["kids scooter", "toddler scooter", "3 wheel scooter"], "product", "标题核心名词与主图产品主体", 0),
  meta("category", "类目词", "类目", "更上层、更宽泛的产品类目或泛检索", ["scooters", "kids outdoor toys", "lighting"], "product", "后台类目与广泛匹配投放评估", 1),
  meta("function", "功能词", "功能", "描述产品具备的具体功能或操控方式", ["foldable", "3 wheel", "with seat", "lean to steer", "remote control"], "feature", "五点 / A+ 功能模块，对齐规格与差异化", 2),
  meta("benefit", "卖点/利益词", "利益", "描述能给顾客带来的结果", ["easy to assemble", "smooth ride", "stable", "durable"], "feature", "主图文案与 A+ 利益点模块", 3),
  meta("pain_need", "痛点/需求词", "痛点", "顾客为解决某个问题而搜索", ["lighting for dark corner", "storage for small spaces"], "feature", "与 VOC 差评交叉，写入解决型五点", 4),
  meta("audience", "人群词", "人群", "产品为谁使用（含性别定向）", ["for kids", "for boys", "for girls", "for toddlers"], "people", "标题前后段与主图模特，明确购买对象", 5),
  meta("age", "年龄词", "年龄", "对使用者年龄的明确区间", ["2 year old", "ages 3-5", "kids ages 6-12"], "people", "标题年龄区间、包装适龄标与合规警示", 6),
  meta("scenario", "场景词", "场景", "使用环境、地点或活动场景", ["for outdoor", "for camping", "patio", "nursery"], "people", "A+ 场景图、视频脚本与场景化素材", 7),
  meta("attribute_spec", "属性规格词", "规格", "参数、尺寸、结构、安装、兼容等硬规格", ["lightweight", "12 inch", "wall mounted", "BPA free", "replacement wheels"], "spec", "规格表、五点参数、尺寸图与对比表", 8),
  meta("material_style", "材质风格词", "材质风格", "材质、颜色、设计风格", ["wooden", "metal", "black", "modern", "pink"], "spec", "变体主题、材质特写与风格化主图", 9),
  meta("holiday_season", "节日季节词", "节日季节", "节日送礼或季节性检索", ["Christmas gift", "birthday gift", "summer outdoor"], "marketing", "礼品季素材、Coupon 与季节性 Listing 调整", 10),
  meta("brand_competitor", "品牌竞品词", "品牌竞品", "品牌名、竞品型号或替代对比检索", ["Razor scooter", "alternative to", "Micro Kickboard"], "marketing", "品牌防守、差异化拦截与 defensive 广告", 11),
];

export const keywordCategoryMeta = keywordMeaningTaxonomy;

export const keywordMeaningGroups = (Object.keys(GROUP_LABELS) as KeywordMeaningGroup[]).map(group => ({
  id: group,
  label: GROUP_LABELS[group],
  categories: keywordMeaningTaxonomy.filter(item => item.group === group),
}));

export function categoryMeta(id: KeywordCategory): KeywordCategoryMeta {
  return keywordMeaningTaxonomy.find(item => item.id === id) ?? keywordMeaningTaxonomy[0];
}

export function categoryColorMap(): Record<KeywordCategory, string> {
  return Object.fromEntries(keywordMeaningTaxonomy.map(item => [item.id, item.color])) as Record<KeywordCategory, string>;
}
