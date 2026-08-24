export type AsinModuleResult = {
  status: "ready" | "upstream-empty" | "timeout" | "connector-failed" | "pending" | "manual";
  reason: string | null;
  updatedAt: string;
};

export const SYNC_STAGE_TEMPLATE = [
  { id: "catalog", label: "卖家精灵商品底库", detail: "asin_detail + 销量趋势 → competitor-data.ts", kind: "auto" as const },
  { id: "keywords", label: "SIF 关键词 MCP", detail: "流量词信号 + 月搜索量 enrichment", kind: "auto" as const },
  { id: "reviews", label: "Sorftime 评论 MCP", detail: "product_detail 评分/评论 + Customers Say + 评论样本", kind: "auto" as const },
  { id: "sales_trend", label: "销量 / 价格 / BSR 趋势", detail: "Sorftime · 月销量 / 销售额 / 历史价格 / 大类 BSR", kind: "auto" as const },
  { id: "child_sales", label: "近30天子体销量", detail: "Sorftime · product_variations 变体评论占比 + 子体销量", kind: "auto" as const },
  { id: "price_strategy", label: "价格策略分析", detail: "Sorftime · 定价锚点 / 促销手法", kind: "auto" as const },
  { id: "fba", label: "FBA 费用", detail: "Sorftime · 包装尺寸估费", kind: "auto" as const },
  { id: "listing", label: "主辅图 / A+", detail: "Sorftime · main_image / a_plus", kind: "auto" as const },
  { id: "category", label: "BSR 小类市场趋势", detail: "Sorftime · 小类 Top100 口径", kind: "auto" as const },
  { id: "traffic", label: "竞品流量结构", detail: "SIF · Listing 流量结构 + 子体拆解 + 近6月月趋势", kind: "auto" as const },
  { id: "image_remarks", label: "主辅图视觉备注", detail: "最多同时分析 2 张图片 · 单图 90 秒", kind: "auto" as const },
  { id: "alexa_voc", label: "Alexa VOC 核心主题", detail: "需人工录入，不阻塞基础数据或任务完成", kind: "manual" as const },
] as const;

export type AsinDataStatusItem = {
  asin: string;
  inCatalog: boolean;
  keywords: "ready" | "missing";
  reviews: "ready" | "missing";
  sales: "ready" | "missing";
  childSales: "ready" | "missing";
  priceStrategy: "ready" | "missing";
  fba: "ready" | "missing";
  listing: "ready" | "missing";
  imageRemarks: "ready" | "missing";
  category: "ready" | "missing";
  traffic: "ready" | "missing";
  voc: "ready" | "missing";
};

export type UnavailableProviderWarning = Readonly<{
  connectorId: "sellerSprite" | "sif" | "sorftime";
  label: string;
  modules: readonly string[];
  message: string;
}>;

type ProviderWarningModule = Readonly<{
  label: string;
  status: keyof Pick<
    AsinDataStatusItem,
    "inCatalog" | "keywords" | "reviews" | "sales" | "childSales" | "priceStrategy" | "fba" | "listing" | "category" | "traffic"
  >;
}>;

const PROVIDER_WARNING_MODULES = Object.freeze({
  sellerSprite: Object.freeze([{ label: "商品底库", status: "inCatalog" }]),
  sif: Object.freeze([
    { label: "关键词", status: "keywords" },
    { label: "竞品流量", status: "traffic" },
  ]),
  sorftime: Object.freeze([
    { label: "评论", status: "reviews" },
    { label: "销量趋势", status: "sales" },
    { label: "子体销量", status: "childSales" },
    { label: "价格策略", status: "priceStrategy" },
    { label: "FBA", status: "fba" },
    { label: "Listing", status: "listing" },
    { label: "类目趋势", status: "category" },
  ]),
} as const satisfies Record<UnavailableProviderWarning["connectorId"], readonly ProviderWarningModule[]>);

type ProviderCapabilities = Readonly<{
  capabilities: Readonly<Record<UnavailableProviderWarning["connectorId"], Readonly<{ available: boolean }>>>;
}>;

function isModuleMissing(item: AsinDataStatusItem, module: ProviderWarningModule) {
  return module.status === "inCatalog"
    ? !item.inCatalog
    : item[module.status] === "missing";
}

export function collectUnavailableProviderWarnings(
  items: readonly AsinDataStatusItem[],
  capabilities: ProviderCapabilities | null | undefined,
): UnavailableProviderWarning[] {
  if (!capabilities) return [];
  return (Object.keys(PROVIDER_WARNING_MODULES) as UnavailableProviderWarning["connectorId"][]).flatMap((connectorId) => {
    if (capabilities.capabilities[connectorId].available) return [];
    const modules = PROVIDER_WARNING_MODULES[connectorId]
      .filter((module) => items.some((item) => isModuleMissing(item, module)))
      .map((module) => module.label);
    if (modules.length === 0) return [];
    const label = connectorId === "sellerSprite" ? "SellerSprite" : connectorId === "sif" ? "SIF" : "Sorftime";
    return [{
      connectorId,
      label,
      modules,
      message: `${label} 当前不可用，将跳过${modules.join("、")}；其他可用数据源仍会继续。`,
    }];
  });
}

const STATUS_FIELD_BY_STAGE = {
  keywords: "keywords", reviews: "reviews", sales_trend: "sales", child_sales: "childSales",
  price_strategy: "priceStrategy", fba: "fba", listing: "listing", image_remarks: "imageRemarks",
  category: "category", alexa_voc: "voc", traffic: "traffic",
} as const satisfies Record<Exclude<(typeof SYNC_STAGE_TEMPLATE)[number]["id"], "catalog">, keyof AsinDataStatusItem>;

export function idleStageStatus(stageId: (typeof SYNC_STAGE_TEMPLATE)[number]["id"], items: AsinDataStatusItem[]): "done" | "pending" | "manual" {
  if (!items.length) return "pending";
  if (stageId === "catalog") return items.every(item => item.inCatalog) ? "done" : "pending";
  const ready = items.every(item => item[STATUS_FIELD_BY_STAGE[stageId]] === "ready");
  return stageId === "alexa_voc" && !ready ? "manual" : ready ? "done" : "pending";
}

export function jobLifecycleLabel(status: string) {
  if (status === "base-ready") return "基础数据已就绪";
  if (status === "enriching") return "正在补充图片备注";
  if (status === "completed-with-gaps") return "已完成（存在缺口）";
  if (status === "completed") return "已完成";
  if (status === "failed") return "基础设施失败";
  return "同步进行中";
}

export const moduleStatusLabel: Record<AsinModuleResult["status"], string> = {
  ready: "已就绪", "upstream-empty": "上游无数据", timeout: "超时",
  "connector-failed": "连接器失败", pending: "等待中", manual: "需人工录入",
};

export function collectAsinModuleGaps(progress: Record<string, Record<string, AsinModuleResult>>) {
  return Object.entries(progress).flatMap(([asin, modules]) => Object.entries(modules)
    .filter(([, result]) => result.status !== "ready" && result.status !== "pending")
    .map(([module, result]) => ({ asin, module, status: result.status, reason: result.reason })));
}
