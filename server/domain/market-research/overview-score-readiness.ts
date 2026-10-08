import {buildMarketOverviewSynthesis,MARKET_SYNTHESIS_DIMENSIONS} from './original-overview/sellersprite-market-overview-synthesis';
import {analyzePriceBands} from './original-overview/sellersprite-market-price-analysis';
import type {SellerSpriteMarketNiche as Niche,SellerSpriteMarketReport as Report,SellerSpriteTrendPoint as Point,SellerSpriteDistRow as Row} from './original-overview/sellersprite-market-niche';
import type {MarketOverviewOriginalSynthesis} from '../../../shared/market-overview-original-synthesis';
import {MARKET_OVERVIEW_ZIP_RULE_VERSION} from '../../../shared/market-overview-zip-baseline';

type Dimension=typeof MARKET_SYNTHESIS_DIMENSIONS[number]['key'];
type Evaluation=NonNullable<MarketOverviewOriginalSynthesis['evaluation']>;
export type OverviewInputIssues=Partial<Record<'keywordSearches'|'keywords'|'sales'|'amount'|'views'|'profits'|'prices'|'ratingCounts'|'ratingValues'|'listingAge'|'ebc',string[]>>;
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const nonnegative=(v:unknown):v is number=>finite(v)&&v>=0;
const pct=(v:unknown):v is number=>nonnegative(v)&&v<=100;
const check=(valid:boolean,message:string)=>valid?[]:[message];
const unique=(messages:string[])=>[...new Set(messages)];
// Match original preprocessing (sales/views pass through this once before direction()).
export function drop(points:Point[]){
 if(points.length<3)return points;
 const last=points.at(-1)!,prior=points.at(-2)!;
 return prior.value>0&&last.value<prior.value*.4?points.slice(0,-1):points;
}
export function validPoints(points:Point[]){
 return points.length>0&&points.every(p=>/^\d{4}-(0[1-9]|1[0-2])(?:-\d{2})?$/.test(p.month)&&nonnegative(p.value))&&new Set(points.map(p=>p.month.slice(0,7))).size===points.length&&points.every((p,i)=>i===0||points[i-1].month<p.month);
}
function consecutive(points:Point[]){return points.every((p,i)=>{if(!i)return true;const a=points[i-1].month.split('-').map(Number),b=p.month.split('-').map(Number);return b[0]*12+b[1]===a[0]*12+a[1]+1;});}
export function direction(points:Point[],preprocessed=false):'up'|'flat'|'down'|null{
 if(!validPoints(points))return null;
 const clean=drop(preprocessed?drop(points):points),prior=clean.slice(-12,-6),recent=clean.slice(-6);
 if(recent.length<6||prior.length<3||!consecutive(clean.slice(-12)))return null;
 const baseline=prior.reduce((s,p)=>s+p.value,0)/prior.length;
 if(baseline<=0)return null;
 const change=(recent.reduce((s,p)=>s+p.value,0)/6-baseline)/baseline;
 return change>.05?'up':change<-.05?'down':'flat';
}
export function yoy(points:Point[],preprocessed=true){
 if(!validPoints(points))return null;
 const clean=preprocessed?drop(points):points,latest=clean.at(-1)!;
 const [year,month]=latest.month.split('-');
 const prior=clean.find(p=>p.month===`${Number(year)-1}-${month}`);
 return prior&&prior.value>0?{change:(latest.value-prior.value)/prior.value*100,month:latest.month}:null;
}
function shareReady(rows:Row[]){return rows.length>0&&rows.every(r=>pct(r.unitsShare));}

