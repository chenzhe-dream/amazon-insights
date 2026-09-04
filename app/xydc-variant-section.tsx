"use client";

import * as React from "react";
import * as ReactDom from "react-dom";

import type { XydcVariantFamily } from "../shared/xydc-variant-contract";

type XydcVariantProduct = Readonly<{
  asin: string;
  brand: string;
  title: string;
  image: string;
}>;

type XydcVariantMarket = Readonly<{
  label: string;
  domain: string;
}>;

type DrawerSort = "ratings" | "price" | "stars";

export type XydcVariantFamilyGroup = Readonly<{
  country: string;
  parentAsin: string;
  inputAsins: string[];
  dimensions: string[];
  children: XydcVariantFamily["children"];
  sourceUpdatedAt: string | null;
  staleFetchedAt: string | null;
  status: XydcVariantFamily["status"];
  reasonCode: XydcVariantFamily["reasonCode"];
  cacheState: XydcVariantFamily["cacheState"];
}>;

function mergeVariantFamilyGroup(families: readonly XydcVariantFamily[]): XydcVariantFamilyGroup {
  const childByAsin = new Map<string, XydcVariantFamily["children"][number]>();
  for (const family of families) {
    for (const child of family.children) childByAsin.set(child.asin, child);
  }
  const inputAsins = [...new Set(families.map(family => family.inputAsin))];
  const dimensions = [...new Set(families.flatMap(family => family.dimensions))];
  const children = [...childByAsin.values()];
  const allUnavailable = families.every(family => family.status === "unavailable");
  const status = allUnavailable ? "unavailable" : families.some(family => family.status === "partial") || families.some(family => family.status === "unavailable")
    ? "partial"
    : "ready";
  const unavailable = families.find(family => family.status === "unavailable");
  const partial = families.find(family => family.status === "partial");
  const stale = families.find(family => family.cacheState === "stale");

  return {
    country: families[0]!.country,
    parentAsin: families[0]!.parentAsin,
    inputAsins,
    dimensions,
    children,
    sourceUpdatedAt: stale ? stale.sourceUpdatedAt : families.map(family => family.sourceUpdatedAt).find((value): value is string => value !== null) ?? null,
    staleFetchedAt: stale?.fetchedAt ?? null,
    status,
    reasonCode: (status === "unavailable" ? unavailable : partial ?? unavailable)?.reasonCode ?? null,
    cacheState: families.some(family => family.cacheState === "stale") ? "stale" : "fresh",
  };
}

export function groupXydcVariantFamilies(families: readonly XydcVariantFamily[]) {
  const groups = new Map<string, XydcVariantFamily[]>();
  for (const family of families) {
    const key = `${family.country}:${family.parentAsin}`;
    groups.set(key, [...(groups.get(key) ?? []), family]);
  }
  return [...groups.values()].map(mergeVariantFamilyGroup);
}

function attributeLabel(child: XydcVariantFamily["children"][number]) {
  return child.attributes.length
    ? child.attributes.map(attribute => `${attribute.dimension}：${attribute.value}`).join(" · ")
    : "属性待补充";
}

function displayNumber(value: number | null, fallback = "暂无数据") {
  return value === null ? fallback : value.toLocaleString();
}

function formatPrice(child: XydcVariantFamily["children"][number]) {
  return child.price === null ? "暂无数据" : `${child.currency ?? ""} ${child.price.toFixed(2)}`.trim();
}

function reasonLabel(reasonCode: XydcVariantFamily["reasonCode"]) {
  return reasonCode ?? "未返回具体原因";
}

function sortChildren(children: readonly XydcVariantFamily["children"][number][], sort: DrawerSort) {
  const value = (child: XydcVariantFamily["children"][number]) => {
    if (sort === "price") return child.price ?? -1;
    if (sort === "stars") return child.stars ?? -1;
    return child.productPageRatings ?? -1;
  };
  return [...children].sort((left, right) => value(right) - value(left) || left.asin.localeCompare(right.asin));
}

function VariantChildCard({ child }: { child: XydcVariantFamily["children"][number] }) {
  return (
    <article className="xydc-variant-child-card">
      <b>{attributeLabel(child)}</b>
      <small className="xydc-variant-child-asin">{child.asin}</small>
      <span>价格：{formatPrice(child)}</span>
      <span>评分：{child.stars === null ? "暂无数据" : child.stars.toFixed(1)}</span>
      <span>商品页当前评论数：{displayNumber(child.productPageRatings)}</span>
      {child.infoStatus !== "ready" ? <em>子体信息：{child.infoStatus}</em> : null}
    </article>
  );
}

