"use client";
import { ProductDefinitionOutputSchema } from "../../../shared/product-definition-output";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { VocEvidenceInventory, VocEvidenceManifest } from "../../../shared/voc-evidence-contracts";
import type { ProductLaunchRuntimeSources, LaunchProductInput } from "../../product-launch-analysis";
import { ProductDefinitionSection, type SavedProductDefinitionReport } from "../../product-definition-section";
import { readEvidenceInventory, readEvidenceRun, submitEvidenceRun, type EvidenceFetch } from "../../lib/voc-evidence-browser";

type Props = { projectId: string | null; baseSyncRunId: string | null; sessionKey: string; organizationId: string; marketplace: string; asins: string[]; initialSelectedAsins?: string[]; products: LaunchProductInput[]; sources: ProductLaunchRuntimeSources; initialRunId: string | null; initialHistoryRunId?: string | null; refreshToken: string; enabled: boolean; onRunStarted?: (runId: string, selectedAsins: string[], previousRunId: string | null) => void; fetchImpl?: EvidenceFetch };
type Observation = Awaited<ReturnType<typeof readEvidenceRun>>;
export function VocEvidenceDefinition(props: Props) {
  const [selected, setSelected] = useState(props.initialSelectedAsins?.filter(asin => props.asins.includes(asin)) ?? props.asins);
  const selectedKey = [...selected].sort().join(",");
  const owner = `${props.sessionKey}:${props.projectId}:${props.baseSyncRunId}:${props.marketplace}:${selectedKey}:${props.enabled}`;
  const liveOwner = useRef(owner);
  useLayoutEffect(() => { liveOwner.current = owner; }, [owner]);
  const [inventoryState, setInventory] = useState<{ owner: string; value: VocEvidenceInventory } | null>(null);
  const [runState, setRun] = useState<{ owner: string; id: string | null }>({ owner, id: props.initialRunId });
  const [observationState, setObservation] = useState<{ owner: string; value: Observation } | null>(null);
  const [history, setHistory] = useState<{ owner: string; report: Observation["reports"][number] } | null>(null);
  const [errorState, setError] = useState<{ owner: string; message: string } | null>(null);
  const [busyOwner, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const submitting = useRef<AbortController | null>(null);
  const requestKeys = useRef(new Map<string, string>());
  const inventoryOwner = `${owner}:${props.refreshToken}:${refresh}`;
  const inventory = inventoryState?.owner === inventoryOwner ? inventoryState.value : null;
  const observation = observationState?.owner === owner ? observationState.value : null;
  const runId = runState.owner === owner ? runState.id : null;
  const enabled = props.enabled && !!props.projectId && !!props.baseSyncRunId && props.marketplace === "US" && selected.length > 0;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    readEvidenceInventory(props.projectId!, props.baseSyncRunId!, selectedKey.split(","), controller.signal, props.fetchImpl)
      .then(value => {
        if (controller.signal.aborted || liveOwner.current !== owner) return;
        if ([value.manual, value.fallback].some(manifest => manifest.organizationId !== props.organizationId || manifest.projectId !== props.projectId || manifest.baseSyncRunId !== props.baseSyncRunId || [...manifest.selectedAsins].sort().join(",") !== selectedKey)) throw new Error("输入清单范围不匹配");
        setInventory({ owner: inventoryOwner, value });
      }).catch(error => { if (!controller.signal.aborted && liveOwner.current === owner) { setInventory(null); setError({ owner, message: error instanceof Error ? error.message : "读取输入失败" }); } });
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
      } catch (error) { if (!controller.signal.aborted && liveOwner.current === owner) setError({ owner, message: error instanceof Error ? error.message : "读取报告失败" }); }
    };
    void poll(); return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [owner, enabled, runId, props.projectId, props.fetchImpl]);
  useEffect(() => {
    if (!enabled || !props.initialHistoryRunId || props.initialHistoryRunId === runId) return;
    const controller = new AbortController();
    void readEvidenceRun(props.projectId!, props.initialHistoryRunId, controller.signal, props.fetchImpl).then(value => {
      const report = value.reports.find(item => item.stage === "product-definition");
      if (report && !controller.signal.aborted && liveOwner.current === owner) setHistory(previous => previous?.owner === owner ? previous : { owner, report });
    }).catch(() => {});
    return () => controller.abort();
  }, [enabled, owner, props.initialHistoryRunId, props.projectId, props.fetchImpl, runId]);
  const start = async (manifest: VocEvidenceManifest) => {
    if (!enabled || submitting.current) return;
    const controller = new AbortController(); submitting.current = controller; setBusy(owner); setError(null);
    const key = `${owner}:${manifest.fingerprint}`;
    if (!requestKeys.current.has(key)) requestKeys.current.set(key, crypto.randomUUID());
    try {
      const result = await submitEvidenceRun(props.projectId!, { baseSyncRunId: props.baseSyncRunId!, selectedAsins: selected, sourcePolicy: manifest.sourcePolicy, expectedInputFingerprint: manifest.fingerprint }, requestKeys.current.get(key)!, controller.signal, props.fetchImpl);
      if (controller.signal.aborted || liveOwner.current !== owner) return;
      if (result.run.projectId !== props.projectId || result.stages.some(stage => stage.runId !== result.run.id)) throw new Error("分析提交范围不匹配");
      setObservation(null); setRun({ owner, id: result.run.id }); props.onRunStarted?.(result.run.id, selected, runId); requestKeys.current.delete(key);
    } catch (error) {
      if (!controller.signal.aborted && liveOwner.current === owner) { setError({ owner, message: error instanceof Error ? error.message : "分析提交失败" }); setRefresh(value => value + 1); }
    } finally { if (submitting.current === controller) submitting.current = null; if (liveOwner.current === owner) setBusy(null); }
  };
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
    <section className="card launch-block">
      <h3>分析来源与范围</h3>
      <div>{props.asins.map(asin => <label key={asin} style={{ marginRight: 12 }}><input type="checkbox" checked={selected.includes(asin)} onChange={() => setSelected(values => values.includes(asin) ? values.filter(value => value !== asin) : [...values, asin])} />{asin}</label>)}</div>
      <p data-testid="evidence-source">{sourceLabel}</p>
      {inventory?.fallback.coverage.map(row => <p key={row.asin}>{row.asin}：{row.primary === "manual" ? "手工主来源" : row.primary === "review" ? "可用评论兜底" : "缺少 VOC"}；缺失维度 {row.missingDimensions.length || "无"}</p>)}
      {!enabled ? <p>请在已同步的美国站项目中选择至少一个 ASIN。</p> : null}
      <button disabled={!inventory?.manual.coverage.some(row => row.primary === "manual") || busyOwner === owner} onClick={() => inventory && void start(inventory.manual)}>{report ? "更新手工 VOC 分析" : "开始手工 VOC 分析"}</button>{" "}
      <button disabled={!inventory?.fallback.coverage.some(row => row.review) || busyOwner === owner} onClick={() => inventory && void start(inventory.fallback)}>使用评论兜底分析</button>
      {busyOwner === owner ? <p>正在提交分析…</p> : null}
      {errorState?.owner === owner ? <p role="alert">{errorState.message}</p> : null}
      {report && !current ? <p>输入已变化或旧报告缺少来源版本：历史报告待更新。</p> : null}
      {observation?.reports.some(item => item.stage === "voc-positioning") && source?.keywords.state !== "ready" ? <p>VOC 报告已保存；{source ? keywordLabels[source.keywords.state] : "关键词未获取"}，暂停联合判断。</p> : null}
      {observation?.reports.filter(item => item.stage === "voc-positioning").slice(0, 1).map(item => <details key={item.id}><summary>查看已保存的 VOC 分析（版本 {item.version}）</summary><SavedVocSummary result={item.result} /></details>)}
    </section>
    <ProductDefinitionSection products={props.products} sources={props.sources} savedReport={(report ?? undefined) as SavedProductDefinitionReport | undefined} current={current} sourceLabel={sourceLabel} executionState={errorState?.owner === owner ? "failed" : stage?.status ?? "waiting-input"} />
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
