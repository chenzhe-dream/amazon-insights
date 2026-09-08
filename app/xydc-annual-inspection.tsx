"use client";

import * as React from "react";
import * as ReactDom from "react-dom";

import { summarizeXydcOrders } from "../shared/xydc-order-summary";
import {
  formatOrderCount,
  formatOrderShare,
  orderAttributeLabel,
  type XydcOrderCardModel,
} from "./xydc-order-card";

type ActiveInspection = Readonly<{
  identity: string;
  asin: string;
  pinned: boolean;
  trigger: HTMLButtonElement;
}>;

type DismissOptions = Readonly<{ restoreFocus?: boolean; suppress?: boolean }>;

type AnnualInspectionController = Readonly<{
  active: ActiveInspection | null;
  panelId: string;
  activatePreview(identity: string, asin: string, trigger: HTMLButtonElement): void;
  togglePinned(identity: string, asin: string, trigger: HTMLButtonElement): void;
  schedulePreviewDismiss(): void;
  cancelPreviewDismiss(): void;
  releaseSuppression(trigger: HTMLButtonElement): void;
  dismiss(options?: DismissOptions): void;
}>;

const AnnualInspectionContext = React.createContext<AnnualInspectionController | null>(null);
const PREVIEW_DISMISS_DELAY_MS = 90;

export function xydcAnnualInspectionIdentity(model: XydcOrderCardModel) {
  const orderWindow = model.snapshot?.window ?? model.window;
  const childAsins = model.group.children.map(child => child.asin).sort();
  return [model.group.country, model.group.parentAsin, orderWindow.startMonth, orderWindow.endMonth, childAsins.join(",")].join(":");
}

function isRestorableTrigger(trigger: HTMLButtonElement) {
  return trigger.isConnected && !trigger.disabled && trigger.getClientRects().length > 0;
}

function XydcAnnualInspectionRegion({
  active,
  model,
  controller,
}: {
  active: ActiveInspection;
  model: XydcOrderCardModel;
  controller: AnnualInspectionController;
}) {
  const regionRef = React.useRef<HTMLElement>(null);
  const titleId = `${controller.panelId}-title`;
  const [position, setPosition] = React.useState<Readonly<{ left: number; top: number; width: number; maxHeight: number }> | null>(null);
  const summary = model.snapshot ? summarizeXydcOrders(model.snapshot) : null;
  const orderWindow = model.snapshot?.window ?? model.window;
  const historical = Boolean(model.snapshot && orderWindow.endMonth !== model.window.endMonth);
  const row = summary?.rows.find(candidate => candidate.asin === active.asin) ?? {
    asin: active.asin,
    complete: false,
    total: null,
    share: null,
    missingMonths: orderWindow.months,
    undisclosedMonths: 0,
  };
  const child = model.group.children.find(candidate => candidate.asin === active.asin);

  React.useLayoutEffect(() => {
    const region = regionRef.current;
    if (!region || !active.trigger.isConnected) return;
    const updatePosition = () => {
      const viewportPadding = 8;
      const gap = 8;
      const triggerBounds = active.trigger.getBoundingClientRect();
      const regionBounds = region.getBoundingClientRect();
      const visualViewport = window.visualViewport;
      const viewportLeft = Math.max(0, visualViewport?.offsetLeft ?? 0);
      const viewportTop = Math.max(0, visualViewport?.offsetTop ?? 0);
      const viewportRight = Math.min(
        document.documentElement.clientWidth || window.innerWidth,
        visualViewport ? visualViewport.offsetLeft + visualViewport.width : Number.POSITIVE_INFINITY,
      );
      const viewportBottom = Math.min(
        document.documentElement.clientHeight || window.innerHeight,
        visualViewport ? visualViewport.offsetTop + visualViewport.height : Number.POSITIVE_INFINITY,
      );
      const width = Math.min(340, Math.max(0, viewportRight - viewportLeft - viewportPadding * 2));
      const maxHeight = Math.max(0, viewportBottom - viewportTop - viewportPadding * 2);
      const height = Math.min(region.scrollHeight || regionBounds.height, maxHeight);
      const below = viewportBottom - triggerBounds.bottom - gap - viewportPadding;
      const above = triggerBounds.top - viewportTop - gap - viewportPadding;
      const top = below >= Math.min(height, 220) || below >= above
        ? Math.min(triggerBounds.bottom + gap, viewportBottom - height - viewportPadding)
        : Math.max(viewportTop + viewportPadding, triggerBounds.top - gap - height);
      const left = Math.min(
        Math.max(viewportLeft + viewportPadding, triggerBounds.left),
        Math.max(viewportLeft + viewportPadding, viewportRight - width - viewportPadding),
      );
      setPosition({ left, top: Math.max(viewportTop + viewportPadding, top), width, maxHeight });
    };
    updatePosition();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    observer?.observe(region);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [active.trigger, model]);

  return (
    <section
      ref={regionRef}
      role="region"
      aria-labelledby={titleId}
      id={controller.panelId}
      className="xydc-annual-inspection"
      data-pinned={active.pinned ? "true" : "false"}
      style={{
        left: position?.left ?? 8,
        top: position?.top ?? 8,
        width: position?.width,
        maxHeight: position?.maxHeight ?? "calc(100vh - 16px)",
        overflowY: "auto",
        visibility: position ? "visible" : "hidden",
      }}
      onMouseEnter={controller.cancelPreviewDismiss}
      onMouseLeave={controller.schedulePreviewDismiss}
      onFocusCapture={controller.cancelPreviewDismiss}
      onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) controller.schedulePreviewDismiss();
      }}
    >
      <h5 id={titleId}>{orderAttributeLabel(child)} · 年度订单明细</h5>
      <p className="xydc-annual-inspection-asin">{row.asin}</p>
      <p>{orderWindow.startMonth} — {orderWindow.endMonth}</p>
      <dl>
        <div><dt>12个月订单量</dt><dd>{formatOrderCount(row.total, row.complete)}</dd></div>
        <div><dt>年度份额</dt><dd>{formatOrderShare(row.share)}</dd></div>
        <div><dt>缺失 / 未披露月份</dt><dd>{row.missingMonths.length} / {row.undisclosedMonths}</dd></div>
      </dl>
      <footer>
        {model.snapshot ? <>
          {historical
            ? <strong>历史缓存 · 当前统计区间待补齐</strong>
            : model.snapshot.cacheState === "stale"
              ? <strong>缓存数据 · 待更新</strong>
              : null}
          <span>来源更新时间：{model.snapshot.sourceUpdatedAt ?? "数据源未提供"}</span>
          <span>本次采集时间：{model.snapshot.fetchedAt}</span>
        </> : <span>订单数据待采集</span>}
      </footer>
      <button type="button" aria-label="关闭年度悬浮明细" onClick={() => controller.dismiss({ restoreFocus: true, suppress: true })}>关闭</button>
    </section>
  );
}

