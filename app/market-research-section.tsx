"use client";

import React, { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { MarketResearchScopeSchema, type MarketOverviewReport, type MarketResearchJob, type MarketResearchScope } from "../shared/market-research-contracts";
import { createMarketResearchHistoryReader, createMarketResearchJob, listMarketResearchJobs, retryMarketResearchJob } from "./lib/market-research-browser";
import { MarketThemeSection } from './market-theme-section';
import {MarketOverviewSection} from './market-overview-section';
import {MarketShapeSection} from './market-shape-section';
import {MarketKeywordSection} from './market-keyword-section';

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

function numeric(value: number | null, money = false) {
  if (value == null || !Number.isFinite(value)) return "未知";
  return money
    ? new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value)
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function displayTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

export function MarketOverviewResult({ report }: { report: MarketOverviewReport }) {
  const metrics = report.metrics;
  const groups: Array<{ title: string; fields: Array<[string, number | null, boolean?]> }> = [
    { title: "样本规模与销售", fields: [["样本商品数", metrics.sampleProducts], ["品牌数", metrics.brands], ["卖家数", metrics.sellers], ["样本销量", metrics.totalUnits], ["样本销售额", metrics.totalRevenue, true], ["平均单品销量", metrics.avgUnits]] },
    { title: "价格与评价", fields: [["平均价格", metrics.avgPrice, true], ["平均评分数", metrics.avgRatings], ["平均评分（满分 5）", metrics.avgRating]] },
    { title: `上架 ${report.scope.newProductMonths} 个月内的新品`, fields: [["新品数量", metrics.newCount], ["新品平均价格", metrics.newAvgPrice, true], ["新品平均销量", metrics.newAvgUnits]] },
  ];
  return <section className="market-research-result" aria-label="市场总览结果">
    <div className="market-research-result-heading"><div><h3>{report.categoryName || `类目 ${report.nodeId}`}</h3><p>美国站 · {report.scope.month} · Node {report.nodeId}</p></div><p>采集时间（北京时间）<br />{displayTime(report.collectedAt)}</p></div>
    <p className="market-research-note">以下为上游返回的样本指标，不代表整个市场。未知表示本次未获得该指标。</p>
    {groups.map(group => <section key={group.title} className="market-research-metric-group"><h4>{group.title}</h4><dl className="market-research-metrics">{group.fields.map(([label, value, money]) => <div key={label}><dt>{label}</dt><dd>{numeric(value, money)}</dd></div>)}</dl></section>)}
    <section className="market-research-metric-group"><h4>头部 Top {report.scope.headTopN} 集中度</h4><p className="market-research-note">上游比例原值（单位待确认）；暂不据此判断集中程度。</p><dl className="market-research-metrics">
      {[["商品", metrics.productConcentrationRaw], ["品牌", metrics.brandConcentrationRaw], ["卖家", metrics.sellerConcentrationRaw]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value == null ? "未知" : String(value)}</dd></div>)}
    </dl></section>
    {report.issues.length > 0 && <div className="market-research-notice" role="status"><h4>部分数据未能取得</h4><ul>{report.issues.map((issue, index) => <li key={`${issue.dataset}-${index}`}>{issue.message}</li>)}</ul></div>}
    {report.boundaries.length > 0 && <details className="market-research-boundaries"><summary>数据口径与范围</summary><ul>{report.boundaries.map((item, index) => <li key={index}>{item}</li>)}</ul><p>类目路径：{report.nodeIdPath}</p><p>来源：卖家精灵 · 已取得 {report.evidence.length} 份上游响应。</p></details>}
  </section>;
}

