"use client";
import {MarketAdminTools,MarketAdminContent} from './market-admin-tools';
import {overviewMonthLabel} from '../shared/market-overview-period';
import { browserRequestId } from "./lib/browser-request-id";
import {publishUsagePage} from "./lib/usage-analytics-browser";
import { marketNavigation, marketViewFromParam, marketViewHref, type MarketView } from "./lib/market-navigation";
import {emptyMarketModuleSelection, marketModuleNodeQueryKey, readMarketModuleSelection, writeMarketModuleSelection, type IndependentMarketView, type MarketModuleSelection} from './lib/market-module-selection';
import {MarketSiteSchema} from "../shared/market-sites";
import {MarketSharedFavorites,type KeywordFavoriteInput} from "./market-shared-favorites";
import type {MarketFavorite} from "../shared/market-favorites-contracts";


import React, { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { MarketResearchScopeSchema, type MarketOverviewReport, type MarketResearchJob, type MarketResearchScope } from "../shared/market-research-contracts";
import { createMarketResearchHistoryReader, createMarketResearchJob, listMarketResearchJobs, retryMarketResearchJob } from "./lib/market-research-browser";
import { MarketThemeSection } from './market-theme-section';
import {MarketOverviewSection,type MarketOverviewController} from './market-overview-section';
import {MarketShapeSection} from './market-shape-section';
import {MarketKeywordSection} from './market-keyword-section';

import {MarketOverviewQuery} from "./market-overview-query";
import {LaunchSection} from "./launch-section";
import {matchesOverviewBasicScope,type OverviewBasicContext} from './lib/market-overview-basic-scope';
import {MarketLinkedStatus} from './market-linked-status';
import {useMarketLinkedAnalysis} from './lib/use-market-linked-analysis';
import {linkedModules,type MarketLinkedRequest,type LinkedModule} from '../shared/market-linked-contracts';

const statusLabels: Record<MarketResearchJob["status"], string> = {
  queued: "排队中", running: "采集中", succeeded: "采集完成", partial: "部分数据可用", failed: "采集失败",
};

export function previousCompleteMonth(now = new Date()) {
  // Match the service's UTC calendar when deciding which months are complete.
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function canRetryMarketResearchJob(job: MarketResearchJob) {
  return job.status === "failed" && job.error?.retryable === true && job.attempts < 3;
}

function displayNumber(value: number | null, money = false, currency = "USD") {
  if (value == null || !Number.isFinite(value)) return "未知";
  return money
    ? new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 2 }).format(value)
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function displayTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

export function MarketOverviewResult({ report, onOpenReport }: { report: MarketOverviewReport; onOpenReport?:()=>void }) {

  const numeric=(value:number|null,money=false)=>displayNumber(value,money,report.currency);
  const metrics = report.metrics, table = report.tableMetrics;
  const percent=(value:number|null|undefined)=>value==null?'未知':`${numeric(value)}%`;
  const extra=(key:keyof NonNullable<MarketOverviewReport['tableMetrics']>,money=false)=>numeric(table?.[key]??null,money);
  const groups: Array<{ title: string; fields: Array<[string, number | null, boolean?]> }> = [
    { title: "样本规模与销售", fields: [["样本商品数", metrics.sampleProducts], ["品牌数", metrics.brands], ["卖家数", metrics.sellers], ["样本销量", metrics.totalUnits], ["样本销售额", metrics.totalRevenue, true], ["平均单品销量", metrics.avgUnits]] },
    { title: "价格与评价", fields: [["平均价格", metrics.avgPrice, true], ["平均评分数", metrics.avgRatings], ["平均评分（满分 5）", metrics.avgRating]] },
    { title: `上架 ${report.scope.newProductMonths} 个月内的新品`, fields: [["新品数量", metrics.newCount], ["新品平均价格", metrics.newAvgPrice, true], ["新品平均销量", metrics.newAvgUnits]] },
  ];
  return <section className="market-research-result" aria-label="市场总览结果">
    <div className="market-research-result-heading"><div><h3>{report.categoryName || `类目 ${report.nodeId}`}</h3><p>{report.scope.marketplace} · {overviewMonthLabel(report.scope.month)} · Node {report.nodeId}</p></div><p>采集时间（北京时间）<br />{displayTime(report.collectedAt)}</p></div>
    <p className="market-research-note">以下为上游返回的样本指标，不代表整个市场。未知表示本次未获得该指标。</p>
    <div className="ss-niche-table-wrap" role="region" aria-label="类目市场概览表" tabIndex={0}><table className="ss-niche-table"><thead><tr>{['#','细分市场','样本数量','月总销量','月均销量 / 头部','月均销售额 / 头部','平均评分数 / 星级','平均 BSR / 头部','平均卖家数 / 均价','卖家类型','集中度','新品数量 / 占比','商品总数','退货率 / 同类目','操作'].map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody><tr><td>1</td><td className="ss-niche-name"><b>{report.categoryName||report.nodeId}</b></td><td><div>商品 {numeric(metrics.sampleProducts)}</div><small>品牌 {numeric(metrics.brands)} · 卖家 {numeric(metrics.sellers)}</small></td><td className="ss-niche-accent">{numeric(metrics.totalUnits)}</td><td>{numeric(metrics.avgUnits)}<small>头部 {extra('hlAvgUnits')}</small></td><td>{extra('avgRevenue',true)}<small>头部 {extra('hlAvgRevenue',true)}</small></td><td>{numeric(metrics.avgRatings)}<small>{numeric(metrics.avgRating)}</small></td><td>{extra('avgBsr')}<small>头部 {extra('hlAvgBsr')}</small></td><td>{extra('avgSellers')}<small>{numeric(metrics.avgPrice,true)}</small></td><td>FBA {percent(table?.fbaProportion)}<small>自营 {percent(table?.amazonSelfProportion)} · FBM {percent(table?.fbmProportion)}</small></td><td>{table?<>商品 {percent(table.productCrn)}<small>品牌 {percent(table.brandCrn)} · 卖家 {percent(table.sellerCrn)}</small></>:<>单位待确认<small>原值见详情</small></>}</td><td>{numeric(metrics.newCount)}<small>占比 {percent(table?.newRatio)}</small></td><td>{extra('totalProducts')}</td><td>{percent(table?.returnRatio)}<small>同类目 {percent(table?.avgReturnRatio)}</small></td><td className="ss-niche-ops">{onOpenReport&&<button type="button" onClick={onOpenReport}>查看市场分析报告</button>}</td></tr></tbody></table></div>
    <details className="market-research-boundaries"><summary>完整基础指标与原始比例</summary>
    {groups.map(group => <section key={group.title} className="market-research-metric-group"><h4>{group.title}</h4><dl className="market-research-metrics">{group.fields.map(([label, value, money]) => <div key={label}><dt>{label}</dt><dd>{numeric(value, money)}</dd></div>)}</dl></section>)}
    <section className="market-research-metric-group"><h4>头部 Top {report.scope.headTopN} 集中度</h4><p className="market-research-note">{table?'上游比例原值保留如下；表内百分比沿用原版接口换算规则。':'上游比例原值（单位待确认）；暂不据此判断集中程度。'}</p><dl className="market-research-metrics">
      {[["商品", metrics.productConcentrationRaw], ["品牌", metrics.brandConcentrationRaw], ["卖家", metrics.sellerConcentrationRaw]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value == null ? "未知" : String(value)}</dd></div>)}
    </dl></section>
    </details>
    {report.issues.length > 0 && <div className="market-research-notice" role="status"><h4>部分数据未能取得</h4><ul>{report.issues.map((issue, index) => <li key={`${issue.dataset}-${index}`}>{issue.message}</li>)}</ul></div>}
    {report.boundaries.length > 0 && <details className="market-research-boundaries"><summary>数据口径与范围</summary><ul>{report.boundaries.map((item, index) => <li key={index}>{item}</li>)}</ul><p>类目路径：{report.nodeIdPath}</p><p>来源：卖家精灵 · 已取得 {report.evidence.length} 份上游响应。</p></details>}
  </section>;
}

function MarketResearchWorkspace({scope,setScope,fromMonth,setFromMonth,showAuditDetails=false,onLinkedSubmit,linkedBusy=false}:{scope:MarketResearchScope;setScope:React.Dispatch<React.SetStateAction<MarketResearchScope>>;fromMonth:string;setFromMonth:(month:string)=>void;showAuditDetails?:boolean;onLinkedSubmit?:(request:MarketLinkedRequest)=>Promise<void>;linkedBusy?:boolean}) {
  const overviewController=useRef<MarketOverviewController|null>(null);
  const [jobs, setJobs] = useState<MarketResearchJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reportContext,setReportContext]=useState<OverviewBasicContext>({status:'loading'});
  const [basicOverride,setBasicOverride]=useState<{id:string;runId:string|null}|null>(null);
  const contextRunId=reportContext.status==='ready'?reportContext.runId:null;
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const reading = useRef(0);
  const historyReader = useRef(createMarketResearchHistoryReader());
  const revision = useRef(0);
  const writing = useRef(false);
  const submission = useRef<{ scope: string; key: string } | null>(null);

  const refresh = useCallback(async () => {
    const owner = controller.current;
    if (!owner || owner.signal.aborted) return;
    await historyReader.current.run(owner.signal, async () => {
      const requestId = ++reading.current;
      const currentRevision = revision.current;
      try {
        const rows = await listMarketResearchJobs(owner.signal);
        if (owner !== controller.current || owner.signal.aborted || currentRevision !== revision.current || requestId !== reading.current) return;
        setJobs(rows);
        setSelectedId(current => rows.some(item => item.id === current) ? current : rows[0]?.id ?? null);
        setError(null);
      } catch (cause) {
        if (owner !== controller.current || owner.signal.aborted || currentRevision !== revision.current || requestId !== reading.current) return;
        setError(cause instanceof Error ? cause.message : "读取采集历史失败。");
      } finally {
        if (owner === controller.current && !owner.signal.aborted && requestId === reading.current) setLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    const owner = new AbortController();
    controller.current = owner;
    void refresh();
    return () => { owner.abort(); controller.current = null; submission.current = null; };
  }, [refresh]);

  const hasActiveJobs = jobs.some(job => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = setInterval(() => { if (!writing.current) void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [hasActiveJobs, refresh]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = MarketResearchScopeSchema.safeParse(scope);
    if (!parsed.success || scope.month!=='last30'&&scope.month > previousCompleteMonth()) { setError("请输入有效的数字类目节点或冒号分隔的路径，并选择最近30天或已结束的月份。"); return; }
    if(onLinkedSubmit){try{setError(null);await onLinkedSubmit({scope:parsed.data,fromMonth:fromMonth>parsed.data.month?parsed.data.month:fromMonth});}catch{/* The linked panel owns submission errors. */}return;}
    const serialized = JSON.stringify(parsed.data);
    await mutate(signal => {
      if (submission.current?.scope !== serialized) submission.current = { scope: serialized, key: browserRequestId() };
      return createMarketResearchJob(parsed.data, submission.current.key, signal);
    }, true);
  }

  async function mutate(operation: (signal: AbortSignal) => Promise<MarketResearchJob>, creating = false) {
    const owner = controller.current;
    if (!owner || owner.signal.aborted || writing.current) return;
    writing.current = true;
    revision.current += 1;
    setSubmitting(true);
    setError(null);
    try {
      const job = await operation(owner.signal);
      if (owner !== controller.current || owner.signal.aborted) return;
      revision.current += 1;
      setJobs(current => [job, ...current.filter(item => item.id !== job.id)].slice(0, 30));
      setSelectedId(job.id);
      setBasicOverride({id:job.id,runId:contextRunId});
      if (creating) submission.current = null;
    } catch (cause) {
      if (owner !== controller.current || owner.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "提交失败，请稍后重试。");
    } finally {
      if (owner === controller.current && !owner.signal.aborted) { writing.current = false; setSubmitting(false); }
    }
  }

  const explicit=basicOverride?.runId===contextRunId?jobs.find(job=>job.id===basicOverride.id):undefined;
  const selected=explicit??(reportContext.status==='ready'?jobs.find(job=>matchesOverviewBasicScope(job,reportContext.scope)):reportContext.status==='idle'?jobs.find(job=>job.id===selectedId):undefined)??null;
  const activeReport=!explicit&&reportContext.status==='ready'&&reportContext.report?reportContext.report:selected?.report;
  const mismatched=!!selected&&reportContext.status==='ready'&&!matchesOverviewBasicScope(selected,reportContext.scope);
  return <div className="market-research-page">
    <MarketOverviewQuery scope={scope} onChange={change=>setScope(current=>({...current,...change}))} latest={previousCompleteMonth()} busy={submitting||linkedBusy} onSubmit={event=>void submit(event)} onReset={()=>{setScope({marketplace:'US',nodeQuery:'',month:previousCompleteMonth(),headTopN:10,newProductMonths:6});setFromMonth(previousCompleteMonth());setError(null);}} error={error}/>
    {onLinkedSubmit&&<p className="market-research-note" role="note">点击“筛选市场”将同步站点、类目与研究月份，并启动四个模块。联动支持完整自然月；“最近30天”请在总览分析设置中单独分析。</p>}
    <LaunchSection title="类目节点市场概览" description={selected?`${selected.scope.marketplace} · ${overviewMonthLabel(selected.scope.month)} · Node ${selected.scope.nodeQuery} · 头部 Top${selected.scope.headTopN}`:'在上方选择月份和类目后点击「筛选市场」，支持最近30天或完整自然月。'} badge={<span className="source-badge">卖家精灵 MCP</span>}>
      {mismatched&&<MarketAdminContent><div className="market-research-notice" role="status"><strong>基础概览与下方总览报告范围不同</strong><p>你正在查看其他基础采集记录，下方历史报告保持原样。</p><button className="ghost-btn" type="button" onClick={()=>setBasicOverride(null)}>返回报告对应概览</button></div></MarketAdminContent>}
      {selected&&reportContext.status==='failed'&&<p className="market-research-notice">未能确认历史报告范围，当前仅展示手动选择的基础记录。</p>}
      {activeReport?<MarketOverviewResult report={activeReport} onOpenReport={()=>{const nodeIdPath=activeReport.nodeIdPath;setScope({...activeReport.scope,nodeQuery:nodeIdPath});overviewController.current?.openReport({...activeReport.scope,nodeQuery:nodeIdPath});}}/>:<div className="pending-box" role="status"><strong>{submitting||selected?.status==='queued'||selected?.status==='running'?'正在从卖家精灵拉取':selected?.status==='failed'?'卖家精灵暂无可用结果':reportContext.status==='loading'||loading?'正在匹配历史报告的基础概览':reportContext.status==='failed'?'未能确认历史报告范围':reportContext.status==='ready'?(error?'基础概览暂不可用':'最近30条采集历史中没有与该总览匹配的基础记录'):'等待指定类目节点'}</strong><span>{selected?.error?.message??(reportContext.status!=='idle'?'下方总览报告和采集历史会保留；读取不会自动重新采集。':'已有数据和历史版本会保留；没有来源的指标不会填零。')}</span></div>}
    <MarketOverviewSection controller={overviewController} onContextChange={setReportContext} scope={scope} fromMonth={fromMonth} onFromMonth={setFromMonth} showAuditDetails={showAuditDetails} categoryName={jobs.find(job=>job.report?.nodeIdPath===scope.nodeQuery&&job.scope.marketplace===scope.marketplace)?.report?.categoryName} onRestoreScope={run=>{setScope({marketplace:run.scope.marketplace,nodeQuery:run.scope.nodeIdPath,month:run.scope.overviewPeriod??run.scope.toMonth,headTopN:run.params.headTopN,newProductMonths:run.params.newProductMonths});setFromMonth(run.scope.fromMonth);}}/>
    </LaunchSection>
    <MarketAdminContent><details className="card market-reference-history"><summary>采集历史与状态</summary><div className="market-research-body"><aside className="card market-research-history"><div className="section-head"><h3>采集历史</h3><button className="ghost-btn" type="button" disabled={submitting} onClick={() => void refresh()}>刷新</button></div>
      <p className="market-research-note">最近 30 次，可刷新页面恢复结果。</p>
      {loading ? <p role="status">正在读取…</p> : jobs.length === 0 ? <p>暂无采集记录。</p> : <ol>{jobs.map(job => <li key={job.id}><button type="button" aria-pressed={job.id === selected?.id} onClick={() => {setSelectedId(job.id);setBasicOverride({id:job.id,runId:contextRunId});}}><strong>{job.report?.categoryName || `类目 ${job.scope.nodeQuery}`}</strong><span>{overviewMonthLabel(job.scope.month)} · Top {job.scope.headTopN} · 新品 {job.scope.newProductMonths} 个月</span><span className={`market-research-status ${job.status}`}>{statusLabels[job.status]}</span><small>{displayTime(job.createdAt)}</small></button></li>)}</ol>}
    </aside><section className="card market-research-detail" aria-live="polite">{selected ? <><div className="market-research-job-heading"><span className={`market-research-status ${selected.status}`}>{statusLabels[selected.status]}</span><span>已尝试 {selected.attempts} 次</span></div>
      {(selected.status === "queued" || selected.status === "running") && <p role="status">{selected.status === "queued" ? "任务正在排队，可稍后回来查看。" : "正在获取类目数据，状态会自动更新。"}</p>}
      {selected.error && <div className="market-research-notice"><p>{selected.error.message}</p>{canRetryMarketResearchJob(selected) && <button className="primary-btn" type="button" disabled={submitting} onClick={() => void mutate(signal => retryMarketResearchJob(selected.id, signal))}>重试采集</button>}</div>}
      {selected.report && <p className="market-research-note">所选记录的基础指标显示在上方「类目节点市场概览」。</p>}
    </> : <div className="market-research-empty"><h3>从一个类目开始</h3><p>输入类目节点，点击“筛选市场”，或从历史中选择结果。</p></div>}</section></div></details></MarketAdminContent>
  </div>;
}

type MarketNavigationProps = { view?: MarketView; onViewChange?: (view: MarketView) => void };

function MarketResearchModules({ view: controlledView, onViewChange, showAuditDetails=false,sessionIdentity }: MarketNavigationProps & {showAuditDetails?:boolean;sessionIdentity:string}) {
  const [restoreVersion,setRestoreVersion]=useState(0),[favoriteRequest,setFavoriteRequest]=useState(0);
  const [keywordInput,setKeywordInput]=useState<KeywordFavoriteInput|undefined>(),[restoredKeywordInput,setRestoredKeywordInput]=useState<KeywordFavoriteInput|undefined>();
  const [localView,setView]=useState<MarketView>('overview');
  const view = controlledView ?? localView;
  const [viewRestored,setViewRestored]=useState(false);
  useEffect(()=>{if(viewRestored)publishUsagePage(view==="shapes"?"market-shapes":view==="keywords"?"market-keywords":view==="themes"?"market-themes":"market-overview")},[view,viewRestored]);
  const [scope,setScope]=useState<MarketResearchScope>({marketplace:'US',nodeQuery:'',month:previousCompleteMonth(),headTopN:10,newProductMonths:6}),[fromMonth,setFromMonth]=useState(previousCompleteMonth());
  const [moduleSelections,setModuleSelections]=useState<Record<IndependentMarketView,MarketModuleSelection>>(()=>({
    shapes:emptyMarketModuleSelection(previousCompleteMonth()),
    keywords:emptyMarketModuleSelection(previousCompleteMonth()),
    themes:emptyMarketModuleSelection(previousCompleteMonth()),
  }));
  const linkedApplied=useRef(new Map<string,{initial:Record<string,string|null>;applied:string[]}>());
  const linked=useMarketLinkedAnalysis(sessionIdentity,(batch,apply)=>{
    const url=new URL(window.location.href),params=url.searchParams;
    const selection={marketplace:batch.request.scope.marketplace,nodeIdPath:batch.resolvedNodeIdPath??batch.request.scope.nodeQuery,fromMonth:batch.request.fromMonth,toMonth:batch.request.scope.month};
    const keys={overview:'overviewRun',shapes:'shapeRun',keywords:'keywordRun',themes:'themeRun'} as const;let changed=false;
    const storageKey=`market-linked-view:${sessionIdentity}:${batch.id}`;
    type Applied={initial:Record<string,string|null>;applied:string[]};let saved:Applied|null=linkedApplied.current.get(batch.id)??null;
    if(!saved)try{saved=JSON.parse(sessionStorage.getItem(storageKey)??'null');}catch{}
    if(apply&&!saved){const alreadyApplied=params.get('linkedScopeApplied')===batch.id;saved={initial:Object.fromEntries(linkedModules.map(module=>[module,params.get(keys[module])])),applied:alreadyApplied?linkedModules.filter(module=>params.has(keys[module])):[]};if(!alreadyApplied){for(const module of ['shapes','keywords','themes'] as const)writeMarketModuleSelection(params,module,selection);setModuleSelections({shapes:selection,keywords:selection,themes:selection});params.set('linkedScopeApplied',batch.id);}}
    for(const module of linkedModules){
      const runId=batch.modules[module].runId,key=keys[module];if(!runId||saved?.applied.includes(module))continue;
      const current=module==='overview'?{marketplace:params.get('marketSite'),nodeIdPath:params.get('marketNode'),fromMonth:params.get('marketFrom')??batch.request.fromMonth,toMonth:params.get('marketMonth')}:readMarketModuleSelection(params,module,previousCompleteMonth(),false);
      const matches=current.marketplace===selection.marketplace&&(current.nodeIdPath===selection.nodeIdPath||current.nodeIdPath===batch.request.scope.nodeQuery)&&current.fromMonth===selection.fromMonth&&current.toMonth===selection.toMonth;
      const unchanged=saved?params.get(key)===saved.initial[module]:!params.has(key);
      if(matches&&unchanged&&(module==='overview'||module!==view)&&params.get(key)!==runId){params.set(key,runId);changed=changed||module===view;if(module==='overview'){params.set('marketNode',selection.nodeIdPath);setScope(current=>({...current,nodeQuery:selection.nodeIdPath}));}else{writeMarketModuleSelection(params,module,selection);setModuleSelections(current=>({...current,[module]:selection}));}}
      if(saved)saved.applied.push(module);
    }
    if(saved){linkedApplied.current.set(batch.id,saved);try{sessionStorage.setItem(storageKey,JSON.stringify(saved));}catch{}}
    window.history.replaceState(window.history.state,'',url);
    if(changed)setRestoreVersion(value=>value+1);
  });
  useEffect(()=>{const url=new URL(window.location.href),params=url.searchParams;setView(marketViewFromParam(params.get('themeView')));
    setViewRestored(true);
    const initialView=marketViewFromParam(params.get('themeView'));
    const latest=previousCompleteMonth();
    const restoredModules={
      shapes:readMarketModuleSelection(params,'shapes',latest,initialView==='shapes'),
      keywords:readMarketModuleSelection(params,'keywords',latest,initialView==='keywords'),
      themes:readMarketModuleSelection(params,'themes',latest,initialView==='themes'),
    };
    setModuleSelections(restoredModules);
    const legacyModule=initialView!=='overview'&&!params.has(marketModuleNodeQueryKey(initialView))&&params.has('marketNode');
    if(legacyModule){
      writeMarketModuleSelection(params,initialView,restoredModules[initialView]);
      for(const key of ['marketSite','marketNode','marketMonth','marketFrom','marketHead','marketNew'])params.delete(key);
      window.history.replaceState(window.history.state,'',url);
    }else{
      setScope(current=>({...current,marketplace:MarketSiteSchema.safeParse(params.get('marketSite')).data??'US'}));
      const parsed=MarketResearchScopeSchema.safeParse({marketplace:MarketSiteSchema.safeParse(params.get('marketSite')).data??'US',nodeQuery:params.get('marketNode')??'',month:params.get('marketMonth')??previousCompleteMonth(),headTopN:Number(params.get('marketHead')??10),newProductMonths:Number(params.get('marketNew')??6)});
      if(parsed.success&&(parsed.data.month==='last30'||parsed.data.month<=latest)){setScope(parsed.data);const from=params.get('marketFrom');setFromMonth(from&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(from)&&from<=parsed.data.month?from:parsed.data.month==='last30'?latest:parsed.data.month);}
    }
  },[]);
  const rememberScope=(next:MarketResearchScope)=>{const url=new URL(window.location.href);url.searchParams.set('marketSite',next.marketplace);url.searchParams.set('marketNode',next.nodeQuery);url.searchParams.set('marketMonth',next.month);url.searchParams.set('marketHead',String(next.headTopN));url.searchParams.set('marketNew',String(next.newProductMonths));window.history.replaceState(window.history.state,'',url);};
  const updateScope:React.Dispatch<React.SetStateAction<MarketResearchScope>>=next=>setScope(current=>{const updated=typeof next==='function'?next(current):next;rememberScope(updated);return updated;});
  const updateFrom=(month:string)=>{setFromMonth(month);const url=new URL(window.location.href);url.searchParams.set('marketFrom',month);window.history.replaceState(window.history.state,'',url);};
  useEffect(()=>{if(fromMonth>scope.month)updateFrom(scope.month);},[scope.month,fromMonth]);
  const changeSelection=(targetView:IndependentMarketView,next:Partial<MarketModuleSelection>)=>setModuleSelections(current=>{
    const selection={...current[targetView],...next};
    if(selection.fromMonth>selection.toMonth)selection.fromMonth=selection.toMonth;
    const url=new URL(window.location.href);writeMarketModuleSelection(url.searchParams,targetView,selection);window.history.replaceState(window.history.state,'',url);
    return {...current,[targetView]:selection};
  });
  const selectedScope=view==='overview'?{marketplace:scope.marketplace,nodeIdPath:scope.nodeQuery,fromMonth,toMonth:scope.month}:moduleSelections[view];
  const favoriteQuery:Record<string,string>={marketMonth:selectedScope.toMonth,marketFrom:selectedScope.fromMonth,marketHead:String(scope.headTopN),marketNew:String(scope.newProductMonths),marketSite:selectedScope.marketplace,...(selectedScope.nodeIdPath?{marketNode:selectedScope.nodeIdPath}:{})};
  function restoreFavorite(favorite:MarketFavorite){
    const url=new URL(window.location.href),params=url.searchParams;
    params.set('tab','market-overview');params.set('themeView',favorite.module);
    const runKeys={overview:'overviewRun',shapes:'shapeRun',keywords:'keywordRun',themes:'themeRun'} as const;
    const runKey=runKeys[favorite.module];
    params.delete(runKey);
    if(favorite.module==='overview'){
      const next=MarketResearchScopeSchema.safeParse({marketplace:favorite.query.marketSite??'US',nodeQuery:favorite.query.marketNode??'',month:favorite.query.marketMonth??previousCompleteMonth(),headTopN:Number(favorite.query.marketHead??10),newProductMonths:Number(favorite.query.marketNew??6)});
      const restored=next.success?next.data:{marketplace:'US' as const,nodeQuery:'',month:previousCompleteMonth(),headTopN:10 as const,newProductMonths:6 as const};
      setScope(restored);setFromMonth(favorite.query.marketFrom??(restored.month==='last30'?previousCompleteMonth():restored.month));
      params.set('marketSite',restored.marketplace);params.set('marketNode',restored.nodeQuery);params.set('marketMonth',restored.month);params.set('marketFrom',favorite.query.marketFrom??(restored.month==='last30'?previousCompleteMonth():restored.month));params.set('marketHead',String(restored.headTopN));params.set('marketNew',String(restored.newProductMonths));
    }else if(favorite.query.marketNode){
      const targetView=favorite.module,selection:MarketModuleSelection={marketplace:favorite.query.marketSite??'US',nodeIdPath:favorite.query.marketNode,fromMonth:favorite.query.marketFrom??favorite.query.marketMonth??previousCompleteMonth(),toMonth:favorite.query.marketMonth??previousCompleteMonth()};
      setModuleSelections(current=>({...current,[targetView]:selection}));writeMarketModuleSelection(params,targetView,selection);
    }
    if(favorite.query[runKey])params.set(runKey,favorite.query[runKey]!);
    window.history.replaceState(window.history.state,'',url);
    setRestoredKeywordInput(favorite.keywordInput);setKeywordInput(favorite.keywordInput);setView(favorite.module);setRestoreVersion(value=>value+1);
    onViewChange?.(favorite.module);
    // The URL carries the saved run identity; do not invoke a collection action here.
  }
  function openLinked(module:LinkedModule){
    const batch=linked.batch,runId=batch?.modules[module].runId;if(!batch||!runId)return;
    const url=new URL(window.location.href),params=url.searchParams,keys={overview:'overviewRun',shapes:'shapeRun',keywords:'keywordRun',themes:'themeRun'} as const;
    params.set('themeView',module);params.set(keys[module],runId);
    if(module==='overview'){const next={...batch.request.scope,nodeQuery:batch.resolvedNodeIdPath??batch.request.scope.nodeQuery};setScope(next);setFromMonth(batch.request.fromMonth);params.set('marketSite',next.marketplace);params.set('marketNode',next.nodeQuery);params.set('marketMonth',next.month);params.set('marketFrom',batch.request.fromMonth);params.set('marketHead',String(next.headTopN));params.set('marketNew',String(next.newProductMonths));}
    else{const selection={marketplace:batch.request.scope.marketplace,nodeIdPath:batch.resolvedNodeIdPath??batch.request.scope.nodeQuery,fromMonth:batch.request.fromMonth,toMonth:batch.request.scope.month};writeMarketModuleSelection(params,module,selection);setModuleSelections(current=>({...current,[module]:selection}));}
    window.history.replaceState(window.history.state,'',url);setView(module);setRestoreVersion(value=>value+1);onViewChange?.(module);
  }
  return <div className="market-ui-reference">{controlledView===undefined&&<nav className="market-theme-actions market-theme-module-nav" aria-label="市场调研模块">{marketNavigation.map(({view:id,label})=><button type="button" className="ghost-btn" key={id} aria-pressed={view===id} onClick={()=>{if(onViewChange){onViewChange(id);return;}setView(id);window.history.replaceState(window.history.state,'',marketViewHref(id,new URLSearchParams(window.location.search)));}}>{label}</button>)}</nav>}
    <MarketSharedFavorites view={view} query={favoriteQuery} keywordInput={keywordInput} onRestore={restoreFavorite} saveRequest={favoriteRequest}/>
    <MarketLinkedStatus batch={linked.batch} error={linked.error} busy={linked.busy} onOpen={openLinked} onRetry={module=>void linked.retry(module)}/>
    <div key={restoreVersion}><MarketAdminTools key={view} enabled={showAuditDetails&&(view==='overview'||view==='shapes')}>{view==='overview'?<MarketResearchWorkspace scope={scope} setScope={updateScope} fromMonth={fromMonth} setFromMonth={updateFrom} showAuditDetails={showAuditDetails} onLinkedSubmit={linked.start} linkedBusy={linked.busy||linked.batch?.status==='pending'}/>:view==='shapes'?<MarketShapeSection maxMonth={previousCompleteMonth()} selection={moduleSelections.shapes} onSelectionChange={next=>changeSelection('shapes',next)} onFavorite={()=>setFavoriteRequest(value=>value+1)}/>:view==='keywords'?<MarketKeywordSection showAuditDetails={showAuditDetails} cacheIdentity={sessionIdentity} maxMonth={previousCompleteMonth()} selection={moduleSelections.keywords} onSelectionChange={next=>changeSelection('keywords',next)} initialInput={restoredKeywordInput} onInputChange={setKeywordInput} onFavorite={()=>setFavoriteRequest(value=>value+1)}/>:<MarketThemeSection maxMonth={previousCompleteMonth()} selection={moduleSelections.themes} onSelectionChange={next=>changeSelection('themes',next)} onFavorite={()=>setFavoriteRequest(value=>value+1)}/>}</MarketAdminTools></div></div>;
}
export function MarketResearchSection({ sessionIdentity, showAuditDetails=false, ...navigation }: { sessionIdentity: string; showAuditDetails?:boolean } & MarketNavigationProps) {
  return <MarketResearchModules key={sessionIdentity} sessionIdentity={sessionIdentity} showAuditDetails={showAuditDetails} {...navigation} />;
}