export function XydcAnnualInspectionProvider({
  models,
  children,
}: {
  models: readonly XydcOrderCardModel[];
  children: React.ReactNode;
}) {
  const [active, setActive] = React.useState<ActiveInspection | null>(null);
  const activeRef = React.useRef<ActiveInspection | null>(null);
  const dismissTimerRef = React.useRef<number | null>(null);
  const invalidationTimersRef = React.useRef(new Set<number>());
  const suppressedTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const reactId = React.useId();
  const panelId = `xydc-annual-inspection-${reactId.replaceAll(":", "")}`;
  React.useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const cancelPreviewDismiss = React.useCallback(() => {
    if (dismissTimerRef.current === null || typeof window === "undefined") return;
    window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
  }, []);

  const dismiss = React.useCallback((options: DismissOptions = {}) => {
    cancelPreviewDismiss();
    const current = activeRef.current;
    if (options.suppress && current) suppressedTriggerRef.current = current.trigger;
    setActive(null);
    if (options.restoreFocus && current && typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        if (isRestorableTrigger(current.trigger)) current.trigger.focus();
      });
    }
  }, [cancelPreviewDismiss]);

  const schedulePreviewDismiss = React.useCallback(() => {
    cancelPreviewDismiss();
    if (typeof window === "undefined" || activeRef.current?.pinned) return;
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null;
      setActive(current => current?.pinned ? current : null);
    }, PREVIEW_DISMISS_DELAY_MS);
  }, [cancelPreviewDismiss]);

  const activatePreview = React.useCallback((identity: string, asin: string, trigger: HTMLButtonElement) => {
    cancelPreviewDismiss();
    if (suppressedTriggerRef.current === trigger) return;
    setActive(current => current?.identity === identity && current.asin === asin && current.pinned
      ? current
      : { identity, asin, pinned: false, trigger });
  }, [cancelPreviewDismiss]);

  const togglePinned = React.useCallback((identity: string, asin: string, trigger: HTMLButtonElement) => {
    cancelPreviewDismiss();
    suppressedTriggerRef.current = null;
    const current = activeRef.current;
    if (current?.identity === identity && current.asin === asin && current.pinned && current.trigger === trigger) {
      suppressedTriggerRef.current = trigger;
      setActive(null);
      return;
    }
    setActive({ identity, asin, pinned: true, trigger });
  }, [cancelPreviewDismiss]);

  const releaseSuppression = React.useCallback((trigger: HTMLButtonElement) => {
    if (suppressedTriggerRef.current === trigger) suppressedTriggerRef.current = null;
  }, []);

  const activeModel = active ? models.find(model => xydcAnnualInspectionIdentity(model) === active.identity) ?? null : null;
  const visibleActive = active
    && active.trigger.isConnected
    && activeModel?.group.children.some(child => child.asin === active.asin)
    ? active
    : null;
  React.useEffect(() => {
    if (!active || visibleActive) return;
    const absentActive = active;
    const timeout = window.setTimeout(() => {
      invalidationTimersRef.current.delete(timeout);
      setActive(current => current === absentActive ? null : current);
    }, 0);
    invalidationTimersRef.current.add(timeout);
  }, [active, visibleActive]);
  React.useEffect(() => () => {
    for (const timeout of invalidationTimersRef.current) window.clearTimeout(timeout);
    invalidationTimersRef.current.clear();
  }, []);

  const controller = React.useMemo<AnnualInspectionController>(() => ({
    active: visibleActive,
    panelId,
    activatePreview,
    togglePinned,
    schedulePreviewDismiss,
    cancelPreviewDismiss,
    releaseSuppression,
    dismiss,
  }), [activatePreview, cancelPreviewDismiss, dismiss, panelId, releaseSuppression, schedulePreviewDismiss, togglePinned, visibleActive]);

  React.useEffect(() => {
    if (!visibleActive) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const region = document.getElementById(panelId);
      if (target && (visibleActive.trigger.contains(target) || region?.contains(target))) return;
      dismiss({ suppress: true });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss({ restoreFocus: true, suppress: true });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [dismiss, panelId, visibleActive]);

  const portalTarget = visibleActive?.trigger.isConnected
    ? visibleActive.trigger.closest<HTMLElement>('[role="dialog"]') ?? (typeof document === "undefined" ? null : document.body)
    : null;

  return <AnnualInspectionContext.Provider value={controller}>
    {children}
    {visibleActive && activeModel && portalTarget
      ? ReactDom.createPortal(<XydcAnnualInspectionRegion active={visibleActive} model={activeModel} controller={controller} />, portalTarget)
      : null}
  </AnnualInspectionContext.Provider>;
}

