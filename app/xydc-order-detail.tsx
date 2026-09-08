"use client";

import * as React from "react";
import * as ReactDom from "react-dom";

import { summarizeXydcOrders } from "../shared/xydc-order-summary";
import { XydcAnnualInspectionTrigger } from "./xydc-annual-inspection";
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
    .filter(candidate => !candidate.closest('[hidden],[inert],[aria-hidden="true"]'));
}

function monthDisclosedTotal(snapshot: NonNullable<XydcOrderCardModel["snapshot"]>, month: string) {
  return snapshot.children.reduce((sum, child) => sum + (child.trends.find(trend => trend.date === month)?.orders ?? 0), 0);
}

function accessibleMonthlyOrder(orders: number | null) {
  if (orders === null) return "缺失";
  if (orders === 0) return "未披露";
  return `${orders.toLocaleString("en-US")} 单`;
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
  const [expanded, setExpanded] = React.useState(false);
  const dialogRef = React.useRef<HTMLElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const tableRegionId = `xydc-order-annual-table-${React.useId().replaceAll(":", "")}`;
  const orderWindow = snapshot?.window ?? model.window;
  const historical = Boolean(snapshot && orderWindow.endMonth !== model.window.endMonth);
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
        <div className="xydc-order-chart" aria-hidden="true">
          {orderWindow.months.map(month => {
            const values = summary?.months.find(item => item.date === month)?.values
              ?? childAsins.map(asin => ({ asin, orders: null }));
            const monthTotal = snapshot ? monthDisclosedTotal(snapshot, month) : 0;
            return <div className="xydc-order-month" data-order-month={month} key={month}>
              <div className="xydc-order-month-plot">
                {monthTotal > 0 ? <div className="xydc-order-month-bar" style={{ height: `${monthTotal / maximum * 100}%` }}>
                  {values.filter(value => value.orders !== null && value.orders > 0).map(value => {
                    const height = value.orders! / monthTotal * 100;
                    return (
                    <span
                      key={value.asin}
                      data-order-asin={value.asin}
                      data-order-color={colors.get(value.asin)}
                      style={{ height: `${height}%`, background: colors.get(value.asin) }}
                      title={`${month} · ${orderAttributeLabel(childByAsin.get(value.asin))} · ${value.orders!.toLocaleString("en-US")}+`}
                    />
                  );
                  })}
                </div> : null}
              </div>
              <div className="xydc-order-month-markers">
                {values.filter(value => value.orders === null || value.orders === 0).map(value => <span
                  key={value.asin}
                  className={value.orders === null ? "xydc-order-month-gap" : "xydc-order-month-undisclosed"}
                  title={`${month} · ${orderAttributeLabel(childByAsin.get(value.asin))} · ${accessibleMonthlyOrder(value.orders)}`}
                />)}
              </div>
              <small>{month.slice(2)}</small>
            </div>;
          })}
        </div>
        <table className="xydc-order-monthly-a11y xydc-order-visually-hidden">
          <caption>逐月全部子体订单明细</caption>
          <thead><tr><th scope="col">月份</th>{childAsins.map(asin => <th scope="col" key={asin}>{asin}</th>)}</tr></thead>
          <tbody>{orderWindow.months.map(month => {
            const values = summary?.months.find(item => item.date === month)?.values
              ?? childAsins.map(asin => ({ asin, orders: null }));
            const valueByAsin = new Map(values.map(value => [value.asin, value.orders]));
            return <tr key={month}><th scope="row">{month}</th>{childAsins.map(asin => <td key={asin}>{accessibleMonthlyOrder(valueByAsin.get(asin) ?? null)}</td>)}</tr>;
          })}</tbody>
        </table>
        <div className="xydc-order-dialog-legend">
          {childAsins.map(asin => <XydcAnnualInspectionTrigger
            key={asin}
            model={model}
            asin={asin}
            dataOrderColor={colors.get(asin)}
          ><i style={{ background: colors.get(asin) }} />{orderAttributeLabel(childByAsin.get(asin))}</XydcAnnualInspectionTrigger>)}
        </div>

        <div className="xydc-order-detail-headline">
          <b>全部子体 · 年度份额</b>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={tableRegionId}
            onClick={() => setExpanded(value => !value)}
          >{expanded ? "收起年度明细" : "展开年度明细"}</button>
        </div>
        {expanded ? <div id={tableRegionId} className="xydc-order-annual-table-region">
          <label className="xydc-order-detail-sort">排序
            <select aria-label="订单明细排序" value={sort} onChange={event => setSort(event.target.value as DetailSort)}>
              <option value="orders">12个月订单量</option>
              <option value="asin">ASIN</option>
            </select>
          </label>
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
        </div> : null}
        <footer>
          来源：西柚洞察 · 子体汇总{snapshot ? ` · 本次采集时间：${snapshot.fetchedAt}` : " · 订单数据待采集"}
          {historical
            ? <strong>历史缓存 · 当前统计区间待补齐</strong>
            : snapshot?.cacheState === "stale"
              ? <strong>缓存数据 · 待更新</strong>
              : null}
        </footer>
      </section>
    </div>
  );

  return typeof document === "undefined" ? null : ReactDom.createPortal(content, document.body);
}
