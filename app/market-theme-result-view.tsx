"use client";
import React, {useState,type ReactNode} from 'react';
import type {z} from 'zod';
import type {MarketThemeReportEntrySchema} from '../shared/market-module-contracts';
import type {MarketThemeDetailResponseSchema} from '../shared/market-theme-detail-contracts';
import type {MarketThemeSampleMetadata} from '../shared/market-theme-selection-contracts';
import {themeSourceErrorText} from './lib/market-theme-source-error';
import {LaunchTable} from './launch-section';
import {marketSites,type MarketSite} from '../shared/market-sites';
import {isOriginalThemeFlow,themeMatchesSentiment,localizeThemeLabel,localizeThemeSnippet} from '../shared/market-theme-original-rules';

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
export function selectThemeSentiment(groups:Group[],tab:'positive'|'negative',original=false) {
 return groups.filter(g=>themeMatchesSentiment(g.totals,tab,original))
  .sort((a,b)=>tab==='positive'?b.totals.mention-a.totals.mention:b.totals.negative-a.totals.negative||b.totals.mention-a.totals.mention);
}
export type ThemeTranslationView=Record<string,{translated:string|null;state:string}>;
export function MarketThemeTopicTable({groups,entry,evidence,translations={}}:{groups:Group[];entry:Entry;evidence:Record<number,Evidence>;translations?:ThemeTranslationView}) {
 const original=isOriginalThemeFlow(entry.report.versions.planner);
 return <LaunchTable className="category-cs-table"><thead><tr><th>主题</th><th>提及占比</th><th>覆盖 ASIN</th><th>评论摘要</th></tr></thead><tbody>{groups.map(group=>{
  const detail=evidence[group.index],members=detail?.members??[],counts=new Map<string,number>();
  for(const member of members)counts.set(member.asin,(counts.get(member.asin)??0)+member.mention);
  const asins=detail?.topAsins?.map(a=>[a.asin,a.mention] as [string,number])??[...counts].sort((a,b)=>b[1]-a[1]).slice(0,3),snippets=[...new Map(members.filter(m=>m.content.text.trim()).map(m=>[m.content.text,{...m.content,keyword:m.keyword.text,sourceThemeId:m.sourceThemeId}])).values()].slice(0,3);
  const sourceLabel=group.sourceLabel?.text;
  const rawLabel=group.labelZh??(original&&sourceLabel?localizeThemeLabel(sourceLabel):sourceLabel)??'尚未归类的主题';
  const displayLabel=translations[`group:${group.index}:label`]?.state==='ready'&&translations[`group:${group.index}:label`]?.translated?translations[`group:${group.index}:label`].translated!:rawLabel;
  const localRuleLabel=original&&sourceLabel&&!group.labelZh;
  const renderedSnippets=snippets.map(s=>{const local=original?localizeThemeSnippet(s.keyword,s.text):s.text;const translation=translations[`member:${s.sourceThemeId}:content`];return {...s,displayText:translation?.state==='ready'&&translation.translated?translation.translated:local};});
  const hasUntranslatedSnippet=original&&renderedSnippets.some(s=>s.displayText===s.text&&/[A-Za-z]/.test(s.displayText));
  return <tr key={group.index}><th><span>{displayLabel}</span>{group.sourceLabel?.truncated&&<small>主题名称为截断预览</small>}{group.labelZh&&group.sourceLabel&&<small>{group.sourceLabel.text}</small>}{localRuleLabel&&<small>{displayLabel===sourceLabel?'原文保留，中文翻译未完成':'已按本地规则翻译'}</small>}</th>
   <td><strong>{group.topicShare.valuePct===null?'未知':`${group.topicShare.valuePct.toFixed(1)}%`}</strong><small>{group.totals.mention.toLocaleString()} 次 · +{group.totals.positive}/-{group.totals.negative}</small><small>主题份额 {group.topicShare.numerator}/{group.topicShare.denominator}</small></td>
   <td>{!detail?'正在读取覆盖…':detail.error?'覆盖读取失败':asins.length?asins.map(([asin])=><a key={asin} href={productUrl(asin,entry.report.scope.marketplace)} target="_blank" rel="noreferrer">{asin}</a>):'无可用覆盖证据'}</td>
   <td>{!detail?<p>正在读取摘要…</p>:detail.error?<p role="alert">{detail.error}</p>:renderedSnippets.length?renderedSnippets.map(s=><p key={s.text}>{s.displayText}{s.truncated&&<small>（截断预览，原摘要长度 {s.totalLength}）</small>}</p>):<p>来源未提供摘要</p>}<small>Customers Say 来源摘要；非逐条评论原文。{original?(hasUntranslatedSnippet?'部分摘要保留原文，中文翻译未完成。':'已知文本按本地规则中文化，原始摘要保留在完整证据中。'):''}{group.labelOrigin==='batch-proposal'?(entry.report.basis==='reconciliation-evaluation'?'分类经跨批匹配归组。':'分类为模型批内提案。'):''}</small></td></tr>;
 })}</tbody></LaunchTable>;
}
export function MarketThemeSampleTable({asins,marketplace,samples=[],translations={},onRemove,busy=false}:{asins:Asin[];marketplace:MarketSite;samples?:MarketThemeSampleMetadata[];translations?:ThemeTranslationView;onRemove?:(asin:string)=>void;busy?:boolean}) {
 return <LaunchTable className="category-cs-asin-table"><thead><tr><th>#</th><th>主图</th><th>ASIN</th><th>标题</th><th>主题数</th><th>总览摘要</th><th>操作</th></tr></thead><tbody>{asins.map(item=>{const sample=samples.find(s=>s.asin===item.asin);return <tr key={item.asin}>
  <td title={sample?.sourceRank.value?'供应商来源排名，尚未验证 BSR':sample?.sourceRank.missingReason??'来源未提供排名'}>{sample?.sourceRank.value??'—'}</td><td className="category-cs-asin-thumb"><ThemeProductThumbnail key={sample?.imageUrl.value??item.asin} sample={sample} asin={item.asin}/></td><td><a href={productUrl(item.asin,marketplace)} target="_blank" rel="noreferrer">{item.asin}</a></td><td>{sample?.title.value??sample?.title.missingReason??'未提供'}{sample?.title.truncated?'…（标题预览）':null}</td><td>{item.quarantine?<>有效 {item.memberCount}/{item.quarantine.receivedCount}<small>隔离 {item.quarantine.rejected.length} 条异常主题</small></>:item.totals?.themeCount??'—'}</td><td>{translations[`asin:${item.asin}:summary`]?.state==='ready'&&translations[`asin:${item.asin}:summary`]?.translated?translations[`asin:${item.asin}:summary`].translated:sample?.customerSay.value??`${statuses[item.status]} · ${themeSourceErrorText(item.reason??sample?.customerSay.missingReason??'来源未提供总览摘要')}`}{sample?.customerSay.truncated?'…（摘要预览）':null}</td><td className="category-cs-asin-remove"><button type="button" className="ghost-btn danger top-sales-remove-btn" disabled={!onRemove||busy} title={onRemove?'移除后保存新的样本版本，保留此版本历史':'当前保存报告不支持移除样本；保留原始统计范围'} onClick={()=>{if(onRemove&&window.confirm(`确认移除 ${item.asin}？将保存新的样本版本，保留历史报告，不补入其他商品。`))onRemove(item.asin);}}>移除</button></td>
 </tr>;})}</tbody></LaunchTable>;
}
function ThemeProductThumbnail({sample,asin}:{sample?:MarketThemeSampleMetadata;asin:string}) {
 const [failed,setFailed]=useState(false),value=sample?.imageUrl.value;
 let url:string|null=null;
 try{if(value&&['https:','http:'].includes(new URL(value).protocol))url=value;}catch{}
 return url&&!failed?<img src={url} alt={`${asin} 商品图片`} loading="lazy" referrerPolicy="no-referrer" width={36} height={36} style={{objectFit:'contain',flexShrink:0}} onError={()=>setFailed(true)}/>:<span className="image-placeholder" title={failed?'图片地址加载失败':sample?.imageUrl.missingReason??'无已保存图片'}>ASIN</span>;
}
