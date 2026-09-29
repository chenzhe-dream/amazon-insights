'use client';
import {MarketAdminContent} from './market-admin-tools';
import {shapePollingDelay} from './lib/market-shape-polling';
import {MarketShapeReferencePanel} from './market-shape-reference-panel';
import {MarketShapeMonthPicker} from './market-shape-month-picker';
import {MarketShapeCategoryDashboard} from './market-shape-category-dashboard';

import { browserRequestId } from "./lib/browser-request-id";
import {MarketSiteSelector} from './market-site-selector';
import {marketSiteCurrency,marketSites,type MarketSite} from '../shared/market-sites';
import {assertMarketProductQueryWindow} from '../shared/market-product-source-policy';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MarketModuleIdSchema } from '../shared/market-module-contracts';
import type { MarketShapeRun, MarketShapePublicRevision } from '../shared/market-shape-public-contracts';
import { queryShapeRun, readShapeRun, saveShapeRevisionAnalysis, readShapeRevision, retryShapeSteps, cancelShapeRun, resolveShapeNodeInput } from './lib/market-shape-browser';
import type { MarketShapeExplanationPresentation } from '../shared/market-shape-explanation-presentation';
import { MarketShapeReport } from './market-shape-report';
import {MarketShapeProductTable} from './market-shape-product-table';
import {MarketShapeDashboard} from './market-shape-dashboard';
import {LaunchSection} from './launch-section';
import {MarketShapeExplanationSection} from './market-shape-explanation-section';
import {buildManualShapeCatalog} from './lib/market-shape-manual-draft';
type Selection = {
    marketplace?: MarketSite;
    nodeIdPath: string;
    fromMonth: string;
    toMonth: string;
};
const active = (run: MarketShapeRun) => run.steps.some(s => s.current && ['running', 'queued'].includes(s.status));
const categoryNames:Record<string,string>={report:'类目近30天统计',SalesCount:'类目月销量',AvgPrice:'类目历史均价',Top3ProductSalesAmountShare:'Top3商品销售额占比',Top3BrandSalesAmountShare:'Top3品牌销售额占比',Top3SellerSalesAmountShare:'Top3卖家销售额占比'};
const stepNames: Record<string, string> = { 'collect-product-month': '商品采集', 'collect-shape-category':'类目历史与指标', 'collect-product-history':'商品月度历史', 'prepare-members': '固定商品池 / 准备形态输入', 'prepare-model-batches': '准备模型分析', 'model-batch': '形态建议' };
const stepErrors: Record<string, string> = { timeout: '等待上游超时', 'upstream-temporary': '上游暂不可用', 'invalid-data': '数据校验未通过', 'scope-mismatch': '来源范围不匹配', authentication: '来源认证失败', governance: '额度或调用策略限制', interrupted: '任务中断', internal: '处理失败', cancelled: '已取消' };
const statusNames: Record<string, string> = { queued: '排队中', running: '处理中', succeeded: '已完成', empty: '未返回数据', failed: '失败', cancelled: '已取消' };
const messages: Record<string, string> = { 'not-ready': '等待商品来源', unavailable: '模型暂不可用，可先人工确认并保存统计结果', running: '正在生成形态建议', partial: '部分形态建议不可用，可查看失败步骤或人工确认', complete: '形态建议已返回，需人工确认后才参与分组' };
export function shapeRunSummary(run: MarketShapeRun): string {
    if (run.status === 'cancelled') return '任务已取消';
    if (run.semanticStatus !== 'skipped') return messages[run.suggestions.status];
    if (active(run)) return run.latestRevision ? '规则统计已保存，正在重试来源或规则步骤' : '正在采集商品并计算本地规则';
    if (run.status === 'failed') return run.latestRevision ? '规则统计已保存；本次来源或规则步骤失败，可查看失败步骤并重试' : '商品来源或规则步骤失败，可查看失败步骤并重试';
    if (run.source?.productHistory?.products.some(p=>p.status==='failed')) return '商品来源已保存；部分商品历史采集失败，可在下方重试';
    if (run.latestRevision) return '本地规则统计已保存，语义解释未启用';
    if (run.source?.products.length) return '商品来源已就绪，待人工确认并保存规则统计';
    return '本次尚无可用商品来源，规则统计待完成';
}
function priceBands(value: string) { const n = value.split(/[,，]/).map(s => { if (!/^\d+(\.\d+)?$/.test(s.trim()))
    throw Error('价格带请输入逗号分隔的非负数字，例如 0,20,40。'); return Number(s.trim()); }); if (n.length > 32 || n.some((v, i) => !Number.isFinite(v) || i > 0 && v <= n[i - 1]))
    throw Error('价格带边界须从小到大排列且不能重复。'); return n.map((minInclusive, i) => ({ id: `band-${i + 1}`, minInclusive, maxExclusive: n[i + 1] ?? null })); }
