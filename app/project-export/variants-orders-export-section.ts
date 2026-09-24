import { marketSites } from "../../shared/market-sites";
import { selectXydcOrderDisplaySnapshot } from "../../shared/xydc-order-display";
import { getXydcOrderWindow, summarizeXydcOrders } from "../../shared/xydc-order-summary";
import { groupXydcVariantFamilies } from "../../shared/xydc-variant-group";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";
import type { RuntimeAnalysisDataSnapshot } from "../lib/runtime-analysis-data";
import type { CurrentProjectDisplayVersion } from "../lib/project-display-version-browser";
import { xydcVariantAttributeLabel } from "../xydc-variant-label";
import { resolveVariantColor } from "../lib/variant-color";
import type { ExportBlock, ExportCell, ExportSection } from "./export-contracts";

const plain = (value: string | number | null | undefined) => value === null || value === undefined || value === "" ? "—" : String(value);
const cell = (value: string | number | null | undefined): ExportCell => ({ text: plain(value) });
const table = (title: string, columns: string[], rows: (string | number | null | undefined)[][]): ExportBlock =>
  ({ kind: "table", title, columns, rows: rows.map(row => row.map(cell)) });
const orderValue = (value: number | null) => value === null ? "缺失" : value === 0 ? "未披露（源值 0）" : `${value.toLocaleString("en-US")}+`;

