import { useEffect, useRef } from "react";
import { isXydcOrderProgressTerminal, type XydcOrderProgressView } from "../../shared/xydc-order-progress";

type Refresh = (signal: AbortSignal, isCurrent: () => boolean) => Promise<XydcOrderProgressView | null | undefined>;
function identity(view: XydcOrderProgressView | null) {
  return view ? `${view.currentRunId}:${view.jobId}:${view.leaseGeneration}` : "";
}
export function createXydcOrderPollOwner(refresh: Refresh) {
  let view: XydcOrderProgressView | null = null;
  let visible = true;
  let disposed = false;
  let epoch = 0;
  let busy = false;
  let discoveryNeeded = false;
  let discovering = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const active = new Set<string>();
  const finalized = new Set<string>();
  function invalidate() {
    epoch++;
    controller?.abort();
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  function terminal() { return Boolean(view?.progress && isXydcOrderProgressTerminal(view.progress.state)); }
  function eligible() {
    if (!view || finalized.has(identity(view))) return false;
    if (terminal()) return active.has(identity(view));
    return view.activeJob || Boolean(view.progress);
  }
  function schedule() {
    if (disposed || !visible || busy || timer) return;
    if (discoveryNeeded) { void poll(); return; }
    if (!eligible()) return;
    timer = setTimeout(() => { timer = undefined; void poll(); }, 5_000);
  }
  async function poll() {
    if (busy || disposed || !visible || (!discoveryNeeded && !eligible())) return;
    busy = true;
    discovering = discoveryNeeded;
    discoveryNeeded = false;
    const captured = epoch;
    const key = identity(view);
    const finalRefresh = terminal() && active.has(key);
    controller = new AbortController();
    const signal = controller.signal;
    const current = () => !disposed && visible && captured === epoch && !signal.aborted;
    try {
      const next = await refresh(signal, current);
      if (!current() || next === undefined) return;
      view = next;
      if (finalRefresh) finalized.add(key);
      else if (identity(next) === key && terminal() && active.has(key)) {
        // This response committed terminal facts. One final shared snapshot refresh, then stop even if other stages run.
        finalized.add(key);
        await refresh(signal, current);
      } else if (next && !terminal()) active.add(identity(next));
    } catch { /* Retain the last scoped snapshot; its evidence timestamp governs stale display. */ }
    finally { busy = false; discovering = false; schedule(); }
  }
  return {
    update(next: XydcOrderProgressView | null) {
      if (identity(next) !== identity(view)) invalidate();
      view = next;
      if (next && !terminal() && (next.activeJob || next.progress)) active.add(identity(next));
      schedule();
    },
    setVisible(value: boolean) {
      visible = value;
      if (!value) { if (discovering) discoveryNeeded = true; invalidate(); }
      else schedule();
    },
    discover() {
      discoveryNeeded = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      schedule();
    },
    dispose() { disposed = true; invalidate(); },
  };
}

export function useXydcOrderProgress(input: {
  scopeKey: string; enabled: boolean; view: XydcOrderProgressView | null; refresh: Refresh;
}) {
  const owner = useRef<ReturnType<typeof createXydcOrderPollOwner> | null>(null);
  useEffect(() => {
    if (!input.enabled) return;
    const current = createXydcOrderPollOwner(input.refresh);
    owner.current = current;
    const visibility = () => current.setVisible(document.visibilityState === "visible");
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => { current.dispose(); document.removeEventListener("visibilitychange", visibility); owner.current = null; };
  }, [input.scopeKey, input.enabled, input.refresh]);
  useEffect(() => { owner.current?.update(input.view); }, [input.view, input.scopeKey, input.enabled, input.refresh]);
  useEffect(() => { owner.current?.discover(); }, [input.scopeKey, input.enabled, input.refresh]);
}
