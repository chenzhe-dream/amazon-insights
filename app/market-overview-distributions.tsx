"use client";
import React,{useState} from 'react';
import {MarketOverviewDistributionChart} from './market-overview-distribution-chart';
import {MarketOverviewConcentrationChart} from './market-overview-concentration-chart';
import {MarketOverviewContentPies} from './market-overview-content-pies';
import type {MarketOverviewDistributionEntry} from '../shared/market-overview-distribution-contracts';
export const overviewSourceLabels:Record<string,string>={market_research:'市场基础报告',market_research_statistics:'市场基础统计',market_product_demand_trend:'需求趋势',market_product_concentration:'商品份额',market_brand_concentration:'品牌份额',market_seller_concentration:'卖家份额',market_seller_type_concentration:'发货类型',market_seller_country_distribution:'卖家所属地',market_ebc_distribution:'A+ 与视频配置',market_listing_date_distribution:'上架年龄',market_listing_trend_distribution:'上架年份',market_ratings_count_distribution:'评分数分布',market_rating_distribution:'评分分布',market_price_distribution:'价格分布'};
const statusLabels={ready:'已保存',partial:'部分可用',empty:'本次无数据',failed:'采集失败','not-collected':'尚未采集'};
const groupLabels={sample:'返回全样本','new-products':'新品子样本',summary:'重叠汇总（不参与分母）',unclassified:'分组尚未识别'};
const text=(n:number|null)=>n===null?'未知':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n);
const percent=(n:number|null)=>n===null?'不可计算':`${text(n)}%`;
export function MarketOverviewDistributions({entries,currency="USD",embedded=false}:{entries:MarketOverviewDistributionEntry[];currency?:string;embedded?:boolean}){
  const months=[...new Set(entries.map(entry=>entry.month))].sort();
  const [chosenMonth,setChosenMonth]=useState<string|null>(null);
  const month=chosenMonth&&months.includes(chosenMonth)?chosenMonth:months.at(-1);
  const shown=embedded?entries.filter(entry=>entry.month===month):entries;
  return <section className={embedded?'market-reference-distribution-content':'market-overview-distributions'}>{!embedded&&<><h4>分布与需求来源</h4><p className="market-research-note">本表占比仅针对同一接口返回的样本与分组。不同接口可能使用不同样本、更新时间和分母；上架年份分布不等于历年新增销量。</p></>}
    {embedded&&months.length>1&&<div className="overview-month-switch" role="group" aria-label="查看分布月份">{months.map(value=><button key={value} type="button" aria-pressed={month===value} onClick={()=>setChosenMonth(value)}>{value}</button>)}</div>}
    {shown.map(entry=>{const title=overviewSourceLabels[entry.operation],d=entry.distribution;return <section key={`${entry.month}/${entry.operation}`} className={embedded?'market-reference-source':'ss-report-block'} data-report-section={embedded?undefined:entry.operation}>{embedded?<p className="market-research-note">{entry.month} · {statusLabels[entry.status]}</p>:<header><div><h4>{title}</h4><small>{entry.month} · {statusLabels[entry.status]}</small></div></header>}
      {entry.scopeBasis==='request-bound'&&<p className="market-research-note">按所选类目和月份请求；数据源未回显完整范围，尚未获得响应范围确认。</p>}
      {!d||!d.rows.length?<p className="ss-report-empty">{entry.status==='failed'?'该来源采集失败，可展开上方任务管理重试。':entry.status==='not-collected'?'该来源尚未采集。':entry.status==='empty'?'来源本次没有返回可展示数据。':'来源结果已保存，但尚未提供可展示的序列或分组。'}</p>:null}
      {d&&(entry.operation==='market_ebc_distribution'?<MarketOverviewContentPies distribution={d}/>:d.groups.map(group=><div key={group.id}><h5>{groupLabels[group.id]}</h5>{(entry.operation==='market_brand_concentration'||entry.operation==='market_seller_concentration')
        ?<MarketOverviewConcentrationChart rows={d.rows.filter(row=>row.group===group.id)} kind={entry.operation==='market_brand_concentration'?'brand':'seller'} headTopN={10} currency={d.currency}/>
        :<MarketOverviewDistributionChart rows={d.rows.filter(row=>row.group===group.id)} title={title} productShare={entry.operation==='market_seller_type_concentration'}/>}</div>))}
      <details className="market-research-boundaries"><summary>{entry.month} · {title} · {statusLabels[entry.status]}</summary>
      {entry.scopeBasis==='request-bound'&&<p className="market-research-notice">按所选类目和月份请求；数据源未回显完整范围，尚未获得响应范围确认。</p>}
      {entry.status==='failed'||entry.status==='not-collected'?<p>该来源尚无可用结果，可在上方任务列表重试对应月份与来源。其他来源和历史报告继续保留。</p>:!d?<p>{entry.status==='empty'?'来源本次未返回需求数据，未生成趋势或填零。':'已保存需求来源，返回结构尚未接入分析。'}</p>:d.rows.length===0?<p>该分布本次未返回分组数据。</p>:<>
        <p className="market-research-note">比例由保存的数量与分母计算。金额币种未确认时显示未知；来源原始比例不参与换算。</p>
        {d.groups.map(g=><p key={g.id}>{groupLabels[g.id]}分母：商品 {text(g.products)} 个 · 销量 {text(g.units)}；{g.membership==='asin-disjoint'?'ASIN 已核对互不重复':g.membership==='provider-groups'?'使用来源定义的互斥组合':'分组或成员存在缺口，相关占比不可计算'}。</p>)}
        <div className="market-overview-distribution-table" role="region" aria-label={`${entry.month} ${title}明细`} tabIndex={0}><table><thead><tr>{['来源分组','样本范围','商品数','商品数占比','销量','销量占比','销售额'].map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{d.rows.map(row=><tr key={row.id}><th scope="row">{row.label}</th><td>{groupLabels[row.group]}</td><td>{text(row.products)}</td><td>{percent(row.productsSharePct)}</td><td>{text(row.units)}</td><td>{percent(row.unitsSharePct)}</td><td>{row.revenue===null?'未知':`${currency} ${text(row.revenue)}`}</td></tr>)}</tbody></table></div>
        <details><summary>查看来源原值与数据检查</summary>{d.rows.map(row=><p key={row.id}>{row.label}：来源行 {row.sourceIndex+1}；原比例 {JSON.stringify(row.reportedRates)}（单位未确认）；原金额 {text(row.reportedRevenue)}；{row.issues.length?`检查：${row.issues.join('、')}`:'数值检查无缺口'}</p>)}</details>
      </>}
      <p className="market-research-note">采集时间：{entry.fetchedAt??'尚无来源'}{entry.issues.length?` · ${entry.issues.length} 项来源限制`:''}</p><details><summary>来源标识</summary><p>{entry.sourceRef??'未取得来源'}</p>{entry.issues.map((i,n)=><p key={n}>{i.code}</p>)}</details>
    </details></section>;})}
  </section>;
}