function MarketResearchWorkspace({scope,setScope,fromMonth,setFromMonth}:{scope:MarketResearchScope;setScope:React.Dispatch<React.SetStateAction<MarketResearchScope>>;fromMonth:string;setFromMonth:(month:string)=>void}) {
  const [jobs, setJobs] = useState<MarketResearchJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    if (!parsed.success || scope.month > previousCompleteMonth()) { setError("请输入有效的数字类目节点或冒号分隔的路径，并选择已结束的月份。"); return; }
    const serialized = JSON.stringify(parsed.data);
    if (submission.current?.scope !== serialized) submission.current = { scope: serialized, key: crypto.randomUUID() };
    const key = submission.current.key;
    await mutate(signal => createMarketResearchJob(parsed.data, key, signal), true);
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
      if (creating) submission.current = null;
    } catch (cause) {
      if (owner !== controller.current || owner.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "提交失败，请稍后重试。");
    } finally {
      if (owner === controller.current && !owner.signal.aborted) { writing.current = false; setSubmitting(false); }
    }
  }

  const selected = jobs.find(job => job.id === selectedId) ?? null;
  return <div className="market-research-page">
    <section className="card market-research-query"><div className="section-head"><div><h2>市场总览</h2><p>选择美国站类目和完整月份，采集规模、销售、新品与头部基础指标。</p></div></div>
      <form onSubmit={event => void submit(event)}><fieldset disabled={submitting}><legend className="market-research-sr-only">市场总览查询条件</legend><div className="market-research-fields">
        <label>站点<input value="美国站 · US" readOnly /></label>
        <label className="market-research-node">类目节点或路径<input required maxLength={240} pattern="[0-9]+(:[0-9]+)*" placeholder="例如 13280971 或 123:456" value={scope.nodeQuery} onChange={event => setScope(current => ({ ...current, nodeQuery: event.target.value.trim() }))} /></label>
        <label>月份<input required type="month" min="2000-01" max={previousCompleteMonth()} value={scope.month} onChange={event => setScope(current => ({ ...current, month: event.target.value }))} /></label>
        <label>头部数量<select value={scope.headTopN} onChange={event => setScope(current => ({ ...current, headTopN: Number(event.target.value) as MarketResearchScope["headTopN"] }))}>{[5, 10, 20].map(value => <option key={value} value={value}>Top {value}</option>)}</select></label>
        <label>新品定义<select value={scope.newProductMonths} onChange={event => setScope(current => ({ ...current, newProductMonths: Number(event.target.value) as MarketResearchScope["newProductMonths"] }))}>{[1, 3, 6, 12].map(value => <option key={value} value={value}>上架 {value} 个月内</option>)}</select></label>
      </div><button type="submit" className="primary-btn">{submitting ? "提交中…" : "开始采集"}</button></fieldset></form>
      <p className="market-research-note">本页可独立使用，无需先录入 ASIN。上方采集基础指标；下方“总览分析与报告”提供分布数据与分析。</p>
      {error && <p className="market-research-error" role="alert">{error}</p>}
    </section>
    <MarketOverviewSection scope={scope} fromMonth={fromMonth} onFromMonth={setFromMonth} onRestoreScope={run=>{setScope({marketplace:'US',nodeQuery:run.scope.nodeIdPath,month:run.scope.toMonth,headTopN:run.params.headTopN,newProductMonths:run.params.newProductMonths});setFromMonth(run.scope.fromMonth);}}/>
    <div className="market-research-body"><aside className="card market-research-history"><div className="section-head"><h3>采集历史</h3><button className="ghost-btn" type="button" disabled={submitting} onClick={() => void refresh()}>刷新</button></div>
      <p className="market-research-note">最近 30 次，可刷新页面恢复结果。</p>
      {loading ? <p role="status">正在读取…</p> : jobs.length === 0 ? <p>暂无采集记录。</p> : <ol>{jobs.map(job => <li key={job.id}><button type="button" aria-pressed={job.id === selectedId} onClick={() => setSelectedId(job.id)}><strong>{job.report?.categoryName || `类目 ${job.scope.nodeQuery}`}</strong><span>{job.scope.month} · Top {job.scope.headTopN} · 新品 {job.scope.newProductMonths} 个月</span><span className={`market-research-status ${job.status}`}>{statusLabels[job.status]}</span><small>{displayTime(job.createdAt)}</small></button></li>)}</ol>}
    </aside><section className="card market-research-detail" aria-live="polite">{selected ? <><div className="market-research-job-heading"><span className={`market-research-status ${selected.status}`}>{statusLabels[selected.status]}</span><span>已尝试 {selected.attempts} 次</span></div>
      {(selected.status === "queued" || selected.status === "running") && <p role="status">{selected.status === "queued" ? "任务正在排队，可稍后回来查看。" : "正在获取类目数据，状态会自动更新。"}</p>}
      {selected.error && <div className="market-research-notice"><p>{selected.error.message}</p>{canRetryMarketResearchJob(selected) && <button className="primary-btn" type="button" disabled={submitting} onClick={() => void mutate(signal => retryMarketResearchJob(selected.id, signal))}>重试采集</button>}</div>}
      {selected.report && <MarketOverviewResult report={selected.report} />}
    </> : <div className="market-research-empty"><h3>从一个类目开始</h3><p>输入类目节点，点击“开始采集”，或从历史中选择结果。</p></div>}</section></div>
  </div>;
}

