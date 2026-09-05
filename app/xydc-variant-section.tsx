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
  fetchedAt: string;
  status: XydcVariantFamily["status"];
  reasonCode: XydcVariantFamily["reasonCode"];
  cacheState: XydcVariantFamily["cacheState"];
}>;

type ChildCandidate = Readonly<{
  child: XydcVariantFamily["children"][number];
  family: XydcVariantFamily;
}>;

const imagePlaceholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%23f2f6fa'/%3E%3Cpath d='M16 44l10-11 8 7 7-9 7 13z' fill='%239aabba'/%3E%3Ccircle cx='25' cy='23' r='5' fill='%239aabba'/%3E%3C/svg%3E";

function timeValue(value: string | null) {
  return value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
}

function stableFamilyKey(family: XydcVariantFamily) {
  return JSON.stringify(family);
}

function compareFamilies(left: XydcVariantFamily, right: XydcVariantFamily) {
  const sourceDifference = timeValue(right.sourceUpdatedAt) - timeValue(left.sourceUpdatedAt);
  if (sourceDifference) return sourceDifference;
  const fetchedDifference = timeValue(right.fetchedAt) - timeValue(left.fetchedAt);
  if (fetchedDifference) return fetchedDifference;
  return stableFamilyKey(left).localeCompare(stableFamilyKey(right));
}

function childInfoRank(status: XydcVariantFamily["children"][number]["infoStatus"]) {
  return status === "ready" ? 2 : status === "pending" ? 1 : 0;
}

function compareChildCandidates(left: ChildCandidate, right: ChildCandidate) {
  const statusDifference = childInfoRank(left.child.infoStatus) - childInfoRank(right.child.infoStatus);
  if (statusDifference) return statusDifference;
  const familyDifference = compareFamilies(left.family, right.family);
  if (familyDifference) return -familyDifference;
  return JSON.stringify(right.child).localeCompare(JSON.stringify(left.child));
}

