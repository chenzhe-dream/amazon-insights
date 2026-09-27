"use client";
import { Component, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CompetitorOverviewSnapshotView } from "../project-report-views/competitor-overview";
import { collectPageSnapshotStyles } from "./page-snapshot-styles";
import { serializePageSnapshot } from "./serialize-page-snapshot";
import { readPageSnapshotSources, type PageSnapshotSources } from "./read-page-snapshot-sources";
import type { ExportFetcher, ExportRequest } from "./read-export-eligibility";
import {PageSnapshotVariants} from "./page-snapshot-variants";
import {PageSnapshotImages} from "./page-snapshot-images";
import {SnapshotPresentationProvider} from "../project-report-views/snapshot-presentation";
import {PageSnapshotVoc} from "./page-snapshot-voc";
import {PageSnapshotKeywords} from "./page-snapshot-keywords";
import {PageSnapshotDefinition} from "./page-snapshot-definition";
import {PageSnapshotChecklist} from "./page-snapshot-checklist";
import {PageSnapshotTraffic} from "./page-snapshot-traffic";
import type {SnapshotPageId} from "./snapshot-navigation-catalog";
import {formatSnapshotTime} from './format-snapshot-time';

function SnapshotPage({id, content}: {id: SnapshotPageId; content: PageSnapshotSources}) {
  switch (id) {
    case "overview": return <section className="compare-page" data-snapshot-page={id} data-snapshot-module="competitor-overview">
      {content.overview ? <CompetitorOverviewSnapshotView {...content.overview}/> : <div className="card"><h2>竞品参数总览</h2><p>暂无已发布的竞品结果。</p></div>}
      {content.selection.includeVariants && (content.variants
        ? <div className="compare-page" data-snapshot-module="variants-orders"><PageSnapshotVariants {...content.variants}/></div>
        : <div className="card"><h2>变体 / 订单</h2><p>暂无已保存的变体 / 订单结果。</p></div>)}
    </section>;
    case "images": return <section className="compare-page" data-snapshot-page={id} data-snapshot-module="listing-images">
      {content.images ? <PageSnapshotImages {...content.images}/> : <div className="card"><h2>主辅图</h2><p>暂无已发布的主辅图结果。</p></div>}
    </section>;
    case "voc-summary": case "voc-insight": case "voc-positioning": return <section className="compare-page" data-snapshot-page={id} data-snapshot-module="voc">
      {content.voc ? <PageSnapshotVoc {...content.voc} page={id}/> : <div className="card"><h2>{id === "voc-summary" ? "竞品 VOC 汇总" : id === "voc-insight" ? "竞品 VOC 洞察" : "产品定义结论"}</h2><p>暂无已保存的 VOC 结果。</p></div>}
    </section>;
    case "keyword-analysis": case "keyword-insight": return <section className="compare-page" data-snapshot-page={id} data-snapshot-module="keywords">
      {content.keywords ? <PageSnapshotKeywords {...content.keywords} page={id}/> : <div className="card"><h2>{id === "keyword-analysis" ? "竞品关键词分析" : "关键词洞察"}</h2><p>暂无已发布的关键词结果。</p></div>}
    </section>;
    case "definition": return <section className="compare-page" data-snapshot-page={id} data-snapshot-module="definition">
      {content.definition ? <PageSnapshotDefinition {...content.definition}/> : <div className="card"><h2>新品定义</h2><p>暂无已有分析输入，当前没有可展示的新品定义。</p></div>}
    </section>;
    case "checklist": return <section className="compare-page" data-snapshot-page={id} data-snapshot-module="checklist">
      {content.checklist ? <PageSnapshotChecklist {...content.checklist}/> : <div className="card"><h2>立项前确认清单</h2><p>暂无已有分析输入，当前没有可展示的确认清单。</p></div>}
    </section>;
    case "traffic": return <section className="compare-page" data-snapshot-page={id} data-snapshot-module="traffic">
      {content.traffic ? <PageSnapshotTraffic {...content.traffic}/> : <div className="card"><h2>竞品流量分析</h2><p>暂无已保存的竞品流量结果。</p></div>}
    </section>;
  }
}

export function PageSnapshotView({content}: {content: PageSnapshotSources}) {
  return <SnapshotPresentationProvider><div className="page-snapshot">
    <header className="card"><h1>{content.project.name}</h1><p>{content.project.marketplace} · {content.project.asins.length} 个 ASIN · 快照生成时间：{formatSnapshotTime(content.capturedAt)}</p><p>{content.sourceLabel}</p><p>各模块的数据时间以页内标注为准。</p></header>
    {content.selection.pageIds.map(id => <SnapshotPage key={id} id={id} content={content}/>)}
  </div></SnapshotPresentationProvider>;
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
html,body{margin:0!important;min-width:0!important;height:auto!important}
html{overflow:auto!important}body{overflow:visible!important}
.page-snapshot{padding:24px;max-width:1800px;margin:0 auto;color:var(--text,#20344e)}
.page-snapshot>header{margin-bottom:24px;padding:20px}.page-snapshot>header h1{font-size:20px;font-weight:700;margin-bottom:8px}
.page-snapshot>header p{font-size:12px;color:var(--muted);margin:4px 0}.page-snapshot [data-snapshot-module]{display:flex;flex-direction:column;gap:16px;margin-bottom:24px}
.page-snapshot [data-snapshot-page],.page-snapshot [data-snapshot-page] .page-content,.page-snapshot [data-snapshot-page] .launch-page{box-sizing:border-box;min-width:0;max-width:100%;width:100%}
.page-snapshot [data-snapshot-page] .card{box-sizing:border-box;min-width:0;max-width:100%}
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
    for (const page of view.querySelectorAll<HTMLElement>(":scope > [data-snapshot-page]")) {
      const box = page.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) throw new Error(`快照页面尚未完成排版: ${page.dataset.snapshotPage}`);
      for (const chart of page.querySelectorAll<SVGSVGElement>("svg")) {
        if (chart.closest("details:not([open])")) continue;
        const chartBox = chart.getBoundingClientRect();
        if (chartBox.width <= 0 || chartBox.height <= 0) throw new Error(`快照图表尚未完成排版: ${page.dataset.snapshotPage}`);
      }
    }
    // Business presenters can mount their own scoped <style> blocks.
    const css = await collectPageSnapshotStyles(document, signal);
    return serializePageSnapshot({root:view,cssText:css + snapshotLayout,title:content.project.name,capturedAt:content.capturedAt,pageIds:content.selection.pageIds});
  } finally { root.unmount(); host.remove(); }
}
export async function preparePageSnapshot(request: ExportRequest, fetcher?: ExportFetcher) {
  const content = await readPageSnapshotSources(request, fetcher);
  const html = await renderPageSnapshot(content, request.signal);
  return {content, html};
}