function MarketResearchModules() {
  const [view,setView]=useState('overview');
  const [scope,setScope]=useState<MarketResearchScope>({marketplace:'US',nodeQuery:'',month:previousCompleteMonth(),headTopN:10,newProductMonths:6}),[fromMonth,setFromMonth]=useState(previousCompleteMonth());
  useEffect(()=>{const params=new URL(window.location.href).searchParams;if(['themes','shapes','keywords'].includes(params.get('themeView')??''))setView(params.get('themeView')!);
    const parsed=MarketResearchScopeSchema.safeParse({marketplace:'US',nodeQuery:params.get('marketNode')??'',month:params.get('marketMonth')??previousCompleteMonth(),headTopN:Number(params.get('marketHead')??10),newProductMonths:Number(params.get('marketNew')??6)});
    if(parsed.success&&parsed.data.month<=previousCompleteMonth()){setScope(parsed.data);const from=params.get('marketFrom');setFromMonth(from&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(from)&&from<=parsed.data.month?from:parsed.data.month);}
  },[]);
  const rememberScope=(next:MarketResearchScope)=>{const url=new URL(window.location.href);url.searchParams.set('marketNode',next.nodeQuery);url.searchParams.set('marketMonth',next.month);url.searchParams.set('marketHead',String(next.headTopN));url.searchParams.set('marketNew',String(next.newProductMonths));window.history.replaceState(window.history.state,'',url);};
  const updateScope:React.Dispatch<React.SetStateAction<MarketResearchScope>>=next=>setScope(current=>{const updated=typeof next==='function'?next(current):next;rememberScope(updated);return updated;});
  const updateFrom=(month:string)=>{setFromMonth(month);const url=new URL(window.location.href);url.searchParams.set('marketFrom',month);window.history.replaceState(window.history.state,'',url);};
  useEffect(()=>{if(fromMonth>scope.month)updateFrom(scope.month);},[scope.month,fromMonth]);
  const selection={nodeIdPath:scope.nodeQuery,fromMonth,toMonth:scope.month},changeSelection=(next:Partial<typeof selection>)=>{updateScope(current=>({...current,nodeQuery:next.nodeIdPath??current.nodeQuery,month:next.toMonth??current.month}));if(next.fromMonth)updateFrom(next.fromMonth);};
  return <><nav className="market-theme-actions market-theme-module-nav" aria-label="市场调研模块">{[['overview','市场总览'],['shapes','商品形态及价格带'],['keywords','类目关键词洞察'],['themes','类目买家评论见解']].map(([id,label])=><button type="button" className="ghost-btn" key={id} aria-pressed={view===id} onClick={()=>{setView(id);const url=new URL(window.location.href);url.searchParams.set('themeView',id);window.history.replaceState(window.history.state,'',url);}}>{label}</button>)}</nav>
    {view==='overview'?<MarketResearchWorkspace scope={scope} setScope={updateScope} fromMonth={fromMonth} setFromMonth={updateFrom}/>:view==='shapes'?<MarketShapeSection maxMonth={previousCompleteMonth()} selection={selection} onSelectionChange={changeSelection}/>:view==='keywords'?<MarketKeywordSection maxMonth={previousCompleteMonth()} selection={selection} onSelectionChange={changeSelection}/>:<MarketThemeSection maxMonth={previousCompleteMonth()} selection={selection} onSelectionChange={changeSelection}/>}</>;
}
export function MarketResearchSection({ sessionIdentity }: { sessionIdentity: string }) {
  return <MarketResearchModules key={sessionIdentity} />;
}
