'use client';
import {assertMarketProductQueryWindow} from '../shared/market-product-source-policy';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MarketModuleIdSchema } from '../shared/market-module-contracts';
import type { MarketShapeRun, MarketShapePublicRevision } from '../shared/market-shape-public-contracts';
import { createShapeStudy, startShapeRun, readShapeRun, saveShapeRevisionAnalysis, readShapeRevision, retryShapeSteps, cancelShapeRun } from './lib/market-shape-browser';
import { MarketShapeReport } from './market-shape-report';
import {MarketShapeExplanationSection} from './market-shape-explanation-section';
type Selection = {
    nodeIdPath: string;
    fromMonth: string;
    toMonth: string;
};
const active = (run: MarketShapeRun) => run.steps.some(s => s.current && ['running', 'queued'].includes(s.status));
const stepNames: Record<string, string> = { 'collect-product-month': '商品采集', 'prepare-members': '固定商品池 / 准备形态输入', 'prepare-model-batches': '准备模型分析', 'model-batch': '形态建议' };
const stepErrors: Record<string, string> = { timeout: '等待上游超时', 'upstream-temporary': '上游暂不可用', 'invalid-data': '数据校验未通过', 'scope-mismatch': '来源范围不匹配', authentication: '来源认证失败', governance: '额度或调用策略限制', interrupted: '任务中断', internal: '处理失败', cancelled: '已取消' };
const statusNames: Record<string, string> = { queued: '排队中', running: '处理中', succeeded: '已完成', empty: '未返回数据', failed: '失败', cancelled: '已取消' };
const messages: Record<string, string> = { 'not-ready': '等待商品来源', unavailable: '模型暂不可用，可先人工确认并保存统计结果', running: '正在生成形态建议', partial: '部分形态建议不可用，可查看失败步骤或人工确认', complete: '形态建议已返回，需人工确认后才参与分组' };
function priceBands(value: string) { const n = value.split(/[,，]/).map(s => { if (!/^\d+(\.\d+)?$/.test(s.trim()))
    throw Error('价格带请输入逗号分隔的非负数字，例如 0,20,40。'); return Number(s.trim()); }); if (n.length > 32 || n.some((v, i) => !Number.isFinite(v) || i > 0 && v <= n[i - 1]))
    throw Error('价格带边界须从小到大排列且不能重复。'); return n.map((minInclusive, i) => ({ id: `band-${i + 1}`, minInclusive, maxExclusive: n[i + 1] ?? null })); }
