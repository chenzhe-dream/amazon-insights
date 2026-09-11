"use client";
import "./voc-evidence-definition.css";
import type { VocAutomationStatus } from "../shared/voc-automation-contracts";
import { ProductDefinitionOutputSchema } from "../shared/product-definition-output";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { VocEvidenceInventory, VocEvidenceManifest } from "../shared/voc-evidence-contracts";
import type { ProductLaunchRuntimeSources, LaunchProductInput } from "./product-launch-analysis";
import { ProductDefinitionSection, type SavedProductDefinitionReport } from "./product-definition-section";
import { readVocAutomation, registerVocAutomation, readEvidenceInventory, readEvidenceRun, submitEvidenceRun, type EvidenceFetch } from "./lib/voc-evidence-browser";

type Props = { projectId: string | null; baseSyncRunId: string | null; sessionKey: string; organizationId: string; marketplace: string; asins: string[]; initialSelectedAsins?: string[]; products: LaunchProductInput[]; sources: ProductLaunchRuntimeSources; initialRunId: string | null; initialHistoryRunId?: string | null; refreshToken: string; enabled: boolean; onRunStarted?: (runId: string, selectedAsins: string[], previousRunId: string | null) => void; fetchImpl?: EvidenceFetch };
type Observation = Awaited<ReturnType<typeof readEvidenceRun>>;
export function VocEvidenceDefinition(props: Props) {
  const { onRunStarted } = props;
  const [selected, setSelected] = useState(props.initialSelectedAsins?.filter(asin => props.asins.includes(asin)) ?? props.asins);
  const selectedKey = [...selected].sort().join(",");
  const owner = `${props.organizationId}:${props.sessionKey}:${props.projectId}:${props.baseSyncRunId}:${props.marketplace}:${selectedKey}:${props.enabled}`;
  const liveOwner = useRef(owner);
  useLayoutEffect(() => { liveOwner.current = owner; }, [owner]);
  const [inventoryState, setInventory] = useState<{ owner: string; value: VocEvidenceInventory } | null>(null);
  const [runState, setRun] = useState<{ owner: string; id: string | null }>({ owner, id: props.initialRunId });
  const [observationState, setObservation] = useState<{ owner: string; value: Observation } | null>(null);
  const [history, setHistory] = useState<{ owner: string; report: Observation["reports"][number] } | null>(null);
  const [errorState, setError] = useState<{ owner: string; phase: "inventory" | "read" | "submit" | "automation-read" | "register"; message: string } | null>(null);
  const [busyOwner, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [observationRefresh, setObservationRefresh] = useState(0);
  const submitting = useRef<AbortController | null>(null);
  const requestKeys = useRef(new Map<string, string>());
  const [automationState, setAutomation] = useState<{owner:string; value:VocAutomationStatus}|null>(null);
  const automation = automationState?.owner === owner ? automationState.value : null;
  const registered = !!automation;
  const [automationRefresh, setAutomationRefresh] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const observedRunRef = useRef(observationState);
  const callbackRef = useRef(onRunStarted);
  const runRef = useRef(runState);
  useLayoutEffect(() => { callbackRef.current = onRunStarted; runRef.current = runState; observedRunRef.current = observationState; });
  const retryKeys = useRef(new Map<string,string>());
  const registration = useRef<AbortController|null>(null);
  const lastAutomationRun = useRef<{owner:string;id:string|null}|null>(null);
  const automationGeneration = useRef(0);
  const inventoryOwner = `${owner}:${props.refreshToken}:${refresh}`;
  const inventory = inventoryState?.owner === inventoryOwner ? inventoryState.value : null;
  const observation = observationState?.owner === owner ? observationState.value : null;
  const runId = runState.owner === owner ? runState.id : null;
  const enabled = props.enabled && !!props.projectId && !!props.baseSyncRunId && props.marketplace === "US" && selected.length > 0;
  const acceptAutomation = useCallback((value: VocAutomationStatus, force = false) => {
    if (liveOwner.current !== owner) return;
    if (value.projectId !== props.projectId || value.baseSyncRunId !== props.baseSyncRunId || [...value.selectedAsins].sort().join(",") !== selectedKey) throw new Error("自动分析范围不匹配");
    setAutomation({owner,value});
    const firstObservation = lastAutomationRun.current?.owner !== owner;
    // Resolve the URL run's persisted policy before interpreting a differing
    // backend baseline. Preserve explicit fallback selection, but allow a newly
    // created manual run to replace an older manual run after input edits.
    const existing = runRef.current.owner === owner ? runRef.current.id : null;
    const initialEvidence = observedRunRef.current?.owner === owner && observedRunRef.current.value.run.id === existing ? observedRunRef.current.value.evidenceSelection : undefined;
    if (!force && firstObservation && existing && existing !== value.runId && !initialEvidence) return;
    const preserveExplicitRun = !force && firstObservation && !!existing && existing !== value.runId && initialEvidence?.sourcePolicy === "manual-with-review-fallback";
    const changed = firstObservation || lastAutomationRun.current?.id !== value.runId;
    lastAutomationRun.current = {owner,id:value.runId};
    if (value.runId && (changed || force) && !preserveExplicitRun && (runRef.current.owner !== owner || runRef.current.id !== value.runId)) {
      const previous = runRef.current.owner === owner ? runRef.current.id : null;
      runRef.current = {owner,id:value.runId};
      setRun(runRef.current); setObservation(null);
      callbackRef.current?.(value.runId, selectedKey.split(","), previous);
      setRefresh(value => value + 1);
    }
  }, [owner, props.projectId, props.baseSyncRunId, selectedKey]);
  const register = useCallback(async (retry = false) => {
    if (!enabled || registration.current) return;
    const controller = new AbortController(); automationGeneration.current++; registration.current = controller; setBusy(owner); setError(null);
    if (retry && !retryKeys.current.has(owner)) retryKeys.current.set(owner, crypto.randomUUID());
    try {
      const value = await registerVocAutomation(props.projectId!, {baseSyncRunId:props.baseSyncRunId!, selectedAsins:selectedKey.split(","), ...(retryKeys.current.has(owner) ? {retryKey:retryKeys.current.get(owner)!} : {})}, controller.signal, props.fetchImpl);
      if (controller.signal.aborted || liveOwner.current !== owner) return;
      acceptAutomation(value, retry || retryKeys.current.has(owner)); retryKeys.current.delete(owner); setAutomationRefresh(value => value + 1);
    } catch(error) { if (!controller.signal.aborted && liveOwner.current === owner) setError({owner,phase:"register",message:error instanceof Error ? error.message : "登记自动分析失败"}); }
    finally { if (registration.current === controller) registration.current = null; if (liveOwner.current === owner) setBusy(null); }
  }, [enabled, owner, props.projectId, props.baseSyncRunId, props.fetchImpl, selectedKey, acceptAutomation]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void register(); });
    return () => { cancelled = true; registration.current?.abort(); registration.current = null; };
  }, [register]);
  useEffect(() => {
    if (!enabled || !registered) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const generation = automationGeneration.current;
        const value = await readVocAutomation(props.projectId!, controller.signal, props.fetchImpl);
        if (controller.signal.aborted || liveOwner.current !== owner) return;
        if (generation === automationGeneration.current && !registration.current) acceptAutomation(value);
        timer = setTimeout(poll, 1000);
      } catch(error) { if (!controller.signal.aborted && liveOwner.current === owner) setError({owner,phase:"automation-read",message:error instanceof Error ? error.message : "读取自动分析状态失败"}); }
    };
    timer = setTimeout(poll, 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [enabled, owner, registered, automationRefresh, props.projectId, props.fetchImpl, acceptAutomation]);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    readEvidenceInventory(props.projectId!, props.baseSyncRunId!, selectedKey.split(","), controller.signal, props.fetchImpl)
      .then(value => {
        if (controller.signal.aborted || liveOwner.current !== owner) return;
        if ([value.manual, value.fallback].some(manifest => manifest.organizationId !== props.organizationId || manifest.projectId !== props.projectId || manifest.baseSyncRunId !== props.baseSyncRunId || [...manifest.selectedAsins].sort().join(",") !== selectedKey)) throw new Error("输入清单范围不匹配");
        setInventory({ owner: inventoryOwner, value });
      }).catch(error => { if (!controller.signal.aborted && liveOwner.current === owner) { setInventory(null); setError({ owner, phase: "inventory", message: error instanceof Error ? error.message : "读取输入失败" }); } });
    return () => controller.abort();
  }, [owner, inventoryOwner, enabled, props.projectId, props.baseSyncRunId, props.organizationId, props.fetchImpl, selectedKey]); // selected is represented by selectedKey
  useEffect(() => {
    return () => { submitting.current?.abort(); submitting.current = null; };
  }, [owner]);
  useEffect(() => {
    if (!enabled || !runId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value = await readEvidenceRun(props.projectId!, runId, controller.signal, props.fetchImpl);
        if (controller.signal.aborted || liveOwner.current !== owner) return;
        setObservation({ owner, value });
        const saved = value.reports.find(report => report.stage === "product-definition");
        if (saved) setHistory({ owner, report: saved });
        if (value.stages.some(stage => (stage.stage === "voc-positioning" || stage.stage === "product-definition") && (stage.status === "queued" || stage.status === "running"))) timer = setTimeout(poll, 1000);
      } catch (error) { if (!controller.signal.aborted && liveOwner.current === owner) setError({ owner, phase: "read", message: error instanceof Error ? error.message : "读取报告失败" }); }
    };
    void poll(); return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [owner, enabled, runId, observationRefresh, props.projectId, props.fetchImpl]);
  useEffect(() => {
    if (!enabled || !props.initialHistoryRunId || props.initialHistoryRunId === runId) return;
    const controller = new AbortController();
    void readEvidenceRun(props.projectId!, props.initialHistoryRunId, controller.signal, props.fetchImpl).then(value => {
      const report = value.reports.find(item => item.stage === "product-definition");
      if (report && !controller.signal.aborted && liveOwner.current === owner) setHistory(previous => previous?.owner === owner ? previous : { owner, report });
    }).catch(() => {});
    return () => controller.abort();
  }, [enabled, owner, props.initialHistoryRunId, props.projectId, props.fetchImpl, runId]);
  const start = useCallback(async (manifest: VocEvidenceManifest) => {
    if (!enabled || submitting.current) return;
    const controller = new AbortController(); submitting.current = controller; setBusy(owner); setError(null);
    const key = `${owner}:${manifest.fingerprint}`;
    if (!requestKeys.current.has(key)) requestKeys.current.set(key, crypto.randomUUID());
    try {
      const result = await submitEvidenceRun(props.projectId!, { baseSyncRunId: props.baseSyncRunId!, selectedAsins: selected, sourcePolicy: manifest.sourcePolicy, expectedInputFingerprint: manifest.fingerprint }, requestKeys.current.get(key)!, controller.signal, props.fetchImpl);
      if (controller.signal.aborted || liveOwner.current !== owner) return;
      if (result.run.projectId !== props.projectId || result.stages.some(stage => stage.runId !== result.run.id)) throw new Error("分析提交范围不匹配");
      setObservation(null); setRun({ owner, id: result.run.id }); setObservationRefresh(value => value + 1); onRunStarted?.(result.run.id, selected, runId); requestKeys.current.delete(key);
    } catch (error) {
      if (!controller.signal.aborted && liveOwner.current === owner) { setError({ owner, phase: "submit", message: error instanceof Error ? error.message : "分析提交失败" }); setRefresh(value => value + 1); }
    } finally { if (submitting.current === controller) submitting.current = null; if (liveOwner.current === owner) setBusy(null); }
  }, [enabled, owner, props.projectId, props.baseSyncRunId, props.fetchImpl, onRunStarted, selected, runId]);
  const manualReady = !!inventory && inventory.manual.coverage.length === selected.length &&
    inventory.manual.coverage.every(row => row.primary === "manual" && !!row.manual);
  const activeRun = !!observation && (['queued', 'running'].includes(observation.run.status) ||
    observation.stages.some(stage => ['queued', 'running'].includes(stage.status)));
  const failedAnalysis = observation?.run.status === "failed" || observation?.stages.some(stage =>
    (stage.stage === "voc-positioning" || stage.stage === "product-definition") && stage.status === "failed");
  const failedFallback = failedAnalysis && observation?.evidenceSelection?.sourcePolicy === "manual-with-review-fallback";
  const report = observation?.reports.find(item => item.stage === "product-definition") ?? (history?.owner === owner ? history.report : null);
  const parsedResult = ProductDefinitionOutputSchema.safeParse(report?.result);
  const result = parsedResult.success ? parsedResult.data : undefined;
  const manifest = result?.evidenceSelection;
  const expected = manifest?.sourcePolicy === "manual-with-review-fallback" ? inventory?.fallback : inventory?.manual;
  const stage = observation?.stages.find(item => item.stage === "product-definition");
  const current = stage?.status === "succeeded" && report?.runId === runId && busyOwner !== owner && observation?.run.id === runId && !!manifest && !!expected && expected.keywords.state === "ready" && manifest.projectId === props.projectId && manifest.organizationId === props.organizationId && manifest.baseSyncRunId === props.baseSyncRunId && manifest.fingerprint === expected.fingerprint && result?.identity?.inputFingerprint === expected.fingerprint && [...manifest.selectedAsins].sort().join(",") === selectedKey;
  const executed = observation?.run.id === runId ? observation?.evidenceSelection : undefined;
  const executedScopeMatches = executed?.organizationId === props.organizationId && executed?.projectId === props.projectId && executed?.baseSyncRunId === props.baseSyncRunId && [...executed.selectedAsins].sort().join(",") === selectedKey;
  const source = executedScopeMatches ? executed : inventory?.manual;
  const manualCount = source?.coverage.filter(row => row.primary === "manual").length ?? 0;
  const reviewCount = source?.coverage.filter(row => row.primary === "review").length ?? 0;
  const keywordLabels = { ready: "关键词已就绪", empty: "当前范围无有效关键词", failed: "关键词请求失败", missing: "关键词未获取" };
  const sourceLabel = source ? `${executedScopeMatches ? "本次固定输入｜" : "可用输入·尚未启用评论兜底｜"}本次覆盖${manualCount + reviewCount}/${source.selectedAsins.length}：手工 VOC ${manualCount} 个，评论兜底 ${reviewCount} 个｜${keywordLabels[source.keywords.state]}｜${source.sourceMode === "review-fallback" ? "评论兜底版·待手工 VOC 验证" : "手工 VOC 版"}` : "等待可信输入";
  return <div data-testid="voc-evidence-definition">
    <section className="voc-evidence-panel">
      <header><div><span className="voc-eyebrow">VOC · 新品定义</span><h3>分析来源与范围</h3></div><span className="voc-scope-count">已选 {selected.length} 个 ASIN</span></header>
      <div className="voc-asin-grid">{props.asins.map(asin => <label key={asin} className={selected.includes(asin) ? "selected" : ""}><input type="checkbox" checked={selected.includes(asin)} onChange={() => setSelected(values => values.includes(asin) ? values.filter(value => value !== asin) : [...values, asin])} /><strong>{asin}</strong><small>{inventory?.manual.coverage.find(row => row.asin === asin)?.primary === "manual" ? "手工 VOC 已就绪" : "等待手工 VOC"}</small></label>)}</div>
      <div className="voc-automation-status" data-testid="automation-status" data-state={automation?.state ?? "registering"}>
        <strong>{busyOwner === owner ? "正在登记分析范围…" : automation ? ({"waiting-voc":"等待手工 VOC", "waiting-keywords":"等待关键词", queued:"已排队", "voc-running":"VOC 分析中", "definition-running":"新品定义生成中", succeeded:"分析已完成", failed:"分析失败"})[automation.state] : "尚未登记自动分析"}</strong>
        <p>{automation?.message ?? "所选范围将交由后台持续检查，输入齐全后自动分析。"}</p>
        {automation ? <small>最后更新：{new Date(automation.updatedAt).toLocaleTimeString("zh-CN")}{automation.startedAt ? ` · 已耗时 ${Math.max(0, Math.floor(((automation.state === "succeeded" || automation.state === "failed" ? Date.parse(automation.updatedAt) : clock) - Date.parse(automation.startedAt)) / 1000))} 秒` : ""}</small> : null}
      </div>
      <details className="voc-coverage"><summary>查看输入覆盖与来源</summary><p data-testid="evidence-source">{sourceLabel}</p>{inventory?.fallback.coverage.map(row => <p key={row.asin}>{row.asin}：{row.primary === "manual" ? "手工主来源" : row.primary === "review" ? "可用评论兜底" : "缺少 VOC"}；缺失维度 {row.missingDimensions.length || "无"}</p>)}</details>
      {!enabled ? <p>请在已同步的美国站项目中选择至少一个 ASIN。</p> : null}
      <div className="voc-actions">
      {errorState?.owner === owner && (errorState.phase === "read" || errorState.phase === "automation-read") ? <button onClick={() => { setError(null); setObservationRefresh(value => value + 1); setAutomationRefresh(value => value + 1); }}>重试读取分析状态</button> :
        automation?.state === "failed" ? <button disabled={busyOwner === owner} onClick={() => void register(true)}>重试手工 VOC 分析</button> : errorState?.owner === owner && errorState.phase === "register" ? <button disabled={busyOwner === owner} onClick={() => void register()}>重试登记自动分析</button> : null}
      {errorState?.owner === owner && errorState.phase === "inventory" ? <button onClick={() => {setError(null);setRefresh(value=>value+1);}}>重试读取输入</button> : null}
      <button disabled={!inventory?.fallback.coverage.some(row => row.review) || busyOwner === owner || activeRun || ["queued","voc-running","definition-running"].includes(automation?.state ?? "")} onClick={() => inventory && void start(inventory.fallback)}>{failedFallback ? "重试评论兜底分析" : "使用评论兜底分析"}</button>
      </div>
      {errorState?.owner === owner ? <p role="alert">{errorState.message}</p> : null}
      {observation?.stages.filter(item => item.status === "failed").map(item => <p role="alert" key={item.id}>{item.stage === "voc-positioning" ? "VOC 分析" : item.stage === "product-definition" ? "新品定义" : item.stage}失败：{item.lastError ? (typeof item.lastError === "string" ? item.lastError : JSON.stringify(item.lastError)) : "请重试分析"}</p>)}
      {report && !current ? <p>输入已变化或旧报告缺少来源版本：历史报告待更新。</p> : null}
      {observation?.reports.some(item => item.stage === "voc-positioning") && source?.keywords.state !== "ready" ? <p>VOC 报告已保存；{source ? keywordLabels[source.keywords.state] : "关键词未获取"}，暂停联合判断。</p> : null}
      {observation?.reports.filter(item => item.stage === "voc-positioning").slice(0, 1).map(item => <details key={item.id}><summary>查看已保存的 VOC 分析（版本 {item.version}）</summary><SavedVocSummary result={item.result} /></details>)}
    </section>
    <ProductDefinitionSection products={props.products} sources={props.sources} savedReport={(report ?? undefined) as SavedProductDefinitionReport | undefined} current={current} sourceLabel={sourceLabel} executionState={errorState?.owner === owner ? "failed" : stage?.status ?? (automation?.state === "failed" ? "failed" : automation?.state === "voc-running" || automation?.state === "definition-running" ? "running" : manualReady && automation?.state === "queued" ? "input-ready" : "waiting-input")} />
  </div>;
}