function VariantDrawer({ group, onClose }: { group: XydcVariantFamilyGroup; onClose: () => void }) {
  const [sort, setSort] = React.useState<DrawerSort>("ratings");
  const children = React.useMemo(() => sortChildren(group.children, sort), [group.children, sort]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const content = (
    <div className="xydc-variant-drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        className="xydc-variant-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${group.parentAsin} 全部变体`}
        onMouseDown={event => event.stopPropagation()}
      >
        <header>
          <div>
            <span>变体明细</span>
            <h4>父体 {group.parentAsin}</h4>
          </div>
          <button type="button" aria-label="关闭变体明细" onClick={onClose}>关闭</button>
        </header>
        <label className="xydc-variant-drawer-sort">排序
          <select aria-label="抽屉排序" value={sort} onChange={event => setSort(event.target.value as DrawerSort)}>
            <option value="ratings">商品页评论数</option>
            <option value="price">价格</option>
            <option value="stars">评分</option>
          </select>
        </label>
        <div className="xydc-variant-drawer-children">
          {children.map(child => <VariantChildCard child={child} key={child.asin} />)}
        </div>
      </aside>
    </div>
  );

  return typeof document === "undefined" ? null : ReactDom.createPortal(content, document.body);
}

type XydcVariantSectionProps = {
  products: readonly XydcVariantProduct[];
  families: readonly XydcVariantFamily[];
  market: XydcVariantMarket;
};

function XydcVariantSectionBody({
  market,
  groups,
  productByAsin,
  onOpen,
}: Omit<XydcVariantSectionProps, "products" | "families"> & {
  groups: readonly XydcVariantFamilyGroup[];
  productByAsin: ReadonlyMap<string, XydcVariantProduct>;
  onOpen?: (group: XydcVariantFamilyGroup) => void;
}) {
  return (
    <section className="card variant-section xydc-variant-section">
      <div className="section-head">
        <div>
          <h3>变体结构与商品页表现</h3>
          <p>西柚缓存 · {market.label} · 子体最多预览 3 个</p>
        </div>
      </div>
      <p className="xydc-variant-review-note">同一商品页的评论数为页面当前口径，不代表每个子体自身的单独沉淀。</p>
      {groups.length === 0 ? <p className="xydc-variant-empty">暂无已授权范围内的西柚变体缓存。</p> : (
        <div className="xydc-variant-rows">
          {groups.map(group => {
            const product = group.inputAsins.map(asin => productByAsin.get(asin)).find(Boolean);
            const groupKey = `${group.country}:${group.parentAsin}`;
            return (
              <article className="xydc-variant-row" key={groupKey}>
                <div className="xydc-variant-summary">
                  <span>父体 {group.parentAsin}</span>
                  <b>{product?.brand ?? "未匹配竞品"}</b>
                  <small>{product?.title ?? "当前输入 ASIN 的变体缓存"}</small>
                  <div className="xydc-variant-input-asins">命中 ASIN：{group.inputAsins.map(asin => <code key={asin}>{asin}</code>)}</div>
                  {group.children.length <= 1 && group.status !== "unavailable" ? <em>单一商品/未发现其他变体</em> : null}
                  {group.cacheState === "stale" ? <em>{group.sourceUpdatedAt
                    ? `缓存数据 · 来源更新时间：${group.sourceUpdatedAt}`
                    : `缓存数据 · 来源更新时间未提供 · 缓存抓取时间：${group.staleFetchedAt}`}</em> : null}
                </div>
                <div className="xydc-variant-dimensions">
                  {group.dimensions.map(dimension => <span key={dimension}>{dimension}</span>)}
                </div>
                <div className="xydc-variant-content">
                  {group.status === "unavailable" ? (
                    <p className="xydc-variant-unavailable">变体数据不可用：{reasonLabel(group.reasonCode)}</p>
                  ) : (
                    <div className="xydc-variant-children-wrap">
                      <div className="xydc-variant-children">
                        {group.children.slice(0, 3).map(child => <VariantChildCard child={child} key={child.asin} />)}
                      </div>
                      {group.status === "partial" ? <p className="xydc-variant-partial">部分子体信息可用；缺口：{reasonLabel(group.reasonCode)}</p> : null}
                      {group.children.length > 3 ? <button type="button" className="xydc-variant-open-drawer" onClick={() => onOpen?.(group)}>查看全部 {group.children.length}</button> : null}
                    </div>
                  )}
                  <p className="xydc-variant-listing-date">上架时间：数据源未提供</p>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function InteractiveXydcVariantSection(props: XydcVariantSectionProps) {
  const groups = React.useMemo(() => groupXydcVariantFamilies(props.families), [props.families]);
  const productByAsin = React.useMemo(() => new Map(props.products.map(product => [product.asin, product])), [props.products]);
  const [openedGroup, setOpenedGroup] = React.useState<XydcVariantFamilyGroup | null>(null);

  return <>
    <XydcVariantSectionBody market={props.market} groups={groups} productByAsin={productByAsin} onOpen={setOpenedGroup} />
    {openedGroup ? <VariantDrawer group={openedGroup} onClose={() => setOpenedGroup(null)} /> : null}
  </>;
}

export function XydcVariantSection(props: XydcVariantSectionProps) {
  if (typeof window === "undefined") {
    return <XydcVariantSectionBody
      market={props.market}
      groups={groupXydcVariantFamilies(props.families)}
      productByAsin={new Map(props.products.map(product => [product.asin, product]))}
    />;
  }
  return <InteractiveXydcVariantSection {...props} />;
}
