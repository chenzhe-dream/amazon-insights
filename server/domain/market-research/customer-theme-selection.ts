import { themeMatchesSentiment } from '../../../shared/market-theme-original-rules';
import { MarketSourceIdentityValueSchemas } from '../../../shared/market-source-contracts';
import {projectSorftimeThemeSample} from './customer-theme-sorftime-sample';
import { MarketThemeSampleMetadataSchema, MarketThemeSelectionResultSchema } from '../../../shared/market-theme-selection-contracts';
import { aggregateCustomerThemes, type CustomerThemesAsinInput } from './customer-themes';
import type { restoreMarketThemeDetails } from './customer-theme-details';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const text=(v:unknown)=>typeof v==='string'&&v.trim()?v.trim():null;
/** Projection only: absence never triggers enrichment or changes numeric evidence. */
export function projectThemeSample(input:{asin:string;sourceIndex:number;product:unknown;productSource:{ref:string;snapshotId:string;payload:unknown;operation?:'category_report'|'category_products';nodeId?:string};summarySource?:{ref:string;snapshotId:string;payload:unknown};provider?:'sorftime'|'sellerSprite';imageSource?:{ref:string;snapshotId:string;payload:unknown};imageMissingReason?:string}){
 if(input.provider==='sorftime')return projectSorftimeThemeSample(input);
 const {asin,sourceIndex,productSource,summarySource}=input,rows=obj(productSource.payload).data,p=obj(input.product),row=obj(Array.isArray(rows)?rows[sourceIndex]:null);
 if(MarketSourceIdentityValueSchemas.asin.parse(row.asin)!==asin||p.asin!==asin||text(row.title)!==p.title)throw new TypeError('Sample metadata differs from the frozen ASIN row');
 const missing=(reason:string)=>({value:null,evidence:null,missingReason:reason,truncated:false});
 const known=<T>(value:T,path:(string|number)[],source=productSource,truncated=false)=>({value,evidence:{sourceRef:source.ref,inputSnapshotId:source.snapshotId,path},missingReason:null,truncated});
 const rank=p.sourceRank; if(rank!==null&&rank!==undefined&&(!Number.isSafeInteger(rank)||Number(rank)<1||Number(row.ranking)!==rank))throw new TypeError('Sample provider rank differs');
 const summary=summarySource?obj(obj(summarySource.payload).data).customer_say:undefined;
 const directSummary=summarySource?(summary??obj(summarySource.payload).customer_say):undefined;
 return MarketThemeSampleMetadataSchema.parse({asin,sourceOrder:sourceIndex+1,title:p.title?known(String(p.title).slice(0,300),['data',sourceIndex,'title'],productSource,String(p.title).length>300):missing('来源未提供标题'),sourceRank:rank?known(Number(rank),['data',sourceIndex,'ranking']):missing('来源未提供有效排名'),
 imageUrl:missing('冻结商品来源尚无已验证的图片字段'),customerSay:typeof directSummary==='string'&&directSummary.trim()?known(directSummary.slice(0,1000),summary===undefined?['customer_say']:['data','customer_say'],summarySource!,directSummary.length>1000):missing('来源未提供总览摘要')});
}
/** Caller supplies a completely validated saved artifact, never paginated UI rows. */
export function deriveThemeSelection(facts:ReturnType<typeof restoreMarketThemeDetails>,excluded:readonly string[],reconciliationRequired:boolean,baseSelectionShortfall=false,rulesOnly=false,originalRules=false){
 const original=facts.aggregation.scope.selectedAsins;
 if(new Set(excluded).size!==excluded.length||excluded.some(a=>!original.includes(a)))throw new TypeError('Excluded ASIN is outside the fixed base selection');
 const selectedAsins=original.filter(a=>!excluded.includes(a)),allResults:CustomerThemesAsinInput[]=[];
 for(const a of facts.aggregation.perAsin){
  if(a.reportedStatus===null)continue;
  if(a.reportedStatus==='success'){if(!a.source)throw new TypeError('Missing source');allResults.push({asin:a.asin,status:'success',source:a.source,...(a.quarantine?{quarantine:a.quarantine}:{}),themes:a.themes.map(t=>({sourceThemeId:t.sourceThemeId,keyword:t.keyword,content:t.content,mention:t.mention,positive:t.positive,negative:t.negative,sourceUpdatedAt:t.sourceUpdatedAt}))});}
  else allResults.push({asin:a.asin,status:a.reportedStatus,source:a.source,reason:a.reason!});
 }
 const results=allResults.filter(r=>selectedAsins.includes(r.asin));
 const baseGroups=facts.aggregation.display.omittedGroupCount===0?facts.aggregation.groups:aggregateCustomerThemes({selectedAsins:original,results:allResults,mappings:facts.aggregation.mappings}).groups;
 const members=new Set(results.flatMap(r=>r.status==='success'?r.themes.map(t=>t.sourceThemeId):[])),decisions=facts.decisions.filter(d=>members.has(d.sourceThemeId));
 const topN=facts.aggregation.display.topN;
 const a=aggregateCustomerThemes({selectedAsins,results,mappings:facts.aggregation.mappings.filter(m=>members.has(m.sourceThemeId))});
 // Saved topN limits presentation only; sentiment existence uses all retained facts.
 const displayedGroups=topN===null?a.groups:a.groups.slice(0,topN);
 const display={topN,totalGroupCount:a.groups.length,displayedGroupCount:displayedGroups.length,omittedGroupCount:a.groups.length-displayedGroups.length};
 const sentimentGroupCounts={positive:a.groups.filter(g=>themeMatchesSentiment(g.totals,'positive',originalRules)).length,negative:a.groups.filter(g=>themeMatchesSentiment(g.totals,'negative',originalRules)).length};
 const labels=new Map(facts.labels.map(l=>[l.groupId,l])),decisionMap=new Map(decisions.map(d=>[d.sourceThemeId,d]));
 const preview=(s:string)=>({text:s.slice(0,2000),totalLength:s.length,truncated:s.length>2000});
 const baseIndex=(g:typeof a.groups[number])=>{
  const index=baseGroups.findIndex(base=>g.groupId!==null?base.groupId===g.groupId:base.groupId===null&&base.members.some(member=>g.members.some(retained=>retained.sourceThemeId===member.sourceThemeId)));
  if(index<0)throw new TypeError('Theme group is outside the frozen base report');
  return index;
 };
 const groups=displayedGroups.map(g=>{const label=g.groupId?labels.get(g.groupId):undefined;return {kind:'group' as const,index:baseIndex(g),groupId:g.groupId,mappingStatus:g.mappingStatus,labelZh:label?.labelZh??null,definition:label?.definition??null,labelOrigin:label?.origin??null,sourceLabel:g.mappingStatus==='unmapped'?preview(g.members[0].keyword):null,memberCount:g.members.length,totals:g.totals,topicShare:g.topicShare};});
 const shown=new Set([...groups.filter(g=>themeMatchesSentiment(g.totals,'positive',originalRules)).sort((x,y)=>y.totals.mention-x.totals.mention).slice(0,12),...groups.filter(g=>themeMatchesSentiment(g.totals,'negative',originalRules)).sort((x,y)=>y.totals.negative-x.totals.negative||y.totals.mention-x.totals.mention).slice(0,12)].map(g=>g.index));
 const unknownCount=decisions.filter(d=>d.status==='unknown').length,unavailableCount=decisions.filter(d=>d.status==='unavailable').length;
 const evidence=a.groups.flatMap(g=>{const index=baseIndex(g);if(!shown.has(index))return [];const counts=new Map<string,number>();for(const m of g.members)counts.set(m.asin,(counts.get(m.asin)??0)+m.mention);
  const uniqueMembers=[...new Map(g.members.filter(t=>t.content.trim()).map(t=>[t.content.trim(),t])).values()].slice(0,3);
  return [{index,topAsins:[...counts].sort((x,y)=>y[1]-x[1]||x[0].localeCompare(y[0])).slice(0,3).map(([asin,mention])=>({asin,mention})),members:uniqueMembers.map(t=>({kind:'member' as const,sourceThemeId:t.sourceThemeId,asin:t.asin,sourceRecordId:t.sourceRecordId,sourceUpdatedAt:t.sourceUpdatedAt,keyword:preview(t.keyword),content:preview(t.content),mention:t.mention,positive:t.positive,negative:t.negative,withinAsinShare:a.perAsin.find(p=>p.asin===t.asin)!.themes.find(m=>m.sourceThemeId===t.sourceThemeId)!.topicShare,decision:decisionMap.get(t.sourceThemeId)!}))}];});
 const result=MarketThemeSelectionResultSchema.parse({selectedAsins,excludedAsins:original.filter(a=>excluded.includes(a)),status:!a.dataReady?'no-data':a.coverage.status==='partial'||baseSelectionShortfall||!rulesOnly&&(unknownCount||unavailableCount||reconciliationRequired)?'partial':'complete',totals:a.totals,metricKind:a.metricKind,sentimentOverlap:a.sentimentOverlap,reviewDeduplication:'unavailable',mappingBasis:'inherited-from-base-report',baseSelectionShortfall,reconciliationRequired,unknownCount,unavailableCount,sentimentGroupCounts,previewOmittedGroupCount:groups.length-shown.size,groups:groups.filter(g=>shown.has(g.index)),evidence,display,
 asins:a.perAsin.map(p=>({kind:'asin',asin:p.asin,status:p.status,reason:p.reason,sourceRecordId:p.source?.sourceRecordId??null,fetchedAt:p.source?.fetchedAt??null,totals:p.totals,memberCount:p.themes.length,...(p.quarantine?{quarantine:p.quarantine}:{})}))});
 // Presentation is bounded by UTF-8 JSON bytes, independently of complete rule facts.
 const positivePreview=result.groups.filter(g=>themeMatchesSentiment(g.totals,'positive',originalRules)),negativePreview=result.groups.filter(g=>themeMatchesSentiment(g.totals,'negative',originalRules)),balanced=new Map<number,typeof result.groups[number]>();
 for(let i=0;i<Math.max(positivePreview.length,negativePreview.length);i++)for(const group of [positivePreview[i],negativePreview[i]])if(group)balanced.set(group.index,group);
 const candidates=[...balanced.values()],candidateEvidence=result.evidence;result.groups=[];result.evidence=[];result.previewOmittedGroupCount=groups.length;
 for(const group of candidates){const detail=candidateEvidence.find(e=>e.index===group.index);result.groups.push(group);if(detail)result.evidence.push(detail);result.previewOmittedGroupCount=groups.length-result.groups.length;
  if(Buffer.byteLength(JSON.stringify(result),'utf8')>160000){result.groups.pop();if(detail)result.evidence.pop();result.previewOmittedGroupCount=groups.length-result.groups.length;}
 }
 return result;
}