export function MarketShapeSection({ selection, onSelectionChange, maxMonth, onFavorite }: {
    selection: Selection;
    onSelectionChange: (next: Partial<Selection>) => void;
    maxMonth: string;
    onFavorite?:()=>void;
}) {
    const [runId, setRunId] = useState(''), [restoreId, setRestoreId] = useState(''), [run, setRun] = useState<MarketShapeRun | null>(null), [reload, setReload] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [readError, setReadError] = useState<string | null>(null);
    const [lastReadAt,setLastReadAt]=useState<string|null>(null);
    const [poolSize, setPoolSize] = useState(100), [bands, setBands] = useState('0,20,40'), [selected, setSelected] = useState<string[]>([]), [assignments, setAssignments] = useState<Record<string, string>>({}), [parent, setParent] = useState<string | null>(null), [note, setNote] = useState('');
    const [choice, setChoice] = useState('latest'), [historic, setHistoric] = useState<MarketShapePublicRevision | null>(null), [historyError, setHistoryError] = useState<string | null>(null);
    const [presentation, setPresentation] = useState<MarketShapeExplanationPresentation | null>(null);
    const [analysisNotice,setAnalysisNotice]=useState<{runId:string;revisionId:string;reason:string|null}|null>(null);
    const owner = useRef<AbortController | null>(null), draftRun = useRef(''), pendingStart = useRef<{
        hash: string;
        studyKey: string;
        runKey: string;
    } | null>(null), pendingSave = useRef<{
        hash: string;
        key: string;
    } | null>(null);
    useEffect(() => { const abort = new AbortController(); owner.current = abort; const id = MarketModuleIdSchema.safeParse(new URL(window.location.href).searchParams.get('shapeRun')); if (id.success) {
        setRunId(id.data);
        setRestoreId(id.data);
    } return () => { abort.abort(); owner.current = null; }; }, []);
    useEffect(() => {
        if (!runId)
            return;
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let failures=0;
        const read = async () => { try {
            const next = await readShapeRun(runId, abort.signal);
            if (abort.signal.aborted)
                return;
            setRun(next);
            failures=0;
            setLastReadAt(new Date().toLocaleTimeString());
            setReadError(null);
            if (active(next))
                timer = setTimeout(() => void read(), 4000);
        }
        catch (e) {
            if (!abort.signal.aborted) {
                const delay=shapePollingDelay(++failures,e);
                setReadError(`${e instanceof Error ? e.message : '读取状态失败'}；${delay===null?'自动重试已停止，请手动刷新状态':`${delay/1000}秒后自动重试（${failures}/5）`}`);
                if(delay!==null)timer=setTimeout(()=>void read(),delay);
            }
        } };
        void read();
        return () => { abort.abort(); if (timer)
            clearTimeout(timer); };
    }, [runId, reload]);
    function loadDraft(next: MarketShapeRun) { const r = next.latestRevision, labels = new Map((r?.labels ?? next.params.catalog.allowedLabels).map(l => [l.labelId,l.label])); setSelected(r?.selectedAsins ?? next.source?.products.map(p => p.asin) ?? []); setAssignments(Object.fromEntries((r?.assignments ?? []).map(a => [a.asin, a.labelId ? labels.get(a.labelId) ?? '' : '']))); setParent(r?.revisionId ?? null); setNote(r?.note ?? ''); setBands(r ? r.bands.map(b => b.minInclusive).join(',') : '0,20,40'); draftRun.current = next.id; pendingSave.current = null; }
    useEffect(() => { if (run?.source && draftRun.current !== run.id)
        loadDraft(run); }, [run]);
    useEffect(() => { setHistoric(null); setHistoryError(null); if (!runId || choice === 'latest')
        return; const abort = new AbortController(); void readShapeRevision(runId, choice, abort.signal).then(r => { if (!abort.signal.aborted)
        setHistoric(r); }, e => { if (!abort.signal.aborted)
        setHistoryError(e instanceof Error ? e.message : '读取报告失败'); }); return () => abort.abort(); }, [runId, choice]);
    const remember = (id: string) => { const url = new URL(window.location.href); url.searchParams.set('shapeRun', id); url.searchParams.set('themeView', 'shapes'); window.history.replaceState(window.history.state, '', url); setRestoreId(id); };
    async function start(e?: FormEvent, requestedPoolSize = poolSize, requestedSelection = selection, forceRefresh = false) {
        e?.preventDefault();
        const signal = owner.current?.signal;
        if (!signal || busy || (run && active(run)))
            return;
        setBusy(true);
        setError(null);
        try {
            assertMarketProductQueryWindow(requestedSelection,new Date());
            const nodeIdPath=await resolveShapeNodeInput(requestedSelection.marketplace??'US',requestedSelection.nodeIdPath,signal);
            signal.throwIfAborted();
            if(nodeIdPath!==requestedSelection.nodeIdPath)onSelectionChange({nodeIdPath});
            const scope = { nodeIdPath,fromMonth:requestedSelection.fromMonth,toMonth:requestedSelection.toMonth,marketplace: requestedSelection.marketplace??'US', currency: marketSiteCurrency(requestedSelection.marketplace??'US') }, params = { poolSize: requestedPoolSize, newProductMonths: 6, catalog: { task: 'market-product-shape-suggestion', taxonomyVersion: 'manual-after-collection/v1', allowedLabels: [] } }, hash = JSON.stringify({ scope, params,forceRefresh });
            const command = pendingStart.current?.hash === hash ? pendingStart.current : { hash, studyKey: browserRequestId(), runKey: browserRequestId() };
            pendingStart.current = command;
            const next = await queryShapeRun({scope,params,forceRefresh},command.runKey,signal);
            signal.throwIfAborted();
            pendingStart.current = null;
            setRun(next);
            setRunId(next.id);
            setReadError(null);
            setChoice('latest');
            setHistoric(null);
            remember(next.id);
            setReload(n => n + 1);
        }
        catch (e) {
            if (!signal.aborted)
                setError(e instanceof Error ? e.message : '提交失败，可保留输入重试');
        }
        finally {
            if (!signal.aborted)
                setBusy(false);
        }
    }
    async function save() {
        const signal = owner.current?.signal;
        if (!signal || busy || !run?.source || readError)
            return;
        setBusy(true);
        setError(null);
        try {
            const catalog = run.latestRevision ?? { taxonomyVersion: run.params.catalog.taxonomyVersion, labels: run.params.catalog.allowedLabels };
            const manual = buildManualShapeCatalog(catalog.labels,selected,assignments);
            const request = { referenceAttemptId: run.source.referenceAttemptId, historyAttemptIds: run.source.historyAttemptIds, expectedParentRevisionId: parent, selectedAsins: selected, taxonomyVersion: catalog.taxonomyVersion, labels: manual.labels, assignments: manual.assignments, bands: priceBands(bands), note };
            const hash = JSON.stringify({ id: run.id, request }), command = pendingSave.current?.hash === hash ? pendingSave.current : { hash, key: browserRequestId() };
            pendingSave.current = command;
            const saved = await saveShapeRevisionAnalysis(run.id, request, command.key, signal),revision=saved.revision;
            signal.throwIfAborted();
            pendingSave.current = null;
            setAnalysisNotice({runId:run.id,revisionId:revision.revisionId,reason:saved.explanationUnavailableReason??null});
            setParent(revision.revisionId);
            setRun(current => current?.id === run.id ? { ...current, latestRevision: revision, history: [{ revisionId: revision.revisionId, ordinal: revision.ordinal, createdAt: revision.createdAt }, ...current.history.filter(r => r.revisionId !== revision.revisionId)].slice(0, 100) } : current);
            setChoice('latest');
            setReload(n => n + 1);
        }
        catch (e) {
            if (!signal.aborted)
                setError(e instanceof Error ? e.message : '保存失败，输入已保留');
        }
        finally {
            if (!signal.aborted)
                setBusy(false);
        }
    }
    async function action(kind: 'retry' | 'cancel', step?: MarketShapeRun['steps'][number]) { const signal = owner.current?.signal; if (!signal || !run || busy || readError)
        return; setBusy(true); setError(null); try {
        if (kind === 'retry' && step?.latestAttemptId)
            await retryShapeSteps(run.id, [{ stepId: step.id, failedAttemptId: step.latestAttemptId }], browserRequestId(), signal);
        else
            await cancelShapeRun(run.id, browserRequestId(), signal);
        signal.throwIfAborted();
        setReload(n => n + 1);
    }
    catch (e) {
        if (!signal.aborted)
            setError(e instanceof Error ? e.message : '操作失败');
    }
    finally {
        if (!signal.aborted)
            setBusy(false);
    } }
    function restore(e: FormEvent) { e.preventDefault(); const id = MarketModuleIdSchema.safeParse(restoreId.trim()); if (!id.success) {
        setError('请输入有效任务编号。');
        return;
    } setRun(null); setChoice('latest'); setRunId(id.data); remember(id.data); draftRun.current = ''; setReload(n => n + 1); }
    const queryLocked=busy||!!(run&&active(run));
    const report = choice === 'latest' ? run?.latestRevision : historic?.revisionId===choice?historic:null;
    return <div className="market-shape-workspace market-shape-reference" style={{gridTemplateColumns:"minmax(0, 1fr)"}}><section className="card ss-market-query ss-market-query--lilac market-shape-controls">
  <form onSubmit={e => void start(e)}>
   <div className="ss-market-query-row"><span className="ss-market-query-label">选择站点</span><MarketSiteSelector value={selection.marketplace??'US'} onChange={marketplace=>onSelectionChange({marketplace,nodeIdPath:''})} disabled={queryLocked}/></div>
   <div className="ss-market-query-highlight"><div className="ss-market-query-row"><span className="ss-market-query-label">选择类目</span><div className="ss-market-node-field"><button type="submit" className="ss-market-search-btn" disabled={queryLocked}>{busy?'提交中':'搜索'}</button><button type="button" className="ss-market-fav-btn" disabled={!onFavorite||!/^\d+(?::\d+)*$/.test(selection.nodeIdPath.trim())} title="保存到团队共享收藏" onClick={onFavorite}>☆ 收藏</button><input aria-label="类目节点" value={selection.nodeIdPath} onChange={e=>onSelectionChange({nodeIdPath:e.target.value})} placeholder="输入类目节点 ID 或英文名，例如 Floor Lamps" required disabled={queryLocked}/></div></div>
    <div className="market-theme-actions market-shape-query-months"><span>研究月份</span><MarketShapeMonthPicker label="起始月" value={selection.fromMonth} max={selection.toMonth} onChange={fromMonth=>onSelectionChange({fromMonth})} disabled={queryLocked}/><MarketShapeMonthPicker label="结束月" value={selection.toMonth} max={maxMonth} onChange={toMonth=>onSelectionChange({toMonth})} disabled={queryLocked}/></div>
    <details className="market-shape-query-options"><summary>采集选项</summary><label className="market-shape-pool-size">商品池上限 <input type="number" min={1} max={300} value={poolSize} onChange={e=>setPoolSize(Number(e.target.value))} disabled={queryLocked}/></label></details>
    <div className="ss-market-query-actions"><button className="ss-market-filter-btn" type="submit" disabled={queryLocked}>{busy?'提交中…':queryLocked?'正在采集':'筛选市场'}</button><button className="ghost-btn" type="button" disabled={queryLocked||!selection.nodeIdPath} onClick={()=>void start(undefined,poolSize,selection,true)}>重新采集</button><button className="ss-market-reset-btn" type="button" disabled={queryLocked} onClick={()=>{onSelectionChange({nodeIdPath:'',fromMonth:maxMonth,toMonth:maxMonth});setPoolSize(100);}}>重置条件</button></div>
   </div></form>
  <MarketAdminContent><details className="market-shape-query-footer"><summary>恢复已有形态任务</summary><form onSubmit={restore} className="market-theme-actions"><label>形态任务编号 <input value={restoreId} onChange={e => setRestoreId(e.target.value)} disabled={busy}/></label><button className="ghost-btn" disabled={busy}>读取任务</button></form><p>恢复和切换版本只读取已保存结果。</p>
  {runId && <button type="button" className="ghost-btn" disabled={busy} onClick={() => setReload(n => n + 1)}>刷新形态状态</button>}</details></MarketAdminContent>
  {error && <p role="alert" className="market-research-error">{error}</p>}{readError && <p role="alert" className="market-research-error">{readError}；已保留当前显示内容，来源修改操作暂停。{lastReadAt&&` 最后成功读取：${lastReadAt}`}</p>}
 </section>
 {!run && <LaunchSection title="类目销量看板" description={`${marketSites.find(site=>site.code===(selection.marketplace??'US'))?.label??selection.marketplace} · 输入类目节点和研究月份后筛选市场`} badge={<span className="source-badge">商品来源</span>}><div className="pending-box"><strong>{runId?'正在读取形态任务…':'等待指定类目节点'}</strong><span>采集完成后直接查看看板，在 TOP 销售表修改形态即可更新统计；保存可保留当前版本。</span></div></LaunchSection>}
 {run && run.referenceHistory!==undefined?<MarketShapeReferencePanel key={run.id} run={run} readError={readError} starting={busy} onRefresh={()=>setReload(n=>n+1)} onPoolSizeChange={size=>{setPoolSize(size);const nextSelection={marketplace:run.scope.marketplace,nodeIdPath:run.scope.nodeIdPath,fromMonth:run.scope.fromMonth,toMonth:run.scope.toMonth};onSelectionChange(nextSelection);void start(undefined,size,nextSelection);}}/>:run && <>{run.categoryDashboard&&choice==='latest'?<MarketShapeCategoryDashboard data={run.categoryDashboard} node={run.scope.nodeIdPath} marketplace={run.scope.marketplace} poolSize={run.source?.products.length??0}/>:report?<MarketShapeDashboard report={report}/>:choice==='latest'&&run.source?.summary?<MarketShapeDashboard report={run.source.summary}/>:null}
   {!report && !run.source?.summary && <LaunchSection title="类目销量看板" description="共同可比商品销量与历史趋势" badge={<span className="source-badge">待保存统计版本</span>}><div className="pending-box"><strong>{run.source?'等待人工确认并保存':'等待有效商品来源'}</strong><span>报告位置保留，当前尚无已保存可比统计。</span></div></LaunchSection>}
 {run.source && <MarketShapeProductTable run={run} selected={selected} assignments={assignments} disabled={busy || !!readError || run.status==='cancelled'} onSelected={setSelected} onAssignment={(asin,label)=>setAssignments(old=>({...old,[asin]:label}))} bands={bands}/>}
 <section className="card market-shape-controls market-shape-revision-controls"><h3>人工确认与统计版本</h3>
 <MarketAdminContent><details className="market-shape-task-details"><summary>{active(run) && <span className="market-theme-spinner" aria-hidden="true"/>}{shapeRunSummary(run)}</summary>
  <p>本任务范围：{run.scope.marketplace} · {run.scope.nodeIdPath} · {run.scope.fromMonth} 至 {run.scope.toMonth}</p><p className="market-research-note">样本使用供应商返回的商品池，尚未核验为 BSR 前 {run.params.poolSize} 名。{run.sourcePolicy?'站点和月份按接口查询范围绑定；币种依据供应商站点定义，响应回显另行记录。':'来源未确认单位或周期的原值不参与可比统计。'}</p>
  <ul className="market-theme-steps">{run.steps.filter(s => s.current).map(s => <li key={s.id}>{s.asin ? `${s.asin} · ` : ''}{s.month ? `${s.month} · ` : ''}{s.categoryMetric?categoryNames[s.categoryMetric]:stepNames[s.kind] ?? '后台步骤'}：{statusNames[s.status]}{s.errorCode ? `（${stepErrors[s.errorCode] ?? s.errorCode}）` : ''}{s.canRetry && <button className="ghost-btn" disabled={busy || !!readError} onClick={() => void action('retry', s)}>重试此步骤</button>}</li>)}</ul>
  {active(run) && <button className="ghost-btn" disabled={busy || !!readError} onClick={() => void action('cancel')}>取消形态任务</button>}
  </details></MarketAdminContent>
  {run.source && <>
   {parent !== (run.latestRevision?.revisionId ?? null) && <p role="status">已有较新版本。当前草稿仍基于原版本，可先保留修改或重新载入。</p>}
   <div className="market-theme-actions"><label>参考价格带下界 <input value={bands} onChange={e => setBands(e.target.value)} disabled={busy}/></label><label>修订说明 <input value={note} maxLength={500} onChange={e => setNote(e.target.value)} disabled={busy}/></label><button className="primary-btn" disabled={busy || !!readError || !selected.length || run.status === 'cancelled'} onClick={() => void save()}>确认并重新计算</button><button className="ghost-btn" disabled={busy || !!readError} onClick={() => loadDraft(run)}>重新载入最新草稿</button></div><p className="market-research-note">例：0,20,40 分为 [0,20)、[20,40)、[40,+∞)。保存保留旧版本，未分类商品保留为单独分组；修改形态不会重新抓取。</p>
  </>}
 </section>
 {run.history.length > 0 && <label className="market-theme-version">形态报告版本 <select aria-label="形态报告版本" value={choice} onChange={e => setChoice(e.target.value)}><option value="latest">最新保存版本</option>{run.history.map(r => <option key={r.revisionId} value={r.revisionId}>版本 {r.ordinal} · {r.createdAt}</option>)}</select></label>}
 {historyError ? <p role="alert" className="market-research-error">{historyError}</p> : report ? <MarketShapeReport report={report} showDashboard={false} presentation={presentation?.revisionId === report.revisionId ? presentation : null} semanticSkipped={run.semanticStatus==='skipped'}/> : <section className="card market-shape-report"><h3>形态价格带报告</h3><p>{choice !== 'latest' ? '正在读取此版本…' : run.source?.products.length ? '请选择商品与人工形态，确认后保存统计报告。' : '等待有效商品来源；报告位置保留。'}</p></section>}
 {report&&run.semanticStatus!=='skipped'&&<MarketShapeExplanationSection key={`${run.id}/${report.revisionId}`} parentRunId={run.id} revisionId={report.revisionId} onPresentation={setPresentation} paused={!!readError} unavailableReason={analysisNotice?.runId===run.id&&analysisNotice.revisionId===report.revisionId?analysisNotice.reason:null}/>}
 </>}
 </div>;
}
