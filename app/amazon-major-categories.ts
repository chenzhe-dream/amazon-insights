/** Amazon 前台 BSR 大类（Best Sellers 根类目），与 Listing rankCategory 对齐 */

export const AMAZON_MAJOR_CATEGORIES = [
  { id: "Sports & Outdoors", zh: "户外运动" },
  { id: "Toys & Games", zh: "玩具和游戏" },
  { id: "Home & Kitchen", zh: "家居厨具" },
  { id: "Patio, Lawn & Garden", zh: "庭院草坪园艺" },
  { id: "Tools & Home Improvement", zh: "五金工具" },
  { id: "Beauty & Personal Care", zh: "美妆个护" },
  { id: "Baby", zh: "母婴" },
  { id: "Pet Supplies", zh: "宠物用品" },
  { id: "Electronics", zh: "电子产品" },
  { id: "Automotive", zh: "汽车用品" },
  { id: "Clothing, Shoes & Jewelry", zh: "服装鞋靴珠宝" },
  { id: "Health & Household", zh: "健康家居" },
  { id: "Appliances", zh: "家电" },
  { id: "Office Products", zh: "办公用品" },
  { id: "Arts, Crafts & Sewing", zh: "工艺缝纫" },
  { id: "Grocery & Gourmet Food", zh: "食品杂货" },
] as const;

export type AmazonMajorCategoryId = (typeof AMAZON_MAJOR_CATEGORIES)[number]["id"];

export const AMAZON_MAJOR_CATEGORY_IDS: readonly string[] = AMAZON_MAJOR_CATEGORIES.map(item => item.id);

const LEGACY_MAJOR_CATEGORY_MAP: Record<string, AmazonMajorCategoryId> = {
  户外运动: "Sports & Outdoors",
  灯具: "Tools & Home Improvement",
  家居: "Home & Kitchen",
  家具: "Home & Kitchen",
  玩具: "Toys & Games",
  园艺: "Patio, Lawn & Garden",
  美妆: "Beauty & Personal Care",
  母婴: "Baby",
  宠物: "Pet Supplies",
  厨房: "Home & Kitchen",
  电子: "Electronics",
  汽车: "Automotive",
  服装: "Clothing, Shoes & Jewelry",
  其他: "Home & Kitchen",
};

const RANK_CATEGORY_ALIASES: Record<string, AmazonMajorCategoryId> = {
  "sports and outdoors": "Sports & Outdoors",
  "sports & outdoors": "Sports & Outdoors",
  "toys and games": "Toys & Games",
  "toys & games": "Toys & Games",
  "home and kitchen": "Home & Kitchen",
  "home & kitchen": "Home & Kitchen",
  "kitchen & dining": "Home & Kitchen",
  "kitchen and dining": "Home & Kitchen",
  furniture: "Home & Kitchen",
  "patio, lawn & garden": "Patio, Lawn & Garden",
  "patio lawn & garden": "Patio, Lawn & Garden",
  "lawn & garden": "Patio, Lawn & Garden",
  "lawn and garden": "Patio, Lawn & Garden",
  "tools and home improvement": "Tools & Home Improvement",
  "tools & home improvement": "Tools & Home Improvement",
  lighting: "Tools & Home Improvement",
  "beauty & personal care": "Beauty & Personal Care",
  beauty: "Beauty & Personal Care",
  "baby products": "Baby",
  baby: "Baby",
  "pet supplies": "Pet Supplies",
  electronics: "Electronics",
  automotive: "Automotive",
  "clothing, shoes & jewelry": "Clothing, Shoes & Jewelry",
  "health & household": "Health & Household",
  appliances: "Appliances",
  "office products": "Office Products",
  "arts, crafts & sewing": "Arts, Crafts & Sewing",
  "grocery & gourmet food": "Grocery & Gourmet Food",
};

function normalizeCategoryKey(value: string) {
  return value.trim().toLowerCase().replace(/&/g, "and").replace(/,/g, " ").replace(/\s+/g, " ");
}

export function amazonMajorCategoryLabel(id: string) {
  const hit = AMAZON_MAJOR_CATEGORIES.find(item => item.id === id);
  return hit ? `${hit.id}（${hit.zh}）` : id;
}

export function amazonMajorCategoryChip(id: string) {
  const hit = AMAZON_MAJOR_CATEGORIES.find(item => item.id === id);
  return hit?.zh ?? id;
}

export function normalizeAmazonMajorCategory(raw: string | null | undefined): string | null {
  if (!raw?.trim() || raw.trim() === "等待同步") return null;
  const trimmed = raw.trim();
  if (AMAZON_MAJOR_CATEGORY_IDS.includes(trimmed)) return trimmed;
  if (LEGACY_MAJOR_CATEGORY_MAP[trimmed]) return LEGACY_MAJOR_CATEGORY_MAP[trimmed];
  const alias = RANK_CATEGORY_ALIASES[normalizeCategoryKey(trimmed)];
  if (alias) return alias;
  const fuzzy = AMAZON_MAJOR_CATEGORIES.find(item => normalizeCategoryKey(item.id) === normalizeCategoryKey(trimmed));
  return fuzzy?.id ?? null;
}

export function inferAmazonMajorCategory(products: Array<{ rankCategory?: string | null }>): string | null {
  const counts = new Map<string, number>();
  for (const product of products) {
    const id = normalizeAmazonMajorCategory(product.rankCategory);
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}
