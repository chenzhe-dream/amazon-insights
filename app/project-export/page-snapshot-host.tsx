"use client";
import { Component, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CompetitorOverviewSnapshotView } from "../project-report-views/competitor-overview";
import { collectPageSnapshotStyles } from "./page-snapshot-styles";
import { serializePageSnapshot } from "./serialize-page-snapshot";
import { readPageSnapshotSources, type PageSnapshotSources } from "./read-page-snapshot-sources";
import type { ExportFetcher, ExportRequest } from "./read-export-content";
import {PageSnapshotVariants} from "./page-snapshot-variants";
import {PageSnapshotImages} from "./page-snapshot-images";
import {SnapshotPresentationProvider} from "../project-report-views/snapshot-presentation";
import {PageSnapshotVoc} from "./page-snapshot-voc";
import {PageSnapshotKeywords} from "./page-snapshot-keywords";
import {PageSnapshotDefinition} from "./page-snapshot-definition";

export function PageSnapshotView({content}: {content: PageSnapshotSources}) {
  return <SnapshotPresentationProvider><main className="page-snapshot">
    <header className="card"><h1>{content.project.name}</h1><p>{content.project.marketplace} · {content.project.asins.length} 个 ASIN · 快照时间 {new Date(content.capturedAt).toLocaleString("zh-CN", {timeZone:"Asia/Shanghai"})}（北京时间）</p><p>{content.sourceLabel}</p></header>
    {content.moduleIds.includes("competitor-overview") && <section className="compare-page" data-snapshot-module="competitor-overview">{content.overview
      ? <CompetitorOverviewSnapshotView {...content.overview}/>
      : <div className="card"><h2>竞品参数总览</h2><p>暂无已发布的竞品结果。</p></div>}</section>}
    {content.moduleIds.includes("variants-orders") && content.variants && <section className="compare-page" data-snapshot-module="variants-orders"><PageSnapshotVariants {...content.variants}/></section>}
    {content.moduleIds.includes("listing-images") && content.images && <section className="compare-page" data-snapshot-module="listing-images"><PageSnapshotImages {...content.images}/></section>}
    {content.moduleIds.includes("voc") && content.voc && <section className="compare-page" data-snapshot-module="voc"><PageSnapshotVoc {...content.voc}/></section>}
    {content.moduleIds.includes("keywords") && content.keywords && <section className="compare-page" data-snapshot-module="keywords"><PageSnapshotKeywords {...content.keywords}/></section>}
    {content.moduleIds.includes("definition") && content.definition && <section className="compare-page" data-snapshot-module="definition"><PageSnapshotDefinition {...content.definition}/></section>}
  </main></SnapshotPresentationProvider>;
}
class SnapshotBoundary extends Component<{children: ReactNode; onError: (error: Error) => void}, {failed: boolean}> {
  state = {failed:false};
  static getDerivedStateFromError() { return {failed:true}; }
  componentDidCatch(error: Error) { this.props.onError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}
function Ready({children, onReady}: {children: ReactNode; onReady: () => void}) {
  useLayoutEffect(onReady, [onReady]); return children;
}
const snapshotLayout = `
html,body{margin:0!important;min-width:0!important;height:auto!important;overflow:auto!important}
.page-snapshot{padding:24px;max-width:1800px;margin:0 auto;color:var(--text,#20344e)}
.page-snapshot>header{margin-bottom:24px;padding:20px}.page-snapshot>header h1{font-size:20px;font-weight:700;margin-bottom:8px}
.page-snapshot>header p{font-size:12px;color:var(--muted);margin:4px 0}.page-snapshot [data-snapshot-module]{display:flex;flex-direction:column;gap:16px;margin-bottom:24px}
.page-snapshot details>summary{cursor:pointer;color:#385ba0;padding:8px 0}
.page-snapshot .matrix-wrap{max-height:720px;overflow:auto}
.page-snapshot a{overflow-wrap:anywhere}
@media(max-width:700px){.page-snapshot{padding:12px}}
`;
export async function renderPageSnapshot(content: PageSnapshotSources, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true"); host.inert = true;
  Object.assign(host.style, {position:"fixed", left:"-20000px", top:"0", width:"1440px", pointerEvents:"none"});
  document.body.append(host);
  const root = createRoot(host);
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("快照已取消"));
      signal.addEventListener("abort", abort, {once:true});
      const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
      const fail = (error: Error) => { signal.removeEventListener("abort", abort); reject(error); };
      root.render(<SnapshotBoundary onError={fail}><Ready onReady={finish}><PageSnapshotView content={content}/></Ready></SnapshotBoundary>);
    });
    await new Promise<void>((resolve, reject) => {
      let frame = 0;
      const abort = () => { cancelAnimationFrame(frame); reject(signal.reason ?? new Error("快照已取消")); };
      signal.addEventListener("abort", abort, {once:true});
      if (signal.aborted) { abort(); return; }
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { signal.removeEventListener("abort", abort); resolve(); }); });
    });
    signal.throwIfAborted();
    const view = host.querySelector<HTMLElement>(".page-snapshot");
    if (!view || !view.getBoundingClientRect().width) throw new Error("页面快照尚未准备完成");
    // Business presenters can mount their own scoped <style> blocks.
    const css = await collectPageSnapshotStyles(document, signal);
    return serializePageSnapshot({root:view,cssText:css + snapshotLayout,title:content.project.name,capturedAt:content.capturedAt});
  } finally { root.unmount(); host.remove(); }
}
export async function preparePageSnapshot(request: ExportRequest, fetcher?: ExportFetcher) {
  const content = await readPageSnapshotSources(request, fetcher);
  const html = await renderPageSnapshot(content, request.signal);
  return {content, html};
}
