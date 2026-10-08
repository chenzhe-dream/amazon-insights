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
export function MarketOverviewDistributions({entries,currency="USD",rolling=false,embedded=false,headTopN=10}:{entries:MarketOverviewDistributionEntry[];currency?:string;rolling?:boolean;embedded?:boolean;headTopN?:number}){
  const months=[...new Set(entries.map(entry=>entry.month))].sort();
  const [chosenMonth,setChosenMonth]=useState<string|null>(null);
  const month=chosenMonth&&months.includes(chosenMonth)?chosenMonth:months.at(-1);
  const shown=embedded?entries.filter(entry=>entry.month===month):entries;
  return <section className={embedded?'market-reference-distribution-content':'market-overview-distributions'}>{!embedded&&<h4>分布与需求来源</h4>}
    {embedded&&months.length>1&&<div className="overview-month-switch" role="group" aria-label="查看分布月份">{months.map(value=><button key={value} type="button" aria-pressed={month===value} onClick={()=>setChosenMonth(value)}>{value}</button>)}</div>}
    {shown.map(entry=>{const title=overviewSourceLabels[entry.operation],d=entry.distribution;return <section key={`${rolling?'最近30天':entry.month}/${entry.operation}`} className={embedded?'market-reference-source':'ss-report-block'} data-report-section={embedded?undefined:entry.operation}>{embedded?<p className="market-research-note">{rolling?'最近30天':entry.month} · {statusLabels[entry.status]}</p>:<header><div><h4>{title}</h4><small>{rolling?'最近30天':entry.month} · {statusLabels[entry.status]}</small></div></header>}
      {!d||!d.rows.length?<p className="ss-report-empty">{entry.status==='failed'?'该来源采集失败，可展开上方任务管理重试。':entry.status==='not-collected'?'该来源尚未采集。':entry.status==='empty'?'来源本次没有返回可展示数据。':'来源结果已保存，但尚未提供可展示的序列或分组。'}</p>:null}
      {d&&(entry.operation==='market_ebc_distribution'?<MarketOverviewContentPies distribution={d}/>:d.groups.map(group=><div key={group.id}><h5>{groupLabels[group.id]}</h5>{(entry.operation==='market_brand_concentration'||entry.operation==='market_seller_concentration')
        ?<MarketOverviewConcentrationChart rows={d.rows.filter(row=>row.group===group.id)} kind={entry.operation==='market_brand_concentration'?'brand':'seller'} headTopN={headTopN} currency={d.currency}/>
        :<MarketOverviewDistributionChart rows={d.rows.filter(row=>row.group===group.id)} title={title} productShare={entry.operation==='market_seller_type_concentration'}/>}</div>))}
      {entry.issues.length>0&&<div className="market-research-note">{entry.issues.map((issue,index)=><p key={index}>{issue.code}</p>)}</div>}
      {d?.rows.length?<details className="market-overview-distribution-details"><summary>查看{title}明细</summary><div className="market-overview-distribution-table" role="region" aria-label={`${rolling?'最近30天':entry.month} ${title}明细`} tabIndex={0}><table><thead><tr>{['来源分组','样本范围','商品数','商品数占比','销量','销量占比','销售额'].map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{d.rows.map(row=><tr key={row.id}><th scope="row">{row.label}</th><td>{groupLabels[row.group]}</td><td>{text(row.products)}</td><td>{percent(row.productsSharePct)}</td><td>{text(row.units)}</td><td>{percent(row.unitsSharePct)}</td><td>{row.revenue===null?'未知':`${currency} ${text(row.revenue)}`}</td></tr>)}</tbody></table></div></details>:null}
    </section>;})}
  </section>;
}
