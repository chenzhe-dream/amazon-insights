"use client";
import {useEffect,useState} from "react";
import {type UsagePerson,type UsageQuery,type UsageReport} from "../../../shared/usage-analytics-contracts";
import {USAGE_PAGES,type UsagePageKey} from "../../../shared/usage-page-catalog";
import {beijingToday,fetchUsageReport} from "../../lib/usage-analytics-query";
import {publishUsagePage} from "../../lib/usage-analytics-browser";
import {PersonSearch} from "./person-search";
import styles from "./usage-analytics.module.css";
export const usageDuration=(ms:number)=>{const minutes=Math.floor(ms/60000);return minutes>=60?Math.floor(minutes/60)+" 小时 "+minutes%60+" 分":minutes+" 分钟"};
const label=(page:string)=>USAGE_PAGES[page as UsagePageKey]??page;
const time=(value:string|null)=>value?new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}):"—";
export function UsageAnalyticsPanel({sessionIdentity}:{sessionIdentity:string}){
  const today=beijingToday(),[period,setPeriod]=useState<UsageQuery["period"]>("day"),[date,setDate]=useState(today),[weekDate,setWeekDate]=useState(today),[monthDate,setMonthDate]=useState(today.slice(0,7)),[person,setPerson]=useState<UsagePerson|null>(null),[page,setPage]=useState(""),[group,setGroup]=useState<"person"|"page">("person"),[refresh,setRefresh]=useState(0);
  const [result,setResult]=useState<{key:string;data:UsageReport}|null>(null),[failure,setFailure]=useState<{key:string;message:string}|null>(null),[selected,setSelected]=useState<UsagePerson|null>(null),[detail,setDetail]=useState<{key:string;data:UsageReport}|null>(null),[detailFailure,setDetailFailure]=useState<{key:string;message:string}|null>(null);
  const actualDate=period==="day"?date:period==="week"?weekDate:`${monthDate}-01`,key=JSON.stringify([sessionIdentity,period,actualDate,person?.userId,page,refresh]),detailKey=key+":"+selected?.userId;
  const query:UsageQuery={period,date:actualDate,...(person?{userId:person.userId}:{}),...(page?{pageKey:page as UsagePageKey}:{})};
  const data=result?.key===key?result.data:null,error=failure?.key===key?failure.message:null,details=detail?.key===detailKey?detail.data:null,detailError=detailFailure?.key===detailKey?detailFailure.message:null;
  useEffect(()=>{publishUsagePage("admin-usage")},[]);
  useEffect(()=>{
    if(!actualDate)return;const controller=new AbortController();
    void fetchUsageReport(query,controller.signal).then(data=>{if(!controller.signal.aborted)setResult({key,data})}).catch(e=>{if(!controller.signal.aborted)setFailure({key,message:e instanceof Error?e.message:"统计加载失败"})});
    return()=>controller.abort();
  // key contains every query field and session identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key]);
  useEffect(()=>{
    if(!selected)return;const controller=new AbortController();
    void fetchUsageReport({...query,userId:selected.userId},controller.signal).then(data=>{if(!controller.signal.aborted)setDetail({key:detailKey,data})}).catch(e=>{if(!controller.signal.aborted)setDetailFailure({key:detailKey,message:e instanceof Error?e.message:"明细加载失败"})});
    return()=>controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[detailKey]);
  const heading=data?time(data.range.start)+" — "+time(new Date(Math.min(Date.parse(data.range.end)-1,Date.parse(data.asOf))).toISOString()):"";
  return <section className={styles.panel} aria-label="使用统计">
    <div className={styles.toolbar} data-usage-ignore>
      <div className={styles.segment} aria-label="统计周期">{(["day","week","month"] as const).map((value,i)=><button key={value} type="button" aria-pressed={period===value} onClick={()=>setPeriod(value)}>{["日","周","月"][i]}</button>)}</div>
      {period==="day"?<label>统计日期<input type="date" aria-label="选择统计年月日" value={date} max={today} onChange={e=>{if(e.target.value&&e.target.validity.valid)setDate(e.target.value)}}/></label>:period==="week"?<label>统计周<input type="date" aria-label="选择统计周内日期" value={weekDate} max={today} onChange={e=>{if(e.target.value&&e.target.validity.valid)setWeekDate(e.target.value)}}/></label>:<label>统计月份<input type="month" aria-label="选择统计年月" value={monthDate} max={today.slice(0,7)} onChange={e=>{if(e.target.value&&e.target.validity.valid)setMonthDate(e.target.value)}}/></label>}
      <PersonSearch key={sessionIdentity} value={person} onChange={p=>{setPerson(p);setSelected(null)}}/>
      <label>页面<select value={page} aria-label="筛选页面" onChange={e=>setPage(e.target.value)}><option value="">全部页面</option>{Object.entries(USAGE_PAGES).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
      <button type="button" className={styles.refresh} onClick={()=>{setFailure(null);setRefresh(n=>n+1)}}>刷新</button>
    </div>
    <p className={styles.note}>每 10 分钟批量上报 · 北京时间 · 数据存在延迟 {data&&"· 更新至 "+time(data.asOf)}</p>
    {error?<div className={styles.state} role="alert">{error}</div>:!data?<div className={styles.state} role="status">正在读取使用统计…</div>:<>
      <div className={styles.stats}>{[
        ["页面访问次数",data.totals.visits.toLocaleString(),"进入或切换业务页面"],
        ["交互点击次数",data.totals.clicks.toLocaleString(),"按钮与链接等操作"],
        ["有效使用时长",usageDuration(data.totals.activeMs),"前台且最近 5 分钟有操作"],
        ["使用人数",data.totals.userCount+" 人","按钉钉绑定人员去重"],
      ].map(([name,value,note])=><article key={name}><span>{name}</span><strong>{value}</strong><small>{note}</small></article>)}</div>
      {(!data.collectionStartedAt||Date.parse(data.range.end)<=Date.parse(data.collectionStartedAt))?<p className={styles.state}>所选日期尚未开始采集。统计从 {time(data.collectionStartedAt)} 起记录，历史数据不补造。</p>:!data.totals.userCount?<p className={styles.state}>所选范围暂无使用记录。登录后开始采集，下一次上报后可查看。</p>:null}
      <section className={styles.card}><header><div><h2>{group==="person"?"人员使用明细":"页面使用明细"}</h2><p>{heading}</p></div><div className={styles.segment}><button type="button" aria-pressed={group==="person"} onClick={()=>setGroup("person")}>按人员</button><button type="button" aria-pressed={group==="page"} onClick={()=>setGroup("page")}>按页面</button></div></header>
      <div className={styles.scroll}><table><thead><tr><th>{group==="person"?"钉钉人员":"页面 / 模块"}</th><th>访问次数</th><th>点击次数</th><th>有效时长</th><th>{group==="person"?"停留时长":"使用人数"}</th>{group==="person"&&<th>最近活动 / 页面</th>}</tr></thead><tbody>
        {group==="person"?data.users.map(user=><tr key={user.userId}><td><button type="button" className={styles.personLink} onClick={()=>setSelected(user)}>{user.displayName}</button><small>钉钉已绑定 · {user.personLabel}</small></td><td>{user.visits}</td><td>{user.clicks}</td><td>{usageDuration(user.activeMs)}</td><td>{usageDuration(user.visibleMs)}</td><td>{time(user.lastActivityAt)}<small>{user.lastPageKey?label(user.lastPageKey):"暂无访问记录"}</small></td></tr>):data.pages.map(row=><tr key={row.pageKey}><td>{label(row.pageKey)}</td><td>{row.visits}</td><td>{row.clicks}</td><td>{usageDuration(row.activeMs)}</td><td>{row.userCount}</td></tr>)}
      </tbody></table></div></section>
      <section className={styles.card}><header><h2>页面使用分布</h2><span>有效使用时长</span></header><div className={styles.bars}>{data.pages.toSorted((a,b)=>b.activeMs-a.activeMs).map(row=><div key={row.pageKey}><span>{label(row.pageKey)}</span><div><i style={{width:row.activeMs/Math.max(1,...data.pages.map(r=>r.activeMs))*100+"%"}}/></div><span>{usageDuration(row.activeMs)}</span></div>)}</div></section>
    </>}
    {selected&&<section className={styles.card} aria-label="个人页面明细"><header><div><h2>{selected.displayName} · 页面明细</h2><p>钉钉已绑定 · {selected.personLabel}</p></div><button type="button" onClick={()=>setSelected(null)}>收起明细</button></header>
      {detailError?<p role="alert">{detailError}</p>:!details?<p className={styles.state} role="status">正在读取个人明细…</p>:<div className={styles.scroll}><table><thead><tr><th>页面</th><th>访问</th><th>点击</th><th>有效时长</th><th>停留时长</th></tr></thead><tbody>{details.pages.map(row=><tr key={row.pageKey}><td>{label(row.pageKey)}</td><td>{row.visits}</td><td>{row.clicks}</td><td>{usageDuration(row.activeMs)}</td><td>{usageDuration(row.visibleMs)}</td></tr>)}</tbody></table></div>}
    </section>}
    <p className={styles.note}>个人时长对重叠时间取并集；跨设备使用不同页面时，页面时长之和可能更大。采集任务耗时不计入人员时长。</p>
  </section>;
}