function SavedVocSummary({ result }: { result: Record<string, unknown> }) {
  const insight = result.insight as { summary?: unknown; sevenDimensions?: unknown } | undefined;
  if (!insight || typeof insight.summary !== "string") return <p>该历史报告格式需要在报告列表中查看。</p>;
  return <div><p>{insight.summary}</p>{Array.isArray(insight.sevenDimensions) ? insight.sevenDimensions.map((value: unknown, index) => {
    if (typeof value !== "object" || value === null) return null;
    const dimension = value as { dimension?: unknown; rows?: unknown };
    if (typeof dimension.dimension !== "string" || !Array.isArray(dimension.rows)) return null;
    const labels: Record<string,string> = {attention:"关注点",positives:"好评",negatives:"差评",unmet:"未满足需求",audiences:"人群",scenarios:"场景",motives:"动机"};
    return <section key={index}><h4>{labels[dimension.dimension] ?? dimension.dimension}</h4><ul>{dimension.rows.map((item: unknown,rowIndex)=>{
      if (typeof item !== "object" || item === null) return null;
      const row=item as {label?:unknown;feedback?:unknown;frequency?:unknown};
      return typeof row.label === "string" && typeof row.feedback === "string" ? <li key={rowIndex}>{row.label}：{row.feedback}{typeof row.frequency === "string" ? `（${row.frequency}）` : ""}</li> : null;
    })}</ul></section>;
  }) : null}</div>;
}
