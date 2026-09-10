"use client";

import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { type NavGroupId } from "../shell/navigation";

export function useFlyoutState() {
  const [flyoutGroupId, setFlyoutGroupId] = useState<NavGroupId | null>(null);

  const [flyoutPinned, setFlyoutPinned] = useState(false);

  const [flyoutTop, setFlyoutTop] = useState(96);

  const flyoutCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flyoutPanelRef = useRef<HTMLElement | null>(null);

  const flyoutPinnedRef = useRef(false);

  return {
    flyoutGroupId, setFlyoutGroupId, flyoutPinned, setFlyoutPinned, flyoutTop, setFlyoutTop, flyoutCloseTimer, flyoutPanelRef,
    flyoutPinnedRef,
  };
}

type useFlyoutPinnedPhaseInputs = Pick<ReturnType<typeof useFlyoutState>, "flyoutPinnedRef" | "flyoutPinned">;

export function useFlyoutPinnedPhase({ flyoutPinnedRef, flyoutPinned }: useFlyoutPinnedPhaseInputs) {
  useEffect(() => {
    flyoutPinnedRef.current = flyoutPinned;
  }, [flyoutPinned, flyoutPinnedRef]);

  return {  };
}

type useFlyoutInteractionsInputs = Pick<ReturnType<typeof useFlyoutState>, "flyoutCloseTimer" | "setFlyoutTop" | "setFlyoutGroupId" | "setFlyoutPinned" | "flyoutGroupId" | "flyoutPinned" | "flyoutPinnedRef" | "flyoutPanelRef" | "flyoutTop">;

export function useFlyoutInteractions({
    flyoutCloseTimer: flyoutCloseTimerRef, setFlyoutTop, setFlyoutGroupId, setFlyoutPinned, flyoutGroupId, flyoutPinned,
    flyoutPinnedRef, flyoutPanelRef, flyoutTop,
  }: useFlyoutInteractionsInputs) {
  const clearFlyoutCloseTimer = () => {
    if (flyoutCloseTimerRef.current) {
      clearTimeout(flyoutCloseTimerRef.current);
      flyoutCloseTimerRef.current = null;
    }
  };

  const alignFlyoutToTrigger = (trigger: HTMLElement) => {
    const rail = trigger.closest(".nav-rail") ?? trigger;
    const top = trigger.getBoundingClientRect().top - rail.getBoundingClientRect().top;
    setFlyoutTop(Math.max(8, top));
  };

  const openFlyout = (id: NavGroupId, trigger?: HTMLElement | null) => {
    if (trigger) alignFlyoutToTrigger(trigger);
    clearFlyoutCloseTimer();
    setFlyoutGroupId(id);
  };

  const closeFlyout = () => {
    clearFlyoutCloseTimer();
    setFlyoutPinned(false);
    setFlyoutGroupId(null);
  };

  const toggleFlyout = (id: NavGroupId, trigger?: HTMLElement | null) => {
    if (trigger) alignFlyoutToTrigger(trigger);
    clearFlyoutCloseTimer();
    if (flyoutGroupId === id && flyoutPinned) {
      closeFlyout();
      return;
    }
    setFlyoutPinned(true);
    setFlyoutGroupId(id);
  };

  const scheduleCloseFlyout = () => {
    if (flyoutPinnedRef.current) return;
    clearFlyoutCloseTimer();
    flyoutCloseTimerRef.current = setTimeout(() => {
      if (flyoutPinnedRef.current) return;
      setFlyoutGroupId(null);
      flyoutCloseTimerRef.current = null;
    }, 240);
  };

  useEffect(() => () => clearFlyoutCloseTimer(), []);

  useLayoutEffect(() => {
    if (!flyoutGroupId || !flyoutPanelRef.current) return;
    const panel = flyoutPanelRef.current;
    const rail = panel.closest(".nav-rail");
    if (!rail) return;
    const height = panel.offsetHeight;
    const railHeight = rail.getBoundingClientRect().height;
    const margin = 8;
    const maxTop = Math.max(margin, railHeight - height - margin);
    setFlyoutTop(current => Math.min(Math.max(current, margin), maxTop));
  }, [flyoutGroupId, flyoutTop, flyoutPanelRef, setFlyoutTop]);

  useEffect(() => {
    if (!flyoutGroupId) return;
    const onPointerDown = (event: PointerEvent) => {
      const path = event.composedPath();
      const inside = path.some(
        node =>
          node instanceof Element &&
          node.closest(".nav-rail, .sidebar-flyout, .voc-tertiary-open"),
      );
      if (inside) return;
      closeFlyout();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeFlyout();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [flyoutGroupId]);

  return { clearFlyoutCloseTimer, openFlyout, closeFlyout, toggleFlyout, scheduleCloseFlyout };
}
