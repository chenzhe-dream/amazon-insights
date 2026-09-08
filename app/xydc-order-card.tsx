import type { XydcOrderSnapshot, XydcOrderSummary, XydcOrderWindow } from "../shared/xydc-order-contract";
import { summarizeXydcOrders } from "../shared/xydc-order-summary";
import type { XydcVariantFamilyGroup, XydcVariantMarket, XydcVariantProduct } from "./xydc-variant-section";

const imagePlaceholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect width='72' height='72' fill='%23f2f6fa'/%3E%3Cpath d='M17 50l12-13 9 8 8-10 10 15z' fill='%239aabba'/%3E%3Ccircle cx='28' cy='26' r='6' fill='%239aabba'/%3E%3C/svg%3E";
const orderColors = ["#10a5a5", "#1769d3", "#f0a000", "#8756d8", "#e85d75", "#2b8a3e", "#52677f", "#d96c1f"];

const orderReasonLabels = {
  NOT_CONFIGURED: "西柚订单数据源未配置",
  AUTH_FAILED: "西柚订单数据源认证失败",
  QUOTA_EXCEEDED: "西柚订单额度已用尽",
  RATE_LIMITED: "西柚订单请求受限",
  TIMEOUT: "西柚订单请求超时",
  CANCELLED: "西柚订单采集已取消",
  BUDGET_EXHAUSTED: "西柚订单采集超出时间预算",
  RPC_ERROR: "西柚订单服务暂不可用",
  SCHEMA_INVALID: "西柚订单数据格式异常",
  NOT_FOUND: "西柚未返回该子体订单",
  PARTIAL_DATA: "部分订单数据不可用",
} satisfies Record<NonNullable<XydcOrderSnapshot["reasonCode"]>, string>;

const variantReasonLabels = {
  NOT_CONFIGURED: "西柚数据源未配置",
  AUTH_FAILED: "西柚数据源认证失败",
  TIMEOUT: "西柚请求超时",
  RPC_ERROR: "西柚服务暂不可用",
  SCHEMA_INVALID: "数据源返回格式异常",
  NOT_FOUND: "数据源未返回该商品变体",
  PARTIAL_CHILD_INFO: "部分子体详情暂未返回",
} satisfies Record<NonNullable<XydcVariantFamilyGroup["reasonCode"]>, string>;

export function orderColorMap(asins: readonly string[]) {
  return new Map([...new Set(asins)].sort().map((asin, index) => [asin, orderColors[index % orderColors.length]!]));
}

export function orderAttributeLabel(child: XydcVariantFamilyGroup["children"][number] | undefined) {
  return child?.attributes.length
    ? child.attributes.map(attribute => attribute.value).join(" · ")
    : "属性待补充";
}

export function orderHref(domain: string, asin: string) {
  return `https://${domain}/dp/${asin}`;
}

export function formatOrderCount(value: number | null, complete: boolean) {
  if (!complete || value === null) return "—";
  if (value === 0) return "未披露";
  return `${value.toLocaleString("en-US")}+`;
}