/** Uses the same grouped parent families and order selection as the live page. */
export function buildVariantsOrdersExportSection(input: {
  snapshot: RuntimeAnalysisDataSnapshot;
  selectedAsins: readonly string[];
  sourceAsins: readonly string[];
  marketplace: string;
  capturedAt: string;
  version?: CurrentProjectDisplayVersion | null;
}): ExportSection {
  const { snapshot, selectedAsins, sourceAsins, marketplace, capturedAt, version } = input;
  const sourceSet = new Set(sourceAsins), selectedSet = new Set(selectedAsins);
  if (selectedAsins.some(asin => !sourceSet.has(asin))
    || snapshot.variants.families.some(family => !sourceSet.has(family.inputAsin) || family.country !== marketplace)
    || snapshot.variantOrders.families.some(family => family.country !== marketplace)) throw new Error("变体导出来源范围不匹配");
  const groups = groupXydcVariantFamilies(snapshot.variants.families)
    .filter(group => group.inputAsins.some(asin => selectedSet.has(asin)));
  const now = new Date(capturedAt);
  const window = getXydcOrderWindow(now);
  const domain = marketSites.find(site => site.code === marketplace)?.amazonDomain;
  if (version && version.marketplace !== marketplace) throw new Error("父体目录来源范围不匹配");
  // Match the page's unpublished placeholders; runtime catalog entries are not project-bound.
  const catalog = version?.catalog ?? [];
  const listing = version?.stageOutputs.listing;
  const listingByAsin = listing && "data" in listing ? (listing.data as { contentByAsin?: Record<string, { mainImage?: unknown }> }).contentByAsin : undefined;
  const blocks: ExportBlock[] = [
    { kind: "text", text: `来源：页面当前西柚洞察变体与订单缓存；导出读取时间 ${capturedAt}。这些缓存不与已发布分析运行绑定。订单为子体按自然月披露量，显示为下限（+）；源值 0 表示未披露，缺失表示未取得，均不作为实际零销量。` },
    { kind: "text", text: `当前默认统计窗口（UTC 前 12 个完整自然月）：${window.startMonth} — ${window.endMonth}。若有较旧的完整缓存，页面会展示该历史窗口。` },
  ];
  const progress = snapshot.xydcOrderProgress;
  if (progress) blocks.push({ kind: "text", text: `采集进度（仅当前任务状态，不能证明缓存属于该运行）：${progress.progress?.state ?? "待开始"}；已取得 ${progress.progress?.ready ?? 0}/${progress.progress?.total ?? 0}；缓存 ${progress.progress?.cached ?? 0}；更新 ${progress.progress?.updatedAt ?? "—"}；原因 ${progress.progress?.safeReason ?? "—"}。` });
  else blocks.push({ kind: "text", text: "采集进度：当前项目没有可展示的订单任务进度；缓存仍可能来自较早采集。" });

  const discovered = new Set(snapshot.variants.families.filter(family => family.children.length > 0 && family.cacheState === "fresh" && family.status !== "unavailable").map(family => family.inputAsin));
  const missing = selectedAsins.filter(asin => !snapshot.variants.families.some(family => family.inputAsin === asin));
  blocks.push({ kind: "text", text: `所选输入 ASIN ${selectedAsins.length} 个；已有新鲜变体关系 ${selectedAsins.filter(asin => discovered.has(asin)).length} 个；未找到缓存 ${missing.length} 个${missing.length ? `（${missing.join("、")}）` : ""}。` });

  for (const group of groups) {
    const selectedInputs = group.inputAsins.filter(asin => selectedSet.has(asin));
    const productAsin = group.inputAsins.find(asin => selectedSet.has(asin)) ?? group.inputAsins[0];
    const matches = catalog.filter(item => item && typeof item === "object" && !Array.isArray(item) && (item as { asin?: unknown }).asin === productAsin);
    if (matches.length > 1) throw new Error("父体商品目录来源重复");
    const product = matches[0] && typeof matches[0] === "object" && !Array.isArray(matches[0]) ? matches[0] as Record<string, unknown> : {};
    const image = typeof listingByAsin?.[productAsin ?? ""]?.mainImage === "string" ? listingByAsin?.[productAsin ?? ""]?.mainImage
      : product.image;
    const identity: XydcVariantFamily = { ...group, inputAsin: group.inputAsins[0] ?? group.parentAsin };
    const selected = selectXydcOrderDisplaySnapshot(snapshot.variantOrders.families, identity, window, now);
    const summary = selected ? summarizeXydcOrders(selected) : null;
    const orderWindow = selected?.window ?? window;
    const title = `${group.parentAsin} · ${group.children.length} 个子体`;
    blocks.push({ kind: "table", title: `${title} · 页面商品资料`, columns: ["父体", "输入 ASIN", "品牌", "标题", "主图"], rows: [[
      { text: group.parentAsin, ...(domain ? { href: `https://www.${domain}/dp/${group.parentAsin}` } : {}) },
      { text: selectedInputs.join("、") }, cell(typeof product.brand === "string" ? product.brand : null),
      cell(typeof product.title === "string" ? product.title : null),
      { text: typeof product.title === "string" ? product.title : group.parentAsin, ...(typeof image === "string" && image ? { imageUrl: image } : {}) },
    ]] });
    blocks.push({ kind: "text", text: `父体 ${group.parentAsin}；所选输入 ASIN ${selectedInputs.join("、")}；维度 ${group.dimensions.join("、") || "未提供"}；变体状态 ${group.status}；原因 ${group.reasonCode ?? "—"}；缓存 ${group.cacheState}；来源更新 ${group.sourceUpdatedAt ?? "未提供"}；采集 ${group.fetchedAt}。` });
    blocks.push({ kind: "text", text: selected
      ? `订单来源：西柚洞察；窗口 ${orderWindow.startMonth} — ${orderWindow.endMonth}；${selected.window.endMonth !== window.endMonth ? "历史缓存；" : ""}状态 ${summary?.complete ? "完整" : "部分"}；缓存 ${selected.cacheState}；原因 ${selected.reasonCode ?? "—"}；来源更新 ${selected.sourceUpdatedAt ?? "未提供"}；采集 ${selected.fetchedAt}；返回子体 ${summary?.returnedChildren}/${summary?.expectedChildren}；12 个月披露汇总 ${summary?.complete ? orderValue(summary.total) : "缺失"}。`
      : `订单数据待采集；默认窗口 ${orderWindow.startMonth} — ${orderWindow.endMonth}。` });
    const orderRows = new Map(summary?.rows.map(row => [row.asin, row]));
    const childRows = group.children.map(child => {
      const row = orderRows.get(child.asin);
      const attrs = child.attributes.map(attribute => `${attribute.dimension}: ${xydcVariantAttributeLabel(attribute)}（原值 ${attribute.value}${attribute.labelZh ? `；译名 ${attribute.labelZh}` : ""}）`).join("\n") || "属性待补充";
      return [child.asin, attrs, child.title, child.price === null ? "—" : `${child.currency ?? ""} ${child.price.toFixed(2)}`.trim(), child.stars, child.productPageRatings, child.listingDate ?? "未提供", child.infoStatus,
        row ? orderValue(row.total) : "缺失", row?.share === null || row?.share === undefined ? "—" : `${row.share.toFixed(2)}%`, row?.missingMonths.join("、") || "—", row?.undisclosedMonths ?? "—"];
    });
    blocks.push(table(`${title} · 全部子体与年度份额`, ["子体 ASIN", "属性 / 原值 / 译名", "标题", "售价", "评分", "评分人数", "上架时间", "信息状态", "12个月订单", "年度份额", "缺失月份", "未披露月数"], childRows));
    blocks.push({ kind: "table", title: `${title} · 子体图片与链接`, columns: ["子体 ASIN", "图片"], rows: group.children.map(child => [
      { text: child.asin, ...(domain ? { href: `https://www.${domain}/dp/${child.asin}` } : {}) },
      { text: child.title ?? child.asin, ...(child.imageUrl ? { imageUrl: child.imageUrl } : {}) },
    ]) });
    const monthRows = orderWindow.months.map(month => [month, ...group.children.map(child => {
      const value = summary?.months.find(item => item.date === month)?.values.find(item => item.asin === child.asin)?.orders ?? null;
      return orderValue(value);
    }), summary ? orderValue(summary.months.find(item => item.date === month)?.total ?? null) : "缺失"]);
    blocks.push(table(`${title} · 逐月全部子体订单`, ["月份", ...group.children.map(child => child.asin), "整组披露量"], monthRows));
    const monthlyShares = orderWindow.months.map(month => {
      const values = summary?.months.find(item => item.date === month)?.values ?? [];
      const byAsin = new Map(values.map(value => [value.asin, value.orders]));
      const disclosedTotal = values.reduce((sum, value) => sum + (value.orders ?? 0), 0);
      return [month, ...group.children.map(child => {
        const orders = byAsin.get(child.asin) ?? null;
        return orders === null ? "缺失" : orders === 0 ? "未披露" : disclosedTotal > 0 ? `${(orders / disclosedTotal * 100).toFixed(2)}%` : "—";
      })];
    });
    blocks.push(table(`${title} · 逐月子体披露订单占比`, ["月份", ...group.children.map(child => child.asin)], monthlyShares));
    blocks.push({ kind: "text", text: "趋势线颜色沿用页面变体颜色识别；多色变体在线图中取首色，未识别颜色使用中性灰。颜色仅作示意，属性原值以子体明细为准。" });
    blocks.push({ kind: "chart", title: `${title} · 12个月子体订单趋势（0 为未披露，空缺为未取得）`, labels: orderWindow.months,
      series: group.children.map(child => ({ label: `${child.asin} · ${child.attributes.map(xydcVariantAttributeLabel).join(" · ") || "属性待补充"}`,
        color: resolveVariantColor(child.attributes).colors[0] ?? (resolveVariantColor(child.attributes).kind === "transparent" ? "#dbe1e8" : "#e2e8f0"),
        values: orderWindow.months.map(month => summary?.months.find(item => item.date === month)?.values.find(item => item.asin === child.asin)?.orders ?? null) })) });
  }
  return { id: "variants-orders", title: "变体 / 订单", status: groups.length ? "ready" : "missing", blocks };
}
