"use client";

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { buildKeywordDemandAnalysis } from "./keyword-demand-analysis";
import { readAlexaVocNormalizationStatuses, pollAlexaVocNormalizationOnce } from "./lib/alexa-voc-normalization-status-client";
import type { ManualAlexaVocRecord } from "../shared/agent-contracts";
import { hasVocDevelopmentData } from "./voc-development-summary";
import { ProductDefinitionSection } from "./product-definition-section";
import { readEvidenceRun } from "./lib/voc-evidence-browser";
import { LocalProductDefinitionSection } from "./local-product-definition-section";
import type { LaunchProductInput, ProductLaunchRuntimeSources } from "./product-launch-analysis";
import { saveLocalRuleReport, readLocalRuleReports } from "./lib/local-rule-report-browser";
import type { LocalRuleReport } from "../shared/local-rule-report";
import { AnalysisRuleExplanation } from "./analysis-rule-explanation";
import { vocNormalizationFailureMessage } from "./lib/voc-normalization-message";
import { ProductDefinitionOutputSchema } from "../shared/product-definition-output";
const SavedVocEvidenceDefinition = lazy(() => import("./voc-evidence-definition").then(module => ({ default: module.VocEvidenceDefinition })));

function reviewFallbackSourceName(record: unknown) {
  return record && typeof record === "object" && "sourceProvider" in record && record.sourceProvider === "sellerSprite"
    ? "卖家精灵" : "Sorftime";
}

export function selectLocalVocSources(products: LaunchProductInput[], sources: ProductLaunchRuntimeSources, reviewFallback: boolean): ProductLaunchRuntimeSources {
  const manualVocByAsin = Object.fromEntries(products.map(p => [p.asin, sources.manualVocByAsin[p.asin]]));
  // Reviews only fill missing ASINs when explicitly requested.
  const reviewAnalysisByAsin = Object.fromEntries(products.filter(p => reviewFallback && !hasVocDevelopmentData([p], manualVocByAsin)).flatMap(p => sources.reviewFallbackCandidates?.[p.asin] ? [[p.asin, sources.reviewFallbackCandidates[p.asin]]] : []));
  return {analysisScope:sources.analysisScope, manualVocByAsin, reviewAnalysisByAsin, keywordDemand: buildKeywordDemandAnalysis(products, sources.keywordSources ?? {analysisByAsin:{},enrichmentByKeyword:{}})};
}

type LocalVocProps = {
  products: LaunchProductInput[]; sources: ProductLaunchRuntimeSources; enabled: boolean; initialRunId?: string | null; initialHistoryRunId?: string | null; initialSelectedAsins?: string[]; projectId?: string | null; baseSyncRunId?: string | null; jobId?: string | null; onImported?: (record: ManualAlexaVocRecord) => unknown;
  organizationId?: string; sessionKey?: string; refreshToken?: string;
};