export function MarketShapeSection({ selection, onSelectionChange, maxMonth }: {
    selection: Selection;
    onSelectionChange: (next: Partial<Selection>) => void;
    maxMonth: string;
}) {
    const [runId, setRunId] = useState(''), [restoreId, setRestoreId] = useState(''), [run, setRun] = useState<MarketShapeRun | null>(null), [reload, setReload] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [readError, setReadError] = useState<string | null>(null);
    const [taxonomy, setTaxonomy] = useState(''), [poolSize, setPoolSize] = useState(100), [bands, setBands] = useState('0,20,40'), [selected, setSelected] = useState<string[]>([]), [assignments, setAssignments] = useState<Record<string, string>>({}), [parent, setParent] = useState<string | null>(null), [note, setNote] = useState('');
    const [choice, setChoice] = useState('latest'), [historic, setHistoric] = useState<MarketShapePublicRevision | null>(null), [historyError, setHistoryError] = useState<string | null>(null);
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
        const read = async () => { try {
            const next = await readShapeRun(runId, abort.signal);
            if (abort.signal.aborted)
                return;
            setRun(next);
            setReadError(null);
            if (active(next))
                timer = setTimeout(() => void read(), 4000);
        }
        catch (e) {
            if (!abort.signal.aborted)
                setReadError(e instanceof Error ? e.message : '读取状态失败');
        } };
        void read();
        return () => { abort.abort(); if (timer)
            clearTimeout(timer); };
    }, [runId, reload]);
    function loadDraft(next: MarketShapeRun) { const r = next.latestRevision; setSelected(r?.selectedAsins ?? next.source?.products.map(p => p.asin) ?? []); setAssignments(Object.fromEntries((r?.assignments ?? []).map(a => [a.asin, a.labelId ?? '']))); setParent(r?.revisionId ?? null); setNote(r?.note ?? ''); setBands(r ? r.bands.map(b => b.minInclusive).join(',') : '0,20,40'); draftRun.current = next.id; pendingSave.current = null; }
    useEffect(() => { if (run?.source && draftRun.current !== run.id)
        loadDraft(run); }, [run]);
    useEffect(() => { setHistoric(null); setHistoryError(null); if (!runId || choice === 'latest')
        return; const abort = new AbortController(); void readShapeRevision(runId, choice, abort.signal).then(r => { if (!abort.signal.aborted)
        setHistoric(r); }, e => { if (!abort.signal.aborted)
        setHistoryError(e instanceof Error ? e.message : '读取报告失败'); }); return () => abort.abort(); }, [runId, choice]);
    const remember = (id: string) => { const url = new URL(window.location.href); url.searchParams.set('shapeRun', id); url.searchParams.set('themeView', 'shapes'); window.history.replaceState(window.history.state, '', url); setRestoreId(id); };
    async function start(e: FormEvent) {
        e.preventDefault();
        const signal = owner.current?.signal;
        if (!signal || busy)
            return;
        setBusy(true);
        setError(null);
        try {
            assertMarketProductQueryWindow(selection,new Date());
            const labels = taxonomy.split('\n').filter(s => s.trim()).map((line, i) => { const split = line.indexOf('|'); if (split < 1 || !line.slice(split + 1).trim())
                throw Error('每行请填写“形态名称|判断依据”。'); return { labelId: `shape-${i + 1}`, label: line.slice(0, split).trim(), definition: line.slice(split + 1).trim() }; });
            if (!labels.length)
                throw Error('请先填写本次形态目录，模型会据此提出建议。');
            const scope = { ...selection, marketplace: 'US' as const, currency: 'USD' as const }, params = { poolSize, newProductMonths: 6, catalog: { task: 'market-product-shape-suggestion', taxonomyVersion: 'manual-taxonomy/v1', allowedLabels: labels } }, hash = JSON.stringify({ scope, params });
            const command = pendingStart.current?.hash === hash ? pendingStart.current : { hash, studyKey: crypto.randomUUID(), runKey: crypto.randomUUID() };
            pendingStart.current = command;
            const study = await createShapeStudy(scope, command.studyKey, signal), next = await startShapeRun(study.id, params, command.runKey, signal);
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
            const request = { referenceAttemptId: run.source.referenceAttemptId, historyAttemptIds: run.source.historyAttemptIds, expectedParentRevisionId: parent, selectedAsins: selected, taxonomyVersion: catalog.taxonomyVersion, labels: catalog.labels, assignments: selected.filter(asin => Object.hasOwn(assignments, asin)).map(asin => ({ asin, labelId: assignments[asin] || null })), bands: priceBands(bands), note };
            const hash = JSON.stringify({ id: run.id, request }), command = pendingSave.current?.hash === hash ? pendingSave.current : { hash, key: crypto.randomUUID() };
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
            await retryShapeSteps(run.id, [{ stepId: step.id, failedAttemptId: step.latestAttemptId }], crypto.randomUUID(), signal);
        else
            await cancelShapeRun(run.id, crypto.randomUUID(), signal);
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
    const labels = run?.latestRevision?.labels ?? run?.params.catalog.allowedLabels ?? [], labelName = (id: string) => run?.params.catalog.allowedLabels.find(l => l.labelId === id)?.label ?? id;
    const report = choice === 'latest' ? run?.latestRevision : historic?.revisionId===choice?historic:null;
    return <div className="market-shape-workspace"><section className="card market-shape-controls"><h2>商品形态及价格带</h2><p>固定商品池，查看形态建议，人工确认后按观测参考价重新计算。</p>
  <form onSubmit={e => void start(e)}><div className="market-theme-actions"><label>类目节点 <input value={selection.nodeIdPath} onChange={e => onSelectionChange({ nodeIdPath: e.target.value })} required disabled={busy}/></label><label>起始月 <input type="month" value={selection.fromMonth} max={selection.toMonth} onChange={e => onSelectionChange({ fromMonth: e.target.value })} required disabled={busy}/></label><label>结束月 <input type="month" value={selection.toMonth} max={maxMonth} onChange={e => onSelectionChange({ toMonth: e.target.value })} required disabled={busy}/></label><label>商品池上限 <input type="number" min={1} max={100} value={poolSize} onChange={e => setPoolSize(Number(e.target.value))} disabled={busy}/></label></div>
   <label>本次形态目录（每行：名称|判断依据）<textarea value={taxonomy} onChange={e => setTaxonomy(e.target.value)} placeholder="例如：层架式|灯具带有储物或展示层架" rows={3} disabled={busy}/></label><button className="primary-btn" type="submit" disabled={busy}>{busy ? '提交中…' : '采集商品并生成形态建议'}</button></form>
  <details><summary>恢复已有形态任务</summary><form onSubmit={restore} className="market-theme-actions"><label>形态任务编号 <input value={restoreId} onChange={e => setRestoreId(e.target.value)} disabled={busy}/></label><button className="ghost-btn" disabled={busy}>读取任务</button></form><p>恢复和切换版本只读取已保存结果。</p></details>
  {error && <p role="alert" className="market-research-error">{error}</p>}{readError && <p role="alert" className="market-research-error">{readError}；已保留当前显示内容，变更操作暂停。</p>}
  {runId && <button type="button" className="ghost-btn" disabled={busy} onClick={() => setReload(n => n + 1)}>刷新形态状态</button>}
 </section>
 {run && <><section className="card market-shape-controls"><h3>{active(run) && <span className="market-theme-spinner" aria-hidden="true"/>}{run.status === 'cancelled' ? '任务已取消' : messages[run.suggestions.status]}</h3>
  <p>本任务范围：US · {run.scope.nodeIdPath} · {run.scope.fromMonth} 至 {run.scope.toMonth}</p><p className="market-research-note">样本使用供应商返回的商品池，尚未核验为 BSR 前 {run.params.poolSize} 名。{run.sourcePolicy?'站点和月份按接口查询范围绑定；USD依据供应商站点定义，响应回显另行记录。':'来源未确认单位或周期的原值不参与可比统计。'}</p>
  <ul className="market-theme-steps">{run.steps.filter(s => s.current).map(s => <li key={s.id}>{s.month ? `${s.month} · ` : ''}{stepNames[s.kind] ?? '后台步骤'}：{statusNames[s.status]}{s.errorCode ? `（${stepErrors[s.errorCode] ?? s.errorCode}）` : ''}{s.canRetry && <button className="ghost-btn" disabled={busy || !!readError} onClick={() => void action('retry', s)}>重试此步骤</button>}</li>)}</ul>
  {active(run) && <button className="ghost-btn" disabled={busy || !!readError} onClick={() => void action('cancel')}>取消形态任务</button>}
  {run.source && <><div className="market-shape-table" role="region" aria-label="形态人工确认表" tabIndex={0}><table><thead><tr><th>纳入统计</th><th>商品与观测原值</th><th>模型建议与依据</th><th>人工形态</th></tr></thead><tbody>{run.source.products.map(p => { const decision = run.suggestions.items.find(i => i.productId === p.asin)?.decision; return <tr key={p.asin}><td><input type="checkbox" aria-label={`选择 ${p.asin}`} checked={selected.includes(p.asin)} disabled={busy || !!readError || run.status === 'cancelled'} onChange={e => setSelected(old => e.target.checked ? [...old, p.asin] : old.filter(a => a !== p.asin))}/></td><td><strong>{p.asin}</strong><p>{p.title ?? '标题未知'}</p><small>价格原值 {p.price ?? '未知'} · 销量原值 {p.units ?? '未知'}</small></td><td>{decision?.status === 'supported' ? decision.candidates.map(c => <div key={c.labelId}><p>模型建议：{labelName(c.labelId)}</p><small>{c.evidence.map(e => e.quote).join('；')}</small></div>) : <span>{decision?.status === 'unknown' ? '证据不足，未给出形态' : '暂无建议'}</span>}</td><td><select aria-label={`${p.asin} 人工形态`} value={assignments[p.asin] ?? ''} disabled={busy || !!readError || run.status === 'cancelled'} onChange={e => setAssignments(old => ({ ...old, [p.asin]: e.target.value }))}><option value="">未分类</option>{labels.map(l => <option key={l.labelId} value={l.labelId}>{l.label}</option>)}</select></td></tr>; })}</tbody></table></div>
   {parent !== (run.latestRevision?.revisionId ?? null) && <p role="status">已有较新版本。当前草稿仍基于原版本，可先保留修改或重新载入。</p>}
   <div className="market-theme-actions"><label>参考价格带下界 <input value={bands} onChange={e => setBands(e.target.value)} disabled={busy}/></label><label>修订说明 <input value={note} maxLength={500} onChange={e => setNote(e.target.value)} disabled={busy}/></label><button className="primary-btn" disabled={busy || !!readError || !selected.length || run.status === 'cancelled'} onClick={() => void save()}>确认并重新计算</button><button className="ghost-btn" disabled={busy || !!readError} onClick={() => loadDraft(run)}>重新载入最新草稿</button></div><p className="market-research-note">例：0,20,40 分为 [0,20)、[20,40)、[40,+∞)。保存保留旧版本，未分类商品保留为单独分组；修改形态不会重新抓取。</p>
  </>}
 </section>
 {run.history.length > 0 && <label className="market-theme-version">形态报告版本 <select aria-label="形态报告版本" value={choice} onChange={e => setChoice(e.target.value)}><option value="latest">最新保存版本</option>{run.history.map(r => <option key={r.revisionId} value={r.revisionId}>版本 {r.ordinal} · {r.createdAt}</option>)}</select></label>}
 {historyError ? <p role="alert" className="market-research-error">{historyError}</p> : report ? <MarketShapeReport report={report}/> : <section className="card market-shape-report"><h3>形态价格带报告</h3><p>{choice !== 'latest' ? '正在读取此版本…' : run.source?.products.length ? '请选择商品与人工形态，确认后保存统计报告。' : '等待有效商品来源；报告位置保留。'}</p></section>}
 {report&&<MarketShapeExplanationSection key={`${run.id}/${report.revisionId}`} parentRunId={run.id} revisionId={report.revisionId} paused={!!readError} unavailableReason={analysisNotice?.runId===run.id&&analysisNotice.revisionId===report.revisionId?analysisNotice.reason:null}/>}
 </>}
 </div>;
}
