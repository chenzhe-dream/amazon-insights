"use client";
import { useSyncExternalStore } from "react";

export const SIDEBAR_PREFERENCE_KEY = "amz-lens.sidebar.collapsed.v1";
const preferenceEvent = "amz-lens-sidebar-preference";
let sessionOverride: boolean | null = null;

export function readSidebarCollapsed(storage: Pick<Storage, "getItem">): boolean {
  try { return storage.getItem(SIDEBAR_PREFERENCE_KEY) === "true"; } catch { return false; }
}
export function saveSidebarCollapsed(storage: Pick<Storage, "setItem">, collapsed: boolean): boolean {
  try { storage.setItem(SIDEBAR_PREFERENCE_KEY, String(collapsed)); return true; } catch { return false; }
}
function getSnapshot() {
  if (sessionOverride !== null) return sessionOverride;
  try { return readSidebarCollapsed(window.localStorage); } catch { return false; }
}
function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SIDEBAR_PREFERENCE_KEY || event.key === null) { sessionOverride = null; listener(); }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(preferenceEvent, listener);
  return () => { window.removeEventListener("storage", onStorage); window.removeEventListener(preferenceEvent, listener); };
}
const getServerSnapshot = () => false;
export function useSidebarCollapse() {
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const toggle = () => {
    const next = !getSnapshot();
    sessionOverride = next;
    try { if (saveSidebarCollapsed(window.localStorage, next)) sessionOverride = null; } catch { /* Keep the choice usable when storage access is blocked. */ }
    window.dispatchEvent(new Event(preferenceEvent));
  };
  return { collapsed, toggle };
}
