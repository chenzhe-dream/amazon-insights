import {buildMarketOverviewSynthesis,MARKET_SYNTHESIS_DIMENSIONS} from './original-overview/sellersprite-market-overview-synthesis';
import {analyzePriceBands} from './original-overview/sellersprite-market-price-analysis';
import {buildCheckedOverviewSynthesis,direction,yoy,type OverviewInputIssues} from './overview-score-readiness';
import type {SellerSpriteMarketNiche as Niche,SellerSpriteMarketReport as Report,SellerSpriteDistRow as Row} from './original-overview/sellersprite-market-niche';
import type {MarketOverviewOriginalSynthesis} from '../../../shared/market-overview-original-synthesis';

type Evaluation=NonNullable<MarketOverviewOriginalSynthesis['evaluation']>;
type Dimension=typeof MARKET_SYNTHESIS_DIMENSIONS[number]['key'];
type Item=NonNullable<Evaluation['dimensions'][Dimension]['items']>[number];
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const nonnegative=(v:unknown):v is number=>finite(v)&&v>=0;
const pct=(v:unknown):v is number=>nonnegative(v)&&v<=100;
const clamp=(n:number,max:number)=>Math.max(0,Math.min(max,n));
const sum=(items:Item[])=>items.reduce((n,i)=>n+(i.score??0),0);
const readyRows=(rows:Row[])=>rows.length>0&&rows.every(r=>pct(r.unitsShare));
const share=(rows:Row[],match:(s:string)=>boolean)=>rows.filter(r=>match(r.label)).reduce((n,r)=>n+(r.unitsShare??0),0);
const crn=(value:number|null,weight:number)=>value!<40?weight:value!<55?weight*.65:weight*.3;

/** Immutable v2 policy: preserve observed v6 contributions, never award defaults.
 * A partial value is a subtotal under the unchanged caps, not a complete score,
 * lower bound or rescaled estimate. Future policies must use a new version. */