/** New validation policy around unchanged v6 formulas. No defaults become observed scores. */
export function buildCheckedOverviewSynthesis(niche:Niche,report:Report,issues:OverviewInputIssues={}):Pick<MarketOverviewOriginalSynthesis,'summary'>&{evaluation:Evaluation}{
 const raw=buildMarketOverviewSynthesis(niche,report);
 const merged=new Map<string,number>();
 for(const keyword of report.keywordTrends)for(const point of keyword.points)merged.set(point.month,(merged.get(point.month)??0)+point.value);
 const keywordPoints=[...merged].sort(([a],[b])=>a.localeCompare(b)).map(([month,value])=>({month,value}));
 const keywordDir=direction(keywordPoints),salesDir=direction(report.salesTrend,true),viewsDir=direction(report.productDemand?.pageViews??[],true);
 const usedKeywordMonths=drop(keywordPoints).slice(-12).map(p=>p.month);
 const keywordIssues=unique([...(issues.keywords??[]),...check(report.keywordTrends.length>0&&report.keywordTrends.every(k=>nonnegative(k.searches)&&validPoints(k.points)&&usedKeywordMonths.every(month=>k.points.some(p=>p.month===month)))&&keywordDir!==null,'关键词月搜索量或趋势不足（需有效比较基期）')]);
 const salesIssues=unique([...(issues.sales??[]),...check(salesDir!==null,'行业销量趋势不足或比较基期为零')]);
 const viewsIssues=unique([...(issues.views??[]),...check(viewsDir!==null,'商品浏览量趋势不足或比较基期为零')]);
 const salesYoy=yoy(report.salesTrend),keywordYoy=yoy(keywordPoints,false),amountYoy=yoy(report.salesAmountTrend);
 const reviewIssues=unique([...(issues.ratingCounts??[]),...check(shareReady(report.ratingCounts),'评分数分布的销量占比缺失')]);
 const ratingIssues=unique([...(issues.ratingValues??[]),...check(shareReady(report.ratingValues),'评分值分布的销量占比缺失')]);
 const ageIssues=unique([...(issues.listingAge??[]),...check(shareReady(report.listingAge)&&report.listingAge.some(r=>/3年以上|36|三年以上/.test(r.label)),'上架年龄分布或老品销量占比缺失')]);
 const ebcLabels=['有A+有视频','有A+无视频','无A+有视频','无A+无视频'];
 const slices=ebcLabels.map(label=>report.ebc.find(r=>r.label===label));
 const contentIssues=unique([...(issues.ebc??[]),...check(slices.every(r=>r&&nonnegative(r.products))&&slices.reduce((s,r)=>s+(r?.products??0),0)>0,'A+/视频分布数量缺失或分母为零'),...check(niche.ebcProportion==null||pct(niche.ebcProportion),'A+覆盖比例无效')]);
 const concentrationIssues=check(pct(niche.productCrn),'商品集中度缺失或无效');
 const priceAnalysis=analyzePriceBands(report.prices,niche,report.asinProfits);
 const priceIssues=unique([...(issues.prices??[]),...(issues.profits??[]),...check(report.prices.length>=2&&report.prices.every(r=>nonnegative(r.products)&&nonnegative(r.units)&&(r.unitsShare==null||pct(r.unitsShare))),'价格带数量、销量或占比缺失'),...check(Boolean(priceAnalysis&&priceAnalysis.bands.length>=2),'有效价格带不足两个'),...check(Boolean(priceAnalysis&&priceAnalysis.bands.every(b=>finite(b.avgProfitPct))),'参与比较的价格带缺少真实毛利样本')]);
 const missing:Record<Dimension,string[]>={
  marketDemand:[...check(nonnegative(niche.totalUnits),'市场总销量缺失'),...keywordIssues,...salesIssues,...viewsIssues,...check(salesYoy!==null,'销量同比缺少去年同月或基期为零')],
  marketCompetition:[...concentrationIssues,...check(pct(niche.brandCrn),'品牌集中度缺失或无效'),...check(pct(niche.sellerCrn),'卖家集中度缺失或无效')],
  marketMaturity:[...ageIssues,...reviewIssues,...contentIssues,...check(pct(niche.newRatio),'新品占比缺失或无效'),...check(pct(niche.amazonSelfProportion),'Amazon自营销量占比缺失或无效')],
  newEntryBarrier:[...check(pct(niche.newRatio),'新品占比缺失或无效'),...check(nonnegative(niche.newAvgUnits)&&finite(niche.avgUnits)&&niche.avgUnits>0,'新品均销缺失或样本均销分母不可计算'),...reviewIssues,...concentrationIssues,...contentIssues],
  productOpportunity:[...ratingIssues,...viewsIssues,...concentrationIssues,...check(pct(niche.returnRatio)&&pct(niche.avgReturnRatio),'类目退货率或比较退货率缺失')],
  priceOpportunity:priceIssues,
 };
 const dimensions=Object.fromEntries(MARKET_SYNTHESIS_DIMENSIONS.map(d=>[d.key,{status:missing[d.key].length?'insufficient':'ready',missing:unique(missing[d.key])}])) as Evaluation['dimensions'];
 const ready=(key:Dimension)=>dimensions[key].status==='ready';
 const count=MARKET_SYNTHESIS_DIMENSIONS.filter(d=>ready(d.key)).length;
 const evaluation:Evaluation={version:'observed-inputs/1',status:count===6?'ready':count?'partial':'insufficient',dimensions};
 const scores={...raw.scores} as MarketOverviewOriginalSynthesis['summary']['scores'];
 const sections={...raw.sections};
 for(const dim of MARKET_SYNTHESIS_DIMENSIONS)if(!ready(dim.key)){
  scores[dim.key]=null;sections[dim.sectionKey]=`数据不足，暂不评分：${dimensions[dim.key].missing.join('；')}。`;
 }
 if(ready('priceOpportunity')&&(!finite(niche.avgProfit)||!finite(niche.avgPrice)||niche.avgPrice<=0)){
  sections.priceOpportunity=sections.priceOpportunity.split('\n').filter(line=>!line.includes('广告前毛利')&&!line.startsWith('成本倒推')).join('\n');
 }
 // Scoring and prose have separate dependencies: missing optional facts do not cancel a valid score.
 if(ready('marketCompetition')&&(!report.brands[0]?.label||!pct(report.brands[0]?.unitsShare)||!report.sellers[0]?.label||!pct(report.sellers[0]?.unitsShare))){sections.competition=raw.sections.competition.split('。')[0]+'。头部品牌或卖家明细缺失，暂不描述排名份额。';}
 const keywordReady=keywordIssues.length===0,salesReady=salesIssues.length===0,viewsReady=viewsIssues.length===0;
 const keywordLatest=keywordPoints.at(-1)?.month??'',keywordPrior=keywordLatest?`${Number(keywordLatest.slice(0,4))-1}-${keywordLatest.slice(5,7)}`:'';
 const keywordYoyCovered=report.keywordTrends.every(k=>[keywordLatest,keywordPrior].every(month=>k.points.some(p=>p.month===month)));
 const supplyReady=pct(niche.newRatio)&&(keywordYoy!==null?keywordReady&&keywordYoyCovered:salesYoy!==null?salesReady:keywordReady);
 const priceUpgradeReady=salesReady&&salesYoy!==null&&amountYoy!==null&&salesYoy.month===amountYoy.month&&!(issues.amount?.length);
 const crossSignals=raw.crossSignals.filter((_,i)=>i===0?keywordReady&&salesReady:i===1?ready('marketCompetition'):i===2?supplyReady:priceUpgradeReady);
 const topOpportunities=raw.topOpportunities.filter(text=>{
  if(text.startsWith('A+/'))return contentIssues.length===0;
  if(text.startsWith('部分高销量'))return ratingIssues.length===0;
  if(text.startsWith('商品与品牌'))return concentrationIssues.length===0&&pct(niche.brandCrn);
  if(text.startsWith('类目浏览量'))return viewsReady;
  if(text.startsWith('需结合下方'))return count===6;
  return ready('priceOpportunity');
 });
 const topRisks=raw.topRisks.filter(text=>{
  if(text.startsWith('新增商品'))return supplyReady;
  if(text.startsWith('头部商品'))return pct(niche.productCrn)||pct(niche.brandCrn);
  if(text.startsWith('主流销量'))return reviewIssues.length===0;
  if(text.startsWith('Amazon'))return pct(niche.amazonSelfProportion);
  if(text.startsWith('搜索或成交'))return keywordReady&&keywordDir==='down'||salesReady&&salesDir==='down';
  return count===6;
 });
 const summary:MarketOverviewOriginalSynthesis['summary']={...raw,version:6,ruleVersion:MARKET_OVERVIEW_ZIP_RULE_VERSION,scores,sections,crossSignals,topOpportunities,topRisks};
 if(count===6&&(topRisks.length!==raw.topRisks.length||topOpportunities.length!==raw.topOpportunities.length))summary.finalVerdict=`${raw.gradeLabel}：${raw.gradeDefinition} 部分辅助依据不足，具体机会与风险仅按已验证项展示。`;
 if(count!==6){summary.score=null;summary.grade=null;summary.gradeLabel=null;summary.gradeDefinition='必要输入尚未齐全，暂不计算市场机会总分及准入等级。';summary.finalVerdict=`已完成 ${count}/6 个维度的评分。缺少依据的维度保留待补充，不折算总分，也不据此判断是否进入市场。`;}
 return {summary,evaluation};
}
