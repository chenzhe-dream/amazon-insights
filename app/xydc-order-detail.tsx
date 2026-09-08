"use client";

import * as React from "react";
import * as ReactDom from "react-dom";

import { summarizeXydcOrders } from "../shared/xydc-order-summary";
import {
  formatOrderCount,
  formatOrderShare,
  orderAttributeLabel,
  orderColorMap,
  orderHref,
  type XydcOrderCardModel,
} from "./xydc-order-card";
import type { XydcVariantMarket } from "./xydc-variant-section";

type DetailSort = "orders" | "asin";

function focusableElements(element: HTMLElement) {
  return [...element.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(candidate => !candidate.hasAttribute("hidden"));
}

function monthDisclosedTotal(snapshot: NonNullable<XydcOrderCardModel["snapshot"]>, month: string) {
  return snapshot.children.reduce((sum, child) => sum + (child.trends.find(trend => trend.date === month)?.orders ?? 0), 0);
}

export function XydcOrderDetail({
  model,
  market,
  onClose,
}: {
  model: XydcOrderCardModel;
  market: XydcVariantMarket;
  onClose: () => void;
}) {
  const { group, product, snapshot } = model;
  const summary = React.useMemo(() => snapshot ? summarizeXydcOrders(snapshot) : null, [snapshot]);
  const childByAsin = React.useMemo(() => new Map(group.children.map(child => [child.asin, child])), [group.children]);
  const childAsins = snapshot?.childAsins ?? group.children.map(child => child.asin);
  const colors = React.useMemo(() => orderColorMap(childAsins), [childAsins]);
  const [sort, setSort] = React.useState<DetailSort>("orders");
  const dialogRef = React.useRef<HTMLElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const orderWindow = snapshot?.window ?? model.window;
  const maximum = Math.max(1, ...orderWindow.months.map(month => snapshot ? monthDisclosedTotal(snapshot, month) : 0));
  const rows = [...(summary?.rows ?? group.children.map(child => ({
    asin: child.asin,
    complete: false,
    total: null,
    share: null,
    missingMonths: orderWindow.months,
    undisclosedMonths: 0,
  })))].sort((left, right) => sort === "asin"
    ? left.asin.localeCompare(right.asin)
    : (right.total ?? -1) - (left.total ?? -1) || left.asin.localeCompare(right.asin));

  React.useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = focusableElements(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const content = (
    <div className="xydc-order-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="xydc-order-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="xydc-order-dialog-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header>
          <div>
            <span>全部子体与12个月趋势</span>
            <h4 id="xydc-order-dialog-title">{product?.brand || "父体"} · {group.parentAsin}</h4>
            <small>{orderWindow.startMonth} — {orderWindow.endMonth}</small>
            <strong className="xydc-order-dialog-total">12个月订单量：{formatOrderCount(summary?.total ?? null, summary?.complete ?? false)}</strong>
          </div>
          <button ref={closeRef} type="button" aria-label="关闭订单明细" onClick={onClose}>关闭</button>
        </header>

        <p className="xydc-order-chart-description" id="xydc-order-chart-description">
          堆叠柱状图按月展示全部 {summary?.expectedChildren ?? group.children.length} 个子体的已披露订单；缺失月份保留为空缺，原始零值标记为未披露。
        </p>
        <div className="xydc-order-chart" role="img" aria-describedby="xydc-order-chart-description">
          {orderWindow.months.map(month => {
            const values = summary?.months.find(item => item.date === month)?.values
              ?? childAsins.map(asin => ({ asin, orders: null }));
            const monthTotal = snapshot ? monthDisclosedTotal(snapshot, month) : 0;
            return <div className="xydc-order-month" data-order-month={month} key={month}>
              <div className="xydc-order-month-bar" style={{ height: `${Math.max(4, monthTotal / maximum * 100)}%` }}>
                {values.map(value => {
                  const height = value.orders && monthTotal > 0 ? value.orders / monthTotal * 100 : 0;
                  return value.orders === null ? <span className="xydc-order-month-gap" key={value.asin} aria-label={`${month} ${value.asin} 缺失`} /> : (
                    <span
                      key={value.asin}
                      data-order-asin={value.asin}
                      data-order-color={colors.get(value.asin)}
                      className={value.orders === 0 ? "xydc-order-month-undisclosed" : ""}
                      style={{ height: `${height}%`, background: colors.get(value.asin) }}
                      aria-label={`${month} ${value.asin} ${value.orders === 0 ? "未披露" : `${value.orders} 单`}`}
                      title={`${month} · ${orderAttributeLabel(childByAsin.get(value.asin))} · ${value.orders === 0 ? "未披露" : `${value.orders.toLocaleString("en-US")}+`}`}
                    />
                  );
                })}
              </div>
              <small>{month.slice(2)}</small>
            </div>;
          })}
        </div>
        <div className="xydc-order-dialog-legend">
          {childAsins.map(asin => <span key={asin} data-order-asin={asin} data-order-color={colors.get(asin)}><i style={{ background: colors.get(asin) }} />{orderAttributeLabel(childByAsin.get(asin))}</span>)}
        </div>

        <div className="xydc-order-detail-headline">
          <b>全部子体 · 年度份额</b>
          <label>排序
            <select aria-label="订单明细排序" value={sort} onChange={event => setSort(event.target.value as DetailSort)}>
              <option value="orders">12个月订单量</option>
              <option value="asin">ASIN</option>
            </select>
          </label>
        </div>
        <div className="xydc-order-detail-table-wrap" role="region" aria-label={`${group.parentAsin} 全部子体年度订单`} tabIndex={0}>
          <table className="xydc-order-detail-table">
            <thead><tr><th>变体 / ASIN</th><th>12个月订单量</th><th>年度份额</th><th>缺失 / 未披露月份</th></tr></thead>
            <tbody>{rows.map(row => <tr key={row.asin} data-order-asin={row.asin} data-order-color={colors.get(row.asin)}>
              <th scope="row"><span><i style={{ background: colors.get(row.asin) }} />{orderAttributeLabel(childByAsin.get(row.asin))}</span><a href={orderHref(market.domain, row.asin)} target="_blank" rel="noopener noreferrer">{row.asin}<span aria-hidden="true">↗</span></a></th>
              <td>{formatOrderCount(row.total, row.complete)}</td>
              <td>{formatOrderShare(row.share)}</td>
              <td>{row.missingMonths.length} / {row.undisclosedMonths}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <footer>来源：西柚洞察 · 子体汇总{snapshot ? ` · 本次采集时间：${snapshot.fetchedAt}` : " · 订单数据待采集"}</footer>
      </section>
    </div>
  );

  return typeof document === "undefined" ? null : ReactDom.createPortal(content, document.body);
}