export function useXydcAnnualInspection() {
  return React.useContext(AnnualInspectionContext);
}

export function XydcAnnualInspectionTrigger({
  model,
  asin,
  className,
  style,
  label,
  title,
  dataOrderColor,
  children,
}: {
  model: XydcOrderCardModel;
  asin: string;
  className?: string;
  style?: React.CSSProperties;
  label?: string;
  title?: string;
  dataOrderColor?: string;
  children: React.ReactNode;
}) {
  const controller = useXydcAnnualInspection();
  const identity = xydcAnnualInspectionIdentity(model);
  const selected = controller?.active?.identity === identity && controller.active.asin === asin;
  return <button
    type="button"
    className={className}
    style={style}
    title={title}
    aria-label={label ?? `查看 ${orderAttributeLabel(model.group.children.find(child => child.asin === asin))} 年度订单明细`}
    aria-expanded={selected ? "true" : "false"}
    aria-controls={selected ? controller?.panelId : undefined}
    data-order-asin={asin}
    data-order-color={dataOrderColor}
    onMouseEnter={event => controller?.activatePreview(identity, asin, event.currentTarget)}
    onMouseLeave={event => {
      controller?.releaseSuppression(event.currentTarget);
      controller?.schedulePreviewDismiss();
    }}
    onFocus={event => controller?.activatePreview(identity, asin, event.currentTarget)}
    onBlur={event => {
      controller?.releaseSuppression(event.currentTarget);
      controller?.schedulePreviewDismiss();
    }}
    onClick={event => controller?.togglePinned(identity, asin, event.currentTarget)}
  >{children}</button>;
}
