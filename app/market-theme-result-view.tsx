"use client";
import React, {type ReactNode} from 'react';
import type {z} from 'zod';
import type {MarketThemeReportEntrySchema} from '../shared/market-module-contracts';
import type {MarketThemeDetailResponseSchema} from '../shared/market-theme-detail-contracts';
import type {MarketThemeSampleMetadata} from '../shared/market-theme-selection-contracts';
import {LaunchTable} from './launch-section';
import {marketSites,type MarketSite} from '../shared/market-sites';

type Entry=z.infer<typeof MarketThemeReportEntrySchema>;
type Page=z.infer<typeof MarketThemeDetailResponseSchema>['page'];
export type Group=Extract<Page['items'][number],{kind:'group'}>;
export type Member=Extract<Page['items'][number],{kind:'member'}>;
export type Asin=Extract<Page['items'][number],{kind:'asin'}>;
export type Evidence={members:Member[];topAsins?:{asin:string;mention:number}[];error?:string};
/** Pure saved-result presentation. No reads, provider operations or sentiment classification. */
const statuses={success:'已取得',empty:'无主题',failed:'采集失败',missing:'尚未取得'};
const productUrl=(asin:string,marketplace:MarketSite)=>`https://www.${marketSites.find(site=>site.code===marketplace)!.amazonDomain}/dp/${encodeURIComponent(asin)}`;

// This wrapper mirrors the supplied LaunchSection structure without changing shared project UI.
export function MarketThemeLaunchSection({title,description,badge,toolbar,children}:{title:string;description?:string;badge?:ReactNode;toolbar?:ReactNode;children:ReactNode}) {
 return <section className="card launch-block"><div className="launch-section-head"><div className="launch-section-head-main"><div className="launch-section-title-row"><h3>{title}</h3>{toolbar}</div>{description&&<p>{description}</p>}</div>{badge}</div><div className="launch-section-body">{children}</div></section>;
}
export function selectThemeSentiment(groups:Group[],tab:'positive'|'negative') {
 return groups.filter(g=>tab==='positive'?g.totals.positive>0:g.totals.negative>0)
  .sort((a,b)=>tab==='positive'?b.totals.mention-a.totals.mention:b.totals.negative-a.totals.negative||b.totals.mention-a.totals.mention);
}
export function MarketThemeTopicTable({groups,entry,evidence}:{groups:Group[];entry:Entry;evidence:Record<number,Evidence>}) {
 return <LaunchTable className="category-cs-table"><thead><tr><th>主题</th><th>提及占比</th><th>覆盖 ASIN</th><th>评论摘要</th></tr></thead><tbody>{groups.map(group=>{
  const detail=evidence[group.index],members=detail?.members??[],counts=new Map<string,number>();
  for(const member of members)counts.set(member.asin,(counts.get(member.asin)??0)+member.mention);
  const asins=detail?.topAsins?.map(a=>[a.asin,a.mention] as [string,number])??[...counts].sort((a,b)=>b[1]-a[1]).slice(0,3),snippets=[...new Map(members.filter(m=>m.content.text.trim()).map(m=>[m.content.text,m.content])).values()].slice(0,3);
  return <tr key={group.index}><th><span>{group.labelZh??group.sourceLabel?.text??'尚未归类的主题'}</span>{group.sourceLabel?.truncated&&<small>主题名称为截断预览</small>}{group.labelZh&&group.sourceLabel&&<small>{group.sourceLabel.text}</small>}</th>
   <td><strong>{group.topicShare.valuePct===null?'未知':`${group.topicShare.valuePct.toFixed(1)}%`}</strong><small>{group.totals.mention.toLocaleString()} 次 · +{group.totals.positive}/-{group.totals.negative}</small><small>主题份额 {group.topicShare.numerator}/{group.topicShare.denominator}</small></td>
   <td>{!detail?'正在读取覆盖…':detail.error?'覆盖读取失败':asins.length?asins.map(([asin])=><a key={asin} href={productUrl(asin,entry.report.scope.marketplace)} target="_blank" rel="noreferrer">{asin}</a>):'无可用覆盖证据'}</td>
   <td>{!detail?<p>正在读取摘要…</p>:detail.error?<p role="alert">{detail.error}</p>:snippets.length?snippets.map(s=><p key={s.text}>{s.text}{s.truncated&&<small>（截断预览，原摘要长度 {s.totalLength}）</small>}</p>):<p>来源未提供摘要</p>}<small>Customers Say 来源摘要；非逐条评论原文。{group.labelOrigin==='batch-proposal'?(entry.report.basis==='reconciliation-evaluation'?'分类经跨批匹配归组。':'分类为模型批内提案。'):''}</small></td></tr>;
 })}</tbody></LaunchTable>;
}
export function MarketThemeSampleTable({asins,marketplace,samples=[],onRemove,busy=false}:{asins:Asin[];marketplace:MarketSite;samples?:MarketThemeSampleMetadata[];onRemove?:(asin:string)=>void;busy?:boolean}) {
 return <LaunchTable className="category-cs-asin-table"><thead><tr><th>#</th><th>主图</th><th>ASIN</th><th>标题</th><th>主题数</th><th>总览摘要</th><th>操作</th></tr></thead><tbody>{asins.map(item=>{const sample=samples.find(s=>s.asin===item.asin);return <tr key={item.asin}>
  <td title={sample?.sourceRank.value?'供应商来源排名，尚未验证 BSR':sample?.sourceRank.missingReason??'来源未提供排名'}>{sample?.sourceRank.value??'—'}</td><td className="category-cs-asin-thumb"><span className="image-placeholder" title={sample?.imageUrl.missingReason??'无已保存图片'}>ASIN</span></td><td><a href={productUrl(item.asin,marketplace)} target="_blank" rel="noreferrer">{item.asin}</a></td><td>{sample?.title.value??sample?.title.missingReason??'未提供'}{sample?.title.truncated?'…（标题预览）':null}</td><td>{item.totals?.themeCount??'—'}</td><td>{sample?.customerSay.value??`${statuses[item.status]} · ${item.reason??sample?.customerSay.missingReason??'来源未提供总览摘要'}`}{sample?.customerSay.truncated?'…（摘要预览）':null}</td><td className="category-cs-asin-remove"><button type="button" className="ghost-btn danger top-sales-remove-btn" disabled={!onRemove||busy} title={onRemove?'移除后保存新的样本版本，保留此版本历史':'当前保存报告不支持移除样本；保留原始统计范围'} onClick={()=>onRemove?.(item.asin)}>移除</button></td>
 </tr>;})}</tbody></LaunchTable>;
}