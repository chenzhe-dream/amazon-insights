"use client";

import * as React from "react";

import type { XydcOrderSnapshot, XydcOrderWindow } from "../shared/xydc-order-contract";
import { selectXydcOrderDisplaySnapshot } from "../shared/xydc-order-display";
import { getXydcOrderWindow } from "../shared/xydc-order-summary";
import type { XydcVariantFamily } from "../shared/xydc-variant-contract";
import {
  useXydcAnnualInspection,
  XydcAnnualInspectionProvider,
  xydcAnnualInspectionIdentity,
} from "./xydc-annual-inspection";
import { XydcOrderCard, type XydcOrderCardModel } from "./xydc-order-card";
import { XydcOrderDetail } from "./xydc-order-detail";
import { XydcOrderProgress } from "./xydc-order-progress";
import type { XydcOrderProgressView } from "../shared/xydc-order-progress";

export type XydcVariantProduct = Readonly<{ asin: string; brand: string; title: string; image: string }>;
export type XydcVariantMarket = Readonly<{ label: string; domain: string }>;

import { groupXydcVariantFamilies, type XydcVariantFamilyGroup } from "../shared/xydc-variant-group";
export { groupXydcVariantFamilies };
export type { XydcVariantFamilyGroup };

type XydcVariantSectionProps = {
  progress?: XydcOrderProgressView | null;
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

function resolveOrderSnapshot(
  group: XydcVariantFamilyGroup,
  snapshots: readonly XydcOrderSnapshot[],
  window: XydcOrderWindow,
  now: Date,
) {
  return selectXydcOrderDisplaySnapshot(snapshots, familyIdentity(group), window, now);
}

function buildModels(props: XydcVariantSectionProps) {
  const productByAsin = new Map(props.products.map((product, index) => [product.asin, { product, index }]));
  const now = new Date();
  const window = getXydcOrderWindow(now);
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
      snapshot: resolveOrderSnapshot(group, props.orderFamilies ?? [], window, now),
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
  const requested = new Set(props.products.map(product => product.asin));
  const scopedFamilies = props.families.filter(family => requested.has(family.inputAsin));
  const discovered = new Set(scopedFamilies.filter(family => family.children.length > 0 && family.cacheState === "fresh" && family.status !== "unavailable").map(family => family.inputAsin));
  const failedDiscovery = scopedFamilies.filter(family => family.status === "unavailable" && !family.children.length);
  const failedInputs = [...new Map(failedDiscovery.map(family => [family.inputAsin, family])).values()];
  const missing = [...requested].filter(asin => !discovered.has(asin) && !failedInputs.some(family => family.inputAsin === asin));
  return (
    <section className="card variant-section xydc-variant-section">
      <div className="section-head xydc-order-section-head">
        <div>
          <h3>父体订单量份额与12个月趋势</h3>
          <p>默认统计窗口 · {window.startMonth} — {window.endMonth}</p>
        </div>
        <span className="xydc-order-source-badge">西柚洞察 · 子体汇总</span>
      </div>
      <p className="xydc-order-scope-note">按当前变体关系汇总全部子体；总量、份额与排序使用同一12个月窗口。</p>
      <XydcOrderProgress value={props.progress ?? null} />
      {requested.size > discovered.size && <p className="xydc-order-scope-note">商品变体发现 {discovered.size}/{requested.size}
        {missing.length > 0 && <span> · 尚未取得变体关系 {missing.length} 个商品（{missing.join("、")}），整组数据尚不完整。</span>}
      </p>}
      {failedInputs.length > 0 && <p className="xydc-order-scope-note" role="status">
        变体发现失败 {failedInputs.length} 个商品，未计入子体进度；整组数据尚不完整。
        {failedInputs.map(family => <span key={family.inputAsin}> {family.inputAsin}（{family.reasonCode ?? "原因未提供"}）</span>)}
      </p>}
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

function InteractiveXydcVariantSectionBody({ props, models }: { props: XydcVariantSectionProps; models: readonly XydcOrderCardModel[] }) {
  const [selection, setSelection] = React.useState<Readonly<{ key: string }> | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const annualInspection = useXydcAnnualInspection();
  const openedModel = selection
    ? models.find(model => `${model.group.country}:${model.group.parentAsin}` === selection.key) ?? null
    : null;
  React.useEffect(() => {
    if (!selection || openedModel) return;
    const absentSelection = selection;
    const timeout = window.setTimeout(() => {
      setSelection(current => current === absentSelection ? null : current);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [openedModel, selection]);
  const close = React.useCallback(() => {
    setSelection(null);
    window.requestAnimationFrame(() => {
      const trigger = triggerRef.current;
      if (trigger?.isConnected && !trigger.disabled && trigger.getClientRects().length > 0) trigger.focus();
    });
  }, []);
  const open = React.useCallback((model: XydcOrderCardModel, trigger: HTMLButtonElement) => {
    annualInspection?.dismiss({ suppress: true });
    triggerRef.current = trigger;
    setSelection({ key: `${model.group.country}:${model.group.parentAsin}` });
  }, [annualInspection]);
  return <>
    <XydcVariantSectionBody props={props} models={models} onOpen={open} />
    {openedModel ? <XydcOrderDetail key={xydcAnnualInspectionIdentity(openedModel)} model={openedModel} market={props.market} onClose={close} /> : null}
  </>;
}

function InteractiveXydcVariantSection(props: XydcVariantSectionProps) {
  const { families, market, orderFamilies, products } = props;
  const models = React.useMemo(() => buildModels({ families, market, orderFamilies, products }), [families, market, orderFamilies, products]);
  return <XydcAnnualInspectionProvider models={models}>
    <InteractiveXydcVariantSectionBody props={props} models={models} />
  </XydcAnnualInspectionProvider>;
}

export function XydcVariantSection(props: XydcVariantSectionProps) {
  if (typeof window === "undefined") {
    const models = buildModels(props);
    return <XydcAnnualInspectionProvider models={models}>
      <XydcVariantSectionBody props={props} models={models} />
    </XydcAnnualInspectionProvider>;
  }
  return <InteractiveXydcVariantSection {...props} />;
}