export function formatOrderShare(value: number | null) {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

function formatPrice(child: XydcVariantFamilyGroup["children"][number] | undefined) {
  if (!child || child.price === null) return "—";
  return `${child.currency ?? ""} ${child.price.toFixed(2)}`.trim();
}

function formatListingDate(child: XydcVariantFamilyGroup["children"][number] | undefined) {
  return child?.listingDate ?? "未提供";
}

function visibleMonthCount(summary: XydcOrderSummary | null) {
  return summary?.months.filter(month => month.total !== null).length ?? 0;
}

export type XydcOrderCardModel = Readonly<{
  group: XydcVariantFamilyGroup;
  product: XydcVariantProduct | undefined;
  competitorNumber: number | null;
  snapshot: XydcOrderSnapshot | null;
  window: XydcOrderWindow;
}>;

export function XydcOrderCard({
  model,
  market,
  onOpen,
}: {
  model: XydcOrderCardModel;
  market: XydcVariantMarket;
  onOpen?: (trigger: HTMLButtonElement) => void;
}) {
  const { group, product, competitorNumber, snapshot, window } = model;
  const summary = snapshot ? summarizeXydcOrders(snapshot) : null;
  const childByAsin = new Map(group.children.map(child => [child.asin, child]));
  const rows = summary?.rows ?? group.children.map(child => ({
    asin: child.asin,
    complete: false,
    total: null,
    share: null,
    missingMonths: window.months,
    undisclosedMonths: 0,
  }));
  const colors = orderColorMap(group.children.map(child => child.asin));
  const parentImage = product?.image?.trim() || group.children.find(child => child.imageUrl?.trim())?.imageUrl || imagePlaceholder;
  const brand = product && product.brand.trim() && product.brand !== "等待同步" ? product.brand : "品牌资料待补充";
  const title = product && product.title.trim() && product.title !== "等待卖家精灵与 SIF MCP 返回商品数据"
    ? product.title
    : "商品资料待补充，不影响已获取的变体展示";
  const sourceWindow = snapshot?.window ?? window;
  const status = !snapshot ? "pending" : summary?.complete ? "complete" : "partial";
  const allUnreported = summary?.complete && summary.total === 0;

  return (
    <article className={`xydc-order-card xydc-order-card-${status}`} data-parent-asin={group.parentAsin}>
      <header className="xydc-order-card-head">
        {/* Images are read from authorized runtime data and may be remote provider URLs. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="xydc-order-parent-image" src={parentImage} alt={`${title} 主图`} />
        <div className="xydc-order-parent-copy">
          <span>{competitorNumber ? `竞品 ${competitorNumber}` : "未匹配竞品"}</span>
          <b>{brand}</b>
          <small>{title}</small>
          <div className="xydc-order-parent-links">
            父体 <a href={orderHref(market.domain, group.parentAsin)} target="_blank" rel="noopener noreferrer">{group.parentAsin}<span aria-hidden="true">↗</span></a>
            <span>{group.children.length} 个子体</span>
          </div>
        </div>
      </header>
      {group.status !== "ready" ? <p className="xydc-order-variant-note">
        {group.status === "unavailable" ? "变体数据暂不可用" : "部分变体数据可用"}：{group.reasonCode ? variantReasonLabels[group.reasonCode] : "数据源未返回具体原因"}
      </p> : null}

      <div className="xydc-order-metric-row">
        <div>
          <span>12个月已披露订单量汇总</span>
          <strong>{allUnreported ? "—" : formatOrderCount(summary?.total ?? null, summary?.complete ?? false)}</strong>
        </div>
        <div className={`xydc-order-state xydc-order-state-${status}`}>
          <b>{status === "pending" ? "订单数据待采集" : status === "complete" ? "响应覆盖 12/12 月" : "部分订单数据不可用"}</b>
          <span>{summary ? `${summary.returnedChildren}/${summary.expectedChildren} 个子体返回 · ${visibleMonthCount(summary)}/12 月` : `已识别 ${group.children.length} 个子体`}</span>
        </div>
      </div>

      {allUnreported ? <p className="xydc-order-empty-data">暂无可披露订单数据</p> : null}
      {status === "pending" ? (
        <div className="xydc-order-pending" aria-label="订单数据待采集">
          <strong>尚未取得完整12个月订单数据</strong>
          <span>已识别变体关系。月度订单返回后，将按全部子体汇总。</span>
        </div>
      ) : null}

      {summary?.complete && summary.total !== null && summary.total > 0 ? <>
        <div className="xydc-order-share" aria-label="已披露订单量年度份额">
          {summary.rows.filter(row => row.share !== null).map(row => (
            <span
              key={row.asin}
              data-order-asin={row.asin}
              data-order-color={colors.get(row.asin)}
              style={{ width: `${row.share}%`, background: colors.get(row.asin) }}
              title={`${orderAttributeLabel(childByAsin.get(row.asin))} ${formatOrderShare(row.share)}`}
            >{row.share !== null && row.share >= 8 ? formatOrderShare(row.share) : ""}</span>
          ))}
        </div>
        <div className="xydc-order-legend">
          {summary.rows.map(row => <span key={row.asin} data-order-asin={row.asin} data-order-color={colors.get(row.asin)}><i style={{ background: colors.get(row.asin) }} />{orderAttributeLabel(childByAsin.get(row.asin))}</span>)}
        </div>
      </> : null}

      {status !== "pending" ? <div className="xydc-order-table-wrap" role="region" aria-label={`${group.parentAsin} 子体订单预览`} tabIndex={0}>
        <table className="xydc-order-table">
          <thead><tr><th>变体 / ASIN</th><th>12个月订单量 / 年度份额</th><th>当前价格</th><th>上架时间</th></tr></thead>
          <tbody>
            {rows.slice(0, 3).map(row => {
              const child = childByAsin.get(row.asin);
              return <tr key={row.asin} data-order-preview-row={row.asin}>
                <th scope="row"><span><i style={{ background: colors.get(row.asin) }} />{orderAttributeLabel(child)}</span><a href={orderHref(market.domain, row.asin)} target="_blank" rel="noopener noreferrer">{row.asin}<span aria-hidden="true">↗</span></a></th>
                <td><b>{formatOrderCount(row.total, row.complete)}</b><small>{formatOrderShare(row.share)}</small></td>
                <td>{formatPrice(child)}</td>
                <td>{formatListingDate(child)}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div> : null}

      {snapshot?.reasonCode ? <p className="xydc-order-warning">原因：{orderReasonLabels[snapshot.reasonCode]}</p> : null}
      {summary && summary.undisclosedChildMonths > 0 ? <p className="xydc-order-warning">{summary.undisclosedChildMonths} 个子体月份未披露；汇总值不代表精确成交量。</p> : null}
      <button type="button" className="xydc-order-open-detail" onClick={event => onOpen?.(event.currentTarget)}>
        查看全部 {group.children.length} 个子体{snapshot ? "与月度趋势" : ""}
      </button>
      <footer className="xydc-order-meta">
        <span>统计窗口：{sourceWindow.startMonth} — {sourceWindow.endMonth}</span>
        <span>来源：西柚洞察 · 子体汇总</span>
        {snapshot?.cacheState === "stale" ? <em>缓存数据</em> : null}
        {snapshot ? <><span>来源更新时间：{snapshot.sourceUpdatedAt ?? "数据源未提供"}</span><span>本次采集时间：{snapshot.fetchedAt}</span></> : null}
        <span>变体来源更新时间：{group.sourceUpdatedAt ?? "数据源未提供"}</span>
        <span>变体采集时间：{group.fetchedAt}</span>
      </footer>
    </article>
  );
}
