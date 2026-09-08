"use client";

import * as React from "react";

import type { XydcOrderSnapshot, XydcOrderWindow } from "../shared/xydc-order-contract";
import { getXydcOrderWindow, matchesXydcOrderSnapshot } from "../shared/xydc-order-summary";
import type { XydcVariantFamily } from "../shared/xydc-variant-contract";
import { XydcOrderCard, type XydcOrderCardModel } from "./xydc-order-card";
import { XydcOrderDetail } from "./xydc-order-detail";

export type XydcVariantProduct = Readonly<{ asin: string; brand: string; title: string; image: string }>;
export type XydcVariantMarket = Readonly<{ label: string; domain: string }>;

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

type ChildCandidate = Readonly<{ child: XydcVariantFamily["children"][number]; family: XydcVariantFamily }>;

function timeValue(value: string | null) {
  return value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
}

function compareFamilies(left: XydcVariantFamily, right: XydcVariantFamily) {
  const sourceDifference = timeValue(right.sourceUpdatedAt) - timeValue(left.sourceUpdatedAt);
  if (sourceDifference) return sourceDifference;
  const fetchedDifference = timeValue(right.fetchedAt) - timeValue(left.fetchedAt);
  if (fetchedDifference) return fetchedDifference;
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
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
  const status = allUnavailable ? "unavailable" : families.some(family => family.status !== "ready") ? "partial" : "ready";
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

type XydcVariantSectionProps = {
  products: readonly XydcVariantProduct[];
  families: readonly XydcVariantFamily[];
  orderFamilies?: readonly XydcOrderSnapshot[];
  market: XydcVariantMarket;
};

function familyIdentity(group: XydcVariantFamilyGroup): XydcVariantFamily {
  return {
    inputAsin: group.inputAsins[0] ?? group.parentAsin,
    country: group.country,
    parentAsin: group.parentAsin,
    dimensions: group.dimensions,
    children: group.children,
    sourceUpdatedAt: group.sourceUpdatedAt,
    fetchedAt: group.fetchedAt,
    status: group.status,
    reasonCode: group.reasonCode,
    cacheState: group.cacheState,
  };
}

function resolveOrderSnapshot(group: XydcVariantFamilyGroup, snapshots: readonly XydcOrderSnapshot[], window: XydcOrderWindow) {
  return snapshots.find(snapshot => matchesXydcOrderSnapshot(snapshot, familyIdentity(group), window)) ?? null;
}

function buildModels(props: XydcVariantSectionProps) {
  const productByAsin = new Map(props.products.map((product, index) => [product.asin, { product, index }]));
  const window = getXydcOrderWindow(new Date());
  return groupXydcVariantFamilies(props.families).map(group => {
    const familyInputOrder = new Map(group.inputAsins.map((asin, index) => [asin, index]));
    const orderedInputs = [...group.inputAsins].sort((left, right) =>
      (productByAsin.get(left)?.index ?? Number.POSITIVE_INFINITY) - (productByAsin.get(right)?.index ?? Number.POSITIVE_INFINITY)
        || (familyInputOrder.get(left) ?? Number.POSITIVE_INFINITY) - (familyInputOrder.get(right) ?? Number.POSITIVE_INFINITY),
    );
    const productEntry = orderedInputs.map(asin => productByAsin.get(asin)).find(Boolean);
    return {
      group: { ...group, inputAsins: orderedInputs },
      product: productEntry?.product,
      competitorNumber: productEntry ? productEntry.index + 1 : null,
      snapshot: resolveOrderSnapshot(group, props.orderFamilies ?? [], window),
      window,
    } satisfies XydcOrderCardModel;
  }).sort((left, right) =>
    (left.competitorNumber ?? Number.POSITIVE_INFINITY) - (right.competitorNumber ?? Number.POSITIVE_INFINITY)
      || `${left.group.country}:${left.group.parentAsin}`.localeCompare(`${right.group.country}:${right.group.parentAsin}`),
  );
}

function XydcVariantSectionBody({
  props,
  models,
  onOpen,
}: {
  props: XydcVariantSectionProps;
  models: readonly XydcOrderCardModel[];
  onOpen?: (model: XydcOrderCardModel, trigger: HTMLButtonElement) => void;
}) {
  const window = models[0]?.window ?? getXydcOrderWindow(new Date());
  return (
    <section className="card variant-section xydc-variant-section">
      <div className="section-head xydc-order-section-head">
        <div>
          <h3>父体订单量份额与12个月趋势</h3>
          <p>近12个完整月 · {window.startMonth} — {window.endMonth}</p>
        </div>
        <span className="xydc-order-source-badge">西柚洞察 · 子体汇总</span>
      </div>
      <p className="xydc-order-scope-note">按当前变体关系汇总全部子体；总量、份额与排序使用同一12个月窗口。</p>
      {models.length === 0 ? <p className="xydc-order-section-empty">暂无已授权范围内的西柚变体缓存。</p> : (
        <div className="xydc-order-grid">
          {models.map(model => <XydcOrderCard
            key={`${model.group.country}:${model.group.parentAsin}`}
            model={model}
            market={props.market}
            onOpen={onOpen ? trigger => onOpen(model, trigger) : undefined}
          />)}
        </div>
      )}
    </section>
  );
}

function InteractiveXydcVariantSection(props: XydcVariantSectionProps) {
  const { families, market, orderFamilies, products } = props;
  const models = React.useMemo(() => buildModels({ families, market, orderFamilies, products }), [families, market, orderFamilies, products]);
  const [selectedModel, setSelectedModel] = React.useState<XydcOrderCardModel | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const openedModel = selectedModel && models.includes(selectedModel) ? selectedModel : null;
  const close = React.useCallback(() => {
    setSelectedModel(null);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);
  const open = React.useCallback((model: XydcOrderCardModel, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setSelectedModel(model);
  }, []);
  return <>
    <XydcVariantSectionBody props={props} models={models} onOpen={open} />
    {openedModel ? <XydcOrderDetail model={openedModel} market={props.market} onClose={close} /> : null}
  </>;
}

export function XydcVariantSection(props: XydcVariantSectionProps) {
  if (typeof window === "undefined") return <XydcVariantSectionBody props={props} models={buildModels(props)} />;
  return <InteractiveXydcVariantSection {...props} />;
}