export function LocalVocDefinition(props: LocalVocProps) {
  const { projectId, baseSyncRunId, initialRunId, initialSelectedAsins, organizationId, sessionKey, enabled, products } = props;
  const owner = JSON.stringify([sessionKey, organizationId, projectId, baseSyncRunId, initialRunId, initialSelectedAsins, enabled, products.map(product => product.asin)]);
  const [savedState, setSavedState] = useState<{ owner: string; selectedAsins?: string[]; error?: string } | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  useEffect(() => {
    if (!enabled || !projectId || !baseSyncRunId || !initialRunId || !organizationId || !sessionKey) return;
    const controller = new AbortController();
    void readEvidenceRun(projectId, initialRunId, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const manifest = value.evidenceSelection;
      const selectedAsins = manifest?.selectedAsins ?? [];
      const currentSelectedAsins = initialSelectedAsins ?? selectedAsins;
      const productAsins = new Set(products.map(product => product.asin));
      const report = value.reports.find(item => item.stage === "product-definition");
      const output = report ? ProductDefinitionOutputSchema.safeParse(report.result) : null;
      const reportManifest = output?.success ? output.data.evidenceSelection : undefined;
      if (!manifest || manifest.organizationId !== organizationId || manifest.projectId !== projectId || manifest.baseSyncRunId !== baseSyncRunId || manifest.marketplace !== "US" || !selectedAsins.length || new Set(selectedAsins).size !== selectedAsins.length || selectedAsins.some(asin => !productAsins.has(asin)) || !currentSelectedAsins.length || new Set(currentSelectedAsins).size !== currentSelectedAsins.length || currentSelectedAsins.some(asin => !productAsins.has(asin)) || (report && (!reportManifest || reportManifest.fingerprint !== manifest.fingerprint || reportManifest.organizationId !== organizationId || reportManifest.projectId !== projectId || reportManifest.baseSyncRunId !== baseSyncRunId || reportManifest.marketplace !== "US" || [...reportManifest.selectedAsins].sort().join(",") !== [...selectedAsins].sort().join(",")))) {
        setSavedState({ owner, error: "已保存分析的项目、站点或商品范围不匹配，无法作为当前结果展示。" });
        return;
      }
      setSavedState({ owner, selectedAsins: currentSelectedAsins });
    }).catch(error => { if (!controller.signal.aborted) setSavedState({ owner, error: error instanceof Error ? error.message : "已保存分析暂时无法读取。" }); });
    return () => controller.abort();
  }, [owner, enabled, projectId, baseSyncRunId, initialRunId, organizationId, sessionKey, products]);
  if (!enabled || !projectId || !baseSyncRunId || !initialRunId || !organizationId || !sessionKey) return <LocalVocRuleFlow {...props} />;
  const saved = savedState?.owner === owner ? savedState : null;
  if (!saved?.selectedAsins) return <>{saved?.error ? <p role="alert">{saved.error}</p> : <p role="status">正在读取已保存的固定来源分析…</p>}{saved?.error ? <LocalVocRuleFlow {...props} /> : null}</>;
  const scopedProducts = products.filter(product => saved.selectedAsins!.includes(product.asin));
  return <>
    <Suspense fallback={<p role="status">正在打开已保存的固定来源分析…</p>}><SavedVocEvidenceDefinition key={`${owner}:${saved.selectedAsins.join(",")}`} projectId={projectId} baseSyncRunId={baseSyncRunId} sessionKey={sessionKey} organizationId={organizationId} marketplace="US" asins={saved.selectedAsins} initialSelectedAsins={saved.selectedAsins} products={scopedProducts} sources={props.sources} initialRunId={initialRunId} refreshToken={props.refreshToken ?? ""} enabled={enabled} savedRunOnly /></Suspense>
    <details className="voc-coverage" open={localOpen} onToggle={event => setLocalOpen(event.currentTarget.open)}><summary>手工 VOC 与本地规则分析</summary>{localOpen && <LocalVocRuleFlow {...props} initialSelectedAsins={saved.selectedAsins} />}</details>
  </>;
}