function mergeVariantFamilyGroup(families: readonly XydcVariantFamily[]): XydcVariantFamilyGroup {
  const orderedFamilies = [...families].sort(compareFamilies);
  const childByAsin = new Map<string, ChildCandidate>();
  for (const family of orderedFamilies) {
    for (const child of family.children) {
      const candidate = { child, family };
      const current = childByAsin.get(child.asin);
      if (!current || compareChildCandidates(candidate, current) > 0) childByAsin.set(child.asin, candidate);
    }
  }
  const inputAsins = [...new Set(orderedFamilies.map(family => family.inputAsin))].sort();
  const dimensions = [...new Set(orderedFamilies.flatMap(family => family.dimensions))].sort();
  const children = [...childByAsin.values()].map(candidate => candidate.child).sort((left, right) => left.asin.localeCompare(right.asin));
  const allUnavailable = families.every(family => family.status === "unavailable");
  const status = allUnavailable ? "unavailable" : families.some(family => family.status === "partial") || families.some(family => family.status === "unavailable")
    ? "partial"
    : "ready";
  const unavailable = orderedFamilies.find(family => family.status === "unavailable");
  const partial = orderedFamilies.find(family => family.status === "partial");
  const stale = orderedFamilies.find(family => family.cacheState === "stale");
  const metadataFamily = stale ?? orderedFamilies[0]!;

  return {
    country: orderedFamilies[0]!.country,
    parentAsin: orderedFamilies[0]!.parentAsin,
    inputAsins,
    dimensions,
    children,
    sourceUpdatedAt: metadataFamily.sourceUpdatedAt,
    fetchedAt: metadataFamily.fetchedAt,
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
  return [...groups.values()].map(mergeVariantFamilyGroup).sort((left, right) =>
    `${left.country}:${left.parentAsin}`.localeCompare(`${right.country}:${right.parentAsin}`),
  );
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

function imageSource(...sources: Array<string | null | undefined>) {
  return sources.find(source => source?.trim()) ?? imagePlaceholder;
}

function VariantChildCard({
  child,
  updatedAt,
}: {
  child: XydcVariantFamily["children"][number];
  updatedAt?: string | null;
}) {
  const childImage = child.imageUrl?.trim();
  return (
    <article className="xydc-variant-child-card">
      <div className="xydc-variant-child-heading">
        {/* Product images come from the cached provider payload, not Next-managed local assets. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="xydc-variant-child-image" src={childImage ?? imagePlaceholder} alt={childImage ? `${child.asin} 主图` : `${child.asin} 主图数据源未提供`} />
        <div className="xydc-variant-child-identity">
          <b>{attributeLabel(child)}</b>
          <small className="xydc-variant-child-asin">{child.asin}</small>
        </div>
      </div>
      {!childImage ? <span className="xydc-variant-child-image-unavailable">主图：数据源未提供</span> : null}
      <span>价格：<strong>{formatPrice(child)}</strong></span>
      <span>评分：{child.stars === null ? "暂无数据" : child.stars.toFixed(1)}</span>
      <span>商品页当前评论数：{displayNumber(child.productPageRatings)}</span>
      {updatedAt !== undefined ? <span>更新时间：{updatedAt ?? "数据源未提供"}</span> : null}
      {updatedAt !== undefined ? <span>上架时间：数据源未提供</span> : null}
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
          {children.map(child => <VariantChildCard child={child} updatedAt={group.sourceUpdatedAt ?? group.fetchedAt} key={child.asin} />)}
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
          <p>西柚洞察 MCP · {market.label} · 子体最多预览 3 个</p>
        </div>
      </div>
      <p className="xydc-variant-review-note">同一商品页的评论数为页面当前口径，不代表每个子体自身的单独沉淀。</p>
      {groups.length === 0 ? <p className="xydc-variant-empty">暂无已授权范围内的西柚变体缓存。</p> : (
        <div className="xydc-variant-rows">
          {groups.map(group => {
            const product = group.inputAsins.map(asin => productByAsin.get(asin)).find(Boolean);
            const competitorNumber = product ? [...productByAsin.keys()].indexOf(product.asin) + 1 : null;
            const parentImage = imageSource(product?.image, ...group.children.map(child => child.imageUrl));
            const groupKey = `${group.country}:${group.parentAsin}`;
            return (
              <article className="xydc-variant-row" key={groupKey}>
                <div className="xydc-variant-summary">
                  <div className="xydc-variant-parent-product">
                    {/* Product images come from the cached provider payload, not Next-managed local assets. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className="xydc-variant-parent-image" src={parentImage} alt={`${product?.title ?? group.parentAsin} 主图`} />
                    <div>
                      <span>{competitorNumber ? `竞品 ${competitorNumber} · ` : ""}父体 {group.parentAsin}</span>
                      <b>{product?.brand ?? "未匹配竞品"}</b>
                      <small>{product?.title ?? "当前输入 ASIN 的变体缓存"}</small>
                    </div>
                  </div>
                  <div className="xydc-variant-input-asins">命中 ASIN：{group.inputAsins.map(asin => <code key={asin}>{asin}</code>)}</div>
                  <strong className="xydc-variant-child-count">子体总数：{group.children.length}</strong>
                  <div className="xydc-variant-dimensions">
                    {group.dimensions.map(dimension => <span key={dimension}>{dimension}</span>)}
                  </div>
                  {group.children.length <= 1 && group.status !== "unavailable" ? <em>单一商品/未发现其他变体</em> : null}
                  {group.cacheState === "stale" ? <em>{group.sourceUpdatedAt
                    ? `缓存数据 · 来源更新时间：${group.sourceUpdatedAt}`
                    : `缓存数据 · 来源更新时间未提供 · 缓存抓取时间：${group.fetchedAt}`}</em> : null}
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
                      {group.children.length > 3 ? <button type="button" className="xydc-variant-open-drawer" onClick={() => onOpen?.(group)}>查看全部 {group.children.length} 个子体</button> : null}
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
