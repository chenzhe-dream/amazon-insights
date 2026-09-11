"use client";

import { useEffect, useMemo, useState } from "react";
import { buildKeywordDemandAnalysis } from "./keyword-demand-analysis";
import { readAlexaVocNormalizationStatuses, pollAlexaVocNormalizationOnce } from "./lib/alexa-voc-normalization-status-client";
import type { ManualAlexaVocRecord } from "../shared/agent-contracts";
import { hasVocDevelopmentData } from "./voc-development-summary";
import { LocalProductDefinitionSection } from "./local-product-definition-section";
import type { LaunchProductInput, ProductLaunchRuntimeSources } from "./product-launch-analysis";

export function selectLocalVocSources(products: LaunchProductInput[], sources: ProductLaunchRuntimeSources, reviewFallback: boolean): ProductLaunchRuntimeSources {
  const manualVocByAsin = Object.fromEntries(products.map(p => [p.asin, sources.manualVocByAsin[p.asin]]));
  // Reviews only fill missing ASINs when explicitly requested.
  const reviewAnalysisByAsin = Object.fromEntries(products.filter(p => reviewFallback && !hasVocDevelopmentData([p], manualVocByAsin)).flatMap(p => sources.reviewFallbackCandidates?.[p.asin] ? [[p.asin, sources.reviewFallbackCandidates[p.asin]]] : []));
  return {manualVocByAsin, reviewAnalysisByAsin, keywordDemand: buildKeywordDemandAnalysis(products, sources.keywordSources ?? {analysisByAsin:{},enrichmentByKeyword:{}})};
}

export function LocalVocDefinition({products, sources, enabled, initialSelectedAsins, projectId, baseSyncRunId, onImported}: {
  products: LaunchProductInput[]; sources: ProductLaunchRuntimeSources; enabled: boolean; initialSelectedAsins?: string[]; projectId?: string | null; baseSyncRunId?: string | null; onImported?: (record: ManualAlexaVocRecord) => unknown;
}) {
  const [selected, setSelected] = useState(() => initialSelectedAsins ?? products.map(p => p.asin));
  const [reviewFallback, setReviewFallback] = useState(false);
  const selectedProducts = useMemo(() => products.filter(p => selected.includes(p.asin)), [products, selected]);
  const scoped = useMemo(() => selectLocalVocSources(selectedProducts, sources, reviewFallback), [selectedProducts, sources, reviewFallback]);
  const [normalization, setNormalization] = useState<{checked:boolean; blocked:string[]; error:string | null; scope?:string}>({checked:!projectId,blocked:[],error:null});
  useEffect(() => {
    if (!enabled || !projectId || !baseSyncRunId) return;
    const controller = new AbortController();
    const delivered = new Set<string>();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await readAlexaVocNormalizationStatuses({projectId,runId:baseSyncRunId,asins:selected,signal:controller.signal});
        const blocked: string[] = [];
        let error: string | null = null;
        for (const record of status.records) {
          if (record.status !== "success") {
            blocked.push(record.asin);
            if (record.status === "failure") error = "VOC 格式规范化失败，请回到手工输入处检查或重试。";
          } else if (!delivered.has(`${record.asin}:${record.fingerprint}:${record.revision}`)) {
            const result = await pollAlexaVocNormalizationOnce({projectId,runId:baseSyncRunId,asin:record.asin,fingerprint:record.fingerprint,signal:controller.signal});
            if (result.phase === "done" && !controller.signal.aborted) {
              onImported?.(result.record);
              delivered.add(`${record.asin}:${record.fingerprint}:${record.revision}`);
            } else blocked.push(record.asin);
          }
        }
        if (!controller.signal.aborted) setNormalization({checked:true,blocked,error,scope:selected.join(",")});
      } catch {
        if (!controller.signal.aborted) setNormalization({checked:false,blocked:[],error:"暂时无法核实 VOC 保存状态，正在重试。"});
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(),3000);
      }
    };
    void poll();
    return () => {controller.abort(); clearTimeout(timer);};
  }, [enabled, projectId, baseSyncRunId, selected, onImported]);
  const ready = enabled && (!projectId || (normalization.scope === selected.join(",") && normalization.checked && !normalization.blocked.some(asin => selected.includes(asin)) && !normalization.error)) && hasVocDevelopmentData(selectedProducts, scoped.manualVocByAsin, scoped.reviewAnalysisByAsin);
  return <>
    <section className="card launch-block">
      <div className="launch-section-head"><h2>分析来源与范围</h2><span className="status-chip">本地规则分析</span></div>
      <div className="launch-meta-row">{products.map(p => <label key={p.asin}><input type="checkbox" checked={selected.includes(p.asin)} onChange={event => setSelected(previous => event.target.checked ? [...previous,p.asin] : previous.filter(asin => asin !== p.asin))} /> {p.asin} · {hasVocDevelopmentData([p],sources.manualVocByAsin) ? "手工 VOC 已就绪" : "待输入或规范化"}</label>)}</div>
      <p role="status">{normalization.error ?? (ready ? "输入已就绪，本地规则结果已生成；修改已保存的 VOC 后自动更新。" : "等待手工 VOC 保存完成；所选商品就绪后自动生成结果。")}</p>
      <p>仅分析已选 {selectedProducts.length} 个 ASIN。关键词覆盖 {scoped.keywordDemand?.meta.readyCount ?? 0}/{selectedProducts.length}，缺失部分标记为待验证。</p>
      <label><input type="checkbox" checked={reviewFallback} onChange={event => setReviewFallback(event.target.checked)} /> 对缺少手工 VOC 的商品使用 Sorftime 评论兜底</label>
      <p>格式无法本地解析时仍可使用模型规范化；规则报告不调用模型。机会判断供需求评估，成本、利润、专利、合规和供应链仍需核验。</p>
    </section>
    {ready && <LocalProductDefinitionSection products={selectedProducts} sources={scoped} />}
  </>;
}