function LocalVocRuleFlow({products, sources, enabled, initialSelectedAsins, projectId, baseSyncRunId, jobId, onImported, initialRunId, initialHistoryRunId}: LocalVocProps) {
  const historyRunId = initialRunId ?? initialHistoryRunId;
  const [selected, setSelected] = useState(() => initialSelectedAsins ?? products.map(p => p.asin));
  const [reviewFallback, setReviewFallback] = useState(false);
  const [ruleReports, setRuleReports] = useState<LocalRuleReport[]>([]);
  const [savedRuleReport, setSavedRuleReport] = useState<LocalRuleReport | null>(null);
  const [ruleHistoryOpen, setRuleHistoryOpen] = useState(false);
  const [savingRuleReport, setSavingRuleReport] = useState(false);
  const [ruleReportError, setRuleReportError] = useState<string | null>(null);
  const [loadingRuleReports, setLoadingRuleReports] = useState(false);
  const selectedRuleKey = [...selected].sort().join(",");
  const ruleScopeKey = JSON.stringify([projectId,sources.analysisScope,selectedRuleKey,reviewFallback]);
  const [reportScope, setReportScope] = useState(ruleScopeKey);
  const saveController = useRef<AbortController | null>(null);
  // Reset before children render, so a changed selection never displays a prior snapshot.
  if (reportScope !== ruleScopeKey) {
    setReportScope(ruleScopeKey);
    setSavingRuleReport(false); setSavedRuleReport(null); setRuleReports([]); setRuleReportError(null);
    setLoadingRuleReports(ruleHistoryOpen);
  }
  useEffect(() => {
    saveController.current?.abort();
    return () => saveController.current?.abort();
  }, [ruleScopeKey]);
  useEffect(() => {
    if (!enabled || !projectId || !ruleHistoryOpen || !selectedRuleKey) return;
    const controller = new AbortController();
    void readLocalRuleReports(projectId, selectedRuleKey.split(","), controller.signal).then(reports => {
      if (!controller.signal.aborted) { setRuleReports(reports); setRuleReportError(null); }
    }).catch(error => { if (!controller.signal.aborted) setRuleReportError(error instanceof Error ? error.message : "规则报告读取失败"); })
      .finally(() => { if (!controller.signal.aborted) setLoadingRuleReports(false); });
    return () => controller.abort();
  }, [projectId, enabled, ruleHistoryOpen, selectedRuleKey]);
  const selectedProducts = useMemo(() => products.filter(p => selected.includes(p.asin)), [products, selected]);
  const scoped = useMemo(() => selectLocalVocSources(selectedProducts, sources, reviewFallback), [selectedProducts, sources, reviewFallback]);
  const [refresh, setRefresh] = useState(0);
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
        const error = vocNormalizationFailureMessage(status.records);
        for (const record of status.records) {
          if (record.status !== "success") {
            blocked.push(record.asin);
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
  }, [enabled, projectId, baseSyncRunId, selected, onImported, refresh]);
  const ready = enabled && (!projectId || !baseSyncRunId || (normalization.scope === selected.join(",") && normalization.checked && !normalization.blocked.some(asin => selected.includes(asin)) && !normalization.error)) && hasVocDevelopmentData(selectedProducts, scoped.manualVocByAsin, scoped.reviewAnalysisByAsin);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof readEvidenceRun>> | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  useEffect(() => {
    if (!historyOpen || !enabled || !projectId || !historyRunId) return;
    const controller = new AbortController();
    void readEvidenceRun(projectId, historyRunId, controller.signal).then(result => {
      if (!controller.signal.aborted) {setHistory(result); setHistoryError(null);}
    }).catch(() => {if (!controller.signal.aborted) setHistoryError("历史报告暂时无法读取，请稍后重试。");});
    return () => controller.abort();
  }, [historyOpen, enabled, projectId, historyRunId, refresh]);
  const missing = selectedProducts.filter(p => !hasVocDevelopmentData([p],scoped.manualVocByAsin,scoped.reviewAnalysisByAsin)).map(p=>p.asin);
  const checking = Boolean(enabled && projectId && baseSyncRunId && (normalization.scope !== selected.join(",") || !normalization.checked));
  const pending = normalization.blocked.filter(asin=>selected.includes(asin));
  const message = !enabled ? "正在载入当前工作区。" : !selectedProducts.length ? "请选择至少一个 ASIN。" : normalization.error && baseSyncRunId ? normalization.error : ready ? "本地规则结果已生成；保存新的手工 VOC 后自动更新。" : missing.length ? `等待手工 VOC：${missing.join("、")}。保存完成后自动分析。` : checking ? "正在核实已保存的 VOC 状态，请稍候。" : `正在等待 ${pending.join("、")} 的 VOC 规范化或保存完成。`;
  const heading = ready ? "分析已完成" : normalization.error && baseSyncRunId ? "输入状态读取异常" : missing.length ? "等待手工 VOC" : "正在核实输入";
  const sourceLabel = `仅分析所选 ${selectedProducts.length} 个 ASIN · 关键词覆盖 ${scoped.keywordDemand?.meta.readyCount ?? 0}/${selectedProducts.length} · 本地规则分析`;
  return <div data-testid="voc-evidence-definition">
    <section className="voc-evidence-panel">
      <header><div><span className="voc-eyebrow">VOC · 新品定义</span><h3>分析来源与范围</h3></div><span className="voc-scope-count">已选 {selectedProducts.length} 个 ASIN</span></header>
      <div className="voc-asin-grid">{products.map(p => <label key={p.asin} className={selected.includes(p.asin) ? "selected" : ""}><input type="checkbox" checked={selected.includes(p.asin)} onChange={event => setSelected(previous => event.target.checked ? [...previous,p.asin] : previous.filter(asin => asin !== p.asin))} /><strong>{p.asin}</strong><small>{baseSyncRunId && pending.includes(p.asin) ? "VOC 规范化或保存中" : hasVocDevelopmentData([p],sources.manualVocByAsin) ? "手工 VOC 已就绪" : "等待手工 VOC"}</small></label>)}</div>
      <div className="voc-automation-status" data-testid="automation-status" data-state={ready ? "succeeded" : normalization.error ? "failed" : "waiting-voc"} role="status">
        <strong className="voc-status-heading">{!ready && !missing.length && !normalization.error && enabled && <span className="voc-status-spinner" aria-hidden="true" />}{heading}</strong>
        <p>{message}</p><small>{sourceLabel}</small>
      </div>
      <details className="voc-coverage"><summary>查看输入覆盖与来源</summary><p>{sourceLabel}</p>{selectedProducts.map(p=><p key={p.asin}>{p.asin}：{hasVocDevelopmentData([p],scoped.manualVocByAsin) ? "手工 VOC" : scoped.reviewAnalysisByAsin?.[p.asin] ? `${reviewFallbackSourceName(scoped.reviewAnalysisByAsin[p.asin])} 评论兜底` : "等待输入"}</p>)}<p>只使用所选商品的数据；缺失关键词信息保留为待验证。</p></details>
      <div className="voc-actions"><button onClick={()=>setRefresh(value=>value+1)}>重新检查输入</button><button disabled={!reviewFallback && !Object.keys(sources.reviewFallbackCandidates ?? {}).length} onClick={()=>setReviewFallback(value=>!value)}>{reviewFallback ? "恢复仅手工 VOC 分析" : "使用评论兜底分析"}</button>
        <button disabled={!ready || !projectId || savingRuleReport} onClick={async () => {
          if (!projectId) return;
          saveController.current?.abort();
          const controller = new AbortController();
          saveController.current = controller;
          setSavingRuleReport(true); setRuleReportError(null);
          try {
            const report = await saveLocalRuleReport({projectId,asins:selectedProducts.map(p=>p.asin),products:selectedProducts.map(p=>({asin:p.asin,brand:p.brand,title:p.title,subRankCategory:p.subRankCategory,rankCategory:p.rankCategory,features:p.features,price:p.price,sales:p.sales,rating:p.rating,reviews:p.reviews,launch:p.launch})),baseSyncRunId:baseSyncRunId && jobId ? baseSyncRunId : undefined,jobId:baseSyncRunId && jobId ? jobId : undefined,reviewFallback},controller.signal);
            if (!controller.signal.aborted) { setRuleReports(previous=>[report,...previous]); setSavedRuleReport(report); setRuleHistoryOpen(true); }
          } catch(error) { if (!controller.signal.aborted) setRuleReportError(error instanceof Error ? error.message : "规则报告保存失败"); }
          finally { if (!controller.signal.aborted) setSavingRuleReport(false); }
        }}>{savingRuleReport ? "正在生成并保存…" : "生成并保存规则结果"}</button>
      </div>
      {ruleReportError && <p role="alert">{ruleReportError}</p>}
      <small>保存时使用项目当前来源重新生成结果；已保存版本保留当时的结果、依据与规则版本。</small>
      <details className="voc-coverage" open={ruleHistoryOpen} onToggle={event=>{setRuleHistoryOpen(event.currentTarget.open);setLoadingRuleReports(event.currentTarget.open);}}>
        <summary>已保存的规则结果</summary>
        {loadingRuleReports ? <p role="status">正在读取规则报告…</p> : !ruleReports.length ? <p>当前所选商品暂无已保存的规则结果。</p> : ruleReports.map(report=><div key={report.id} className="voc-actions"><span>{new Date(report.createdAt).toLocaleString("zh-CN")} · {report.ruleSetVersion}</span><button onClick={()=>setSavedRuleReport(report)}>查看此版本</button></div>)}
      </details>
      {historyRunId && <details className="voc-coverage" onToggle={event=>setHistoryOpen(event.currentTarget.open)}><summary>查看已保存的 VOC 分析</summary>{historyError ? <p role="alert">{historyError}</p> : !history ? <p>正在读取历史报告…</p> : history.reports.filter(report=>report.stage === "voc-positioning").map(report=><div key={report.id}><p>历史版本 {report.version}（不代表本次规则结果）</p><p>{String((report.result.insight as {summary?:unknown} | undefined)?.summary ?? "该报告暂无摘要。")}</p></div>)}</details>}
    </section>
    {savedRuleReport ? <><section className="voc-evidence-panel"><p>正在查看已保存的规则结果 · {new Date(savedRuleReport.createdAt).toLocaleString("zh-CN")} · {savedRuleReport.ruleSetVersion}</p><p>{savedRuleReport.inputSourceNote}</p>{savedRuleReport.sourceAvailability && <p role="status">{savedRuleReport.sourceAvailability.message}</p>}<button onClick={()=>setSavedRuleReport(null)}>返回当前分析</button></section><LocalProductDefinitionSection products={savedRuleReport.products} sources={scoped} savedAnalysis={savedRuleReport.analysis} savedReport={savedRuleReport.finalDefinition} /></> : ready ? <LocalProductDefinitionSection products={selectedProducts} sources={scoped} /> : <><AnalysisRuleExplanation /><ProductDefinitionSection products={selectedProducts} sources={scoped} current={false} executionState="waiting-input" sourceLabel={message} /></>}
  </div>;
}