export function buildItemCheckedOverviewSynthesis(niche:Niche,report:Report,issues:OverviewInputIssues={}):Pick<MarketOverviewOriginalSynthesis,'summary'>&{evaluation:Evaluation}{
 const raw=buildMarketOverviewSynthesis(niche,report),legacy=buildCheckedOverviewSynthesis(niche,report,issues);
 const good=(key:keyof OverviewInputIssues)=>!issues[key]?.length;
 const item=(id:string,label:string,valid:boolean,value:number,reason:string,group?:Item['group']):Item=>({id,label,status:valid?'known':'missing',score:valid?value:null,missing:valid?[]:[reason],...(group?{group}:{})});
 const keywordTrendReady=good('keywords')&&!legacy.evaluation.dimensions.marketDemand.missing.some(m=>m.includes('关键词'));
 const keywordSearchReady=good('keywordSearches')&&report.keywordTrends.length>0&&report.keywordTrends.every(k=>nonnegative(k.searches));
 const points=new Map<string,number>();for(const k of report.keywordTrends)for(const p of k.points)points.set(p.month,(points.get(p.month)??0)+p.value);
 const keywordDir=direction([...points].sort(([a],[b])=>a.localeCompare(b)).map(([month,value])=>({month,value})));
 const salesDir=direction(report.salesTrend,true),viewsDir=direction(report.productDemand?.pageViews??[],true),salesYoy=yoy(report.salesTrend);
 const salesReady=good('sales')&&salesDir!==null,viewsReady=good('views')&&viewsDir!==null;
 const searches=report.keywordTrends.reduce((n,k)=>n+(k.searches??0),0),units=niche.totalUnits??0;
 const reviewReady=good('ratingCounts')&&readyRows(report.ratingCounts),ratingReady=good('ratingValues')&&readyRows(report.ratingValues);
 const lowReview=share(report.ratingCounts,s=>/1-50|50-100|100-300|<50|＜50/.test(s));
 const highReview=share(report.ratingCounts,s=>/500|1000|以上/.test(s)&&!/1-50|50-100|100-200|200-300|300-500/.test(s));
 const midRating=share(report.ratingValues,s=>/4\.0|4\.1|4\.2|4\.3|＜4/.test(s));
 const old=report.listingAge.find(r=>/3年以上|36|三年以上/.test(r.label));
 const ageReady=good('listingAge')&&readyRows(report.listingAge)&&!!old;
 const slices=['有A+有视频','有A+无视频','无A+有视频','无A+无视频'].map(label=>report.ebc.find(r=>r.label===label));
 const contentReady=good('ebc')&&slices.every(r=>r&&nonnegative(r.products))&&slices.reduce((n,r)=>n+(r?.products??0),0)>0;
 const total=slices.reduce((n,r)=>n+(r?.products??0),0);
 const aplus=niche.ebcProportion??(contentReady?((slices[0]!.products!+slices[1]!.products!)/total)*100:null);
 const video=contentReady?((slices[0]!.products!+slices[2]!.products!)/total)*100:null;
 const aplusReady=good('ebc')&&pct(aplus),videoReady=pct(video);
 const ratio=niche.newRatio??0,ratioReady=pct(niche.newRatio),open=ratio>10;
 const efficiencyReady=nonnegative(niche.newAvgUnits)&&finite(niche.avgUnits)&&niche.avgUnits>0;
 const efficiency=efficiencyReady?niche.newAvgUnits!/niche.avgUnits!:0;
 const price=analyzePriceBands(report.prices,niche,report.asinProfits);
 const priceReady=good('prices')&&report.prices.length>=2&&report.prices.every(r=>nonnegative(r.products)&&nonnegative(r.units)&&(r.unitsShare==null||pct(r.unitsShare)))&&!!price&&price.bands.length>=2;
 const profitReady=priceReady&&good('profits')&&price!.bands.every(b=>finite(b.avgProfitPct));
 const lists:Record<Dimension,Item[]>={
  marketDemand:[
   item('scale','市场销量规模',nonnegative(niche.totalUnits),units>=100000?10:units>=50000?8:units>=20000?6:units>=5000?4:2,'市场总销量缺失','scale'),
   item('searches','核心词月搜索量',keywordSearchReady,searches>=200000?6:searches>=80000?4:searches>=20000?2:0,'核心词月搜索量未完整取得','scale'),
   item('not-declining','搜索与销量均非下降',keywordTrendReady&&salesReady,keywordDir!=='down'&&salesDir!=='down'?4:0,'搜索或销量趋势无法判断，不能获得非下降奖励','scale'),
   item('keyword-growth','关键词趋势',keywordTrendReady,keywordDir==='up'?6:keywordDir==='flat'?3:0,'关键词趋势缺少有效比较窗口','growth'),
   item('sales-growth','行业销量趋势',salesReady,salesDir==='up'?6:salesDir==='flat'?3:0,'行业销量趋势缺少有效比较窗口或来源未完整就绪','growth'),
   item('views-growth','商品浏览量趋势',viewsReady,viewsDir==='up'?4:viewsDir==='flat'?2:0,'商品浏览量趋势缺失或来源冲突','growth'),
   item('sales-yoy','销量同比',good('sales')&&salesYoy!==null,salesYoy?(salesYoy.change>=10?4:salesYoy.change>=0?2:-3):0,'销量同比缺少去年同月或有效基期','growth'),
  ],
  marketCompetition:[
   item('product-crn','商品集中度',pct(niche.productCrn),crn(niche.productCrn,7),'商品集中度缺失或无效'),
   item('brand-crn','品牌集中度',pct(niche.brandCrn),crn(niche.brandCrn,7),'品牌集中度缺失或无效'),
   item('seller-crn','卖家集中度',pct(niche.sellerCrn),crn(niche.sellerCrn,6),'卖家集中度缺失或无效'),
  ],
  marketMaturity:[
   item('listing-age','老品销量占比',ageReady&&(old!.unitsShare!<40||ratioReady),old?.unitsShare!>=55?(open?-2:-3):old?.unitsShare!>=40?(open?-1:-2):0,'老品销量占比或新品窗口缺失'),
   item('aplus','A+覆盖',aplusReady,aplus!>=80?-2:aplus!>=60?-1:0,'A+覆盖比例缺失'),
   item('video','视频覆盖',videoReady,video!>=60?-1:0,'视频覆盖比例缺失'),
   item('reviews','高评论商品销量占比',reviewReady&&(highReview<40||ratioReady),highReview>=55?(open?-2:-3):highReview>=40?(open?-1:-2):0,'评论分布或新品窗口缺失'),
   item('amazon','亚马逊自营比例',pct(niche.amazonSelfProportion),(niche.amazonSelfProportion??0)>=35?-1:0,'亚马逊自营比例缺失'),
   item('new-ratio','新品占比',ratioReady,ratio>20?3:ratio>10?2:ratio<=5?-2:-1,'新品占比缺失'),
  ],
  newEntryBarrier:[
   item('new-ratio','新品占比',ratioReady,ratio>=20?4:ratio>=12?3:ratio>=6?1:0,'新品占比缺失'),
   item('new-efficiency','新品销量效率',efficiencyReady,efficiency>=.6?4:efficiency>=.35?2:0,'新品或样本均销缺失、分母无效'),
   item('low-reviews','低评论商品销量占比',reviewReady,lowReview>=15?4:lowReview>=8?2:0,'评论分布缺失'),
   item('concentration','商品集中度',pct(niche.productCrn),niche.productCrn!<40?3:niche.productCrn!<55?1:0,'商品集中度缺失'),
   item('aplus','A+配置机会',aplusReady,aplus!<50?2:aplus!<60?1:0,'A+覆盖比例缺失'),
   item('video','视频配置机会',videoReady,video!<50?2:video!<60?1:0,'视频覆盖比例缺失'),
   item('content-combined','A+与视频联合判断',aplusReady&&videoReady,aplus!<50&&video!<50?1:aplus!>=50&&video!>=50?-1:0,'A+或视频覆盖缺失，无法联合判断'),
  ],
  productOpportunity:[
   item('rating','中低评分销量占比',ratingReady,midRating>=15?5:midRating>=8?3:0,'评分值分布缺失'),
   item('views','浏览量趋势',viewsReady,viewsDir==='up'?4:viewsDir==='flat'?2:0,'商品浏览量趋势缺失或来源冲突'),
   item('concentration','商品集中度',pct(niche.productCrn),niche.productCrn!<40?3:niche.productCrn!<55?1:0,'商品集中度缺失'),
   item('returns','退货率差异',pct(niche.returnRatio)&&pct(niche.avgReturnRatio),(niche.returnRatio??0)>(niche.avgReturnRatio??0)+1?2:0,'类目或比较退货率缺失'),
  ],
  priceOpportunity:[
   item('priority','优先价格带',profitReady,price?.priorityOpportunities.length?6:0,'价格带结构或真实毛利样本不齐，不能确定优先价格带'),
   item('margin','高毛利价格带',profitReady,price?.highMarginOpportunities.length?3:0,'真实毛利样本不齐，不使用成本估算加分'),
   item('multiple','多个优先价格带',profitReady,(price?.priorityOpportunities.length??0)>1?2:0,'真实毛利样本不齐，无法完整比较价格带'),
   item('supply-demand','成交与供给价格带错位',priceReady,price?.demandBand&&price.supplyBand&&price.demandBand.label!==price.supplyBand.label?2:0,'价格带数量、销量或占比不足'),
  ],
 };
 const dimensions={} as Evaluation['dimensions'],scores={...raw.scores} as MarketOverviewOriginalSynthesis['summary']['scores'],sections={...legacy.summary.sections};
 for(const dim of MARKET_SYNTHESIS_DIMENSIONS){
  const items=lists[dim.key],known=items.filter(i=>i.status==='known').length,missing=[...new Set(items.flatMap(i=>i.missing))];
  dimensions[dim.key]={status:known===items.length?'ready':known?'partial':'insufficient',missing,items};
  const subtotal=dim.key==='marketDemand'?Math.round(clamp(sum(items.filter(i=>i.group==='scale')),20)*12.5/20+clamp(sum(items.filter(i=>i.group==='growth')),20)*12.5/20):Math.round(clamp(sum(items)+(dim.key==='marketMaturity'?10:0),dim.max));
  scores[dim.key]=known?subtotal:null;
  if(missing.length){
   const values=items.filter(i=>i.status==='known').map(i=>`${i.label} ${i.score!>0?'+':''}${Number(i.score!.toFixed(2))}`);
   sections[dim.sectionKey]=`${known?`已确认得分 ${subtotal}/${dim.max}，其余评分项待补齐。${dim.key==='marketMaturity'?'沿用原版基准10分及已知加减项。':''}${dim.key==='marketDemand'?'规模与增长分组分别按原版封顶后折算；以下为折算前分量。':''}${values.join('；')}。`:'尚无可确认评分项。'}待补齐：${missing.join('；')}。`;
  }else if(legacy.evaluation.dimensions[dim.key].status!=='ready'){
   // Only facts needed by score items are mandatory; prose may still lack data.
   sections[dim.sectionKey]=`各评分项已确认，得分 ${subtotal}/${dim.max}。${items.map(i=>`${i.label} ${i.score}`).join('；')}。`;
  }
 }
 sections.priceOpportunity=sections.priceOpportunity.replaceAll('广告前毛利','模型估算广告前毛利（非实际毛利）');
 const allReady=Object.values(dimensions).every(d=>d.status==='ready'),anyKnown=Object.values(scores).some(v=>v!==null);
 const evaluation:Evaluation={version:'observed-items/2',status:allReady?'ready':anyKnown?'partial':'insufficient',dimensions};
 const summary:MarketOverviewOriginalSynthesis['summary']={...legacy.summary,scores,sections};
 if(allReady){summary.score=raw.score;summary.grade=raw.grade;summary.gradeLabel=raw.gradeLabel;summary.gradeDefinition=raw.gradeDefinition;summary.finalVerdict=legacy.summary.score!==null?legacy.summary.finalVerdict:`${raw.gradeLabel}：${raw.gradeDefinition} 辅助文案仅展示已有依据。`;}
 else{summary.score=null;summary.grade=null;summary.gradeLabel=null;summary.gradeDefinition='已确认得分继续展示；待补齐项不按0分或默认分计入，也不折算总分。';summary.finalVerdict='部分评分项尚待补齐，当前仅展示已确认得分；可能的加分或扣分尚不完整，暂不生成总分与准入等级。';}
 return {summary,evaluation};
}
