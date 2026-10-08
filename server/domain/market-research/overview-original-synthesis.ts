import {overviewSourceMonth} from '../../../shared/market-overview-period';
import {projectOverviewProductDemand} from './overview-product-demand';
import type {MarketOverviewExternalData} from '../../../shared/market-overview-external';
import type {MarketAnalysisScope} from '../../../shared/market-analysis-contracts';
import type {MarketSourceEvidence} from '../../../shared/market-source-contracts';
import type {MarketOverviewIndustryDemand} from '../../../shared/market-overview-industry-demand';
import {MarketOverviewOriginalSynthesisSchema} from '../../../shared/market-overview-original-synthesis';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {mapNiche,distRows,parseProductDemand,crnRows} from './original-overview/original-mappers';
import {buildMarketOverviewSynthesis} from './original-overview/sellersprite-market-overview-synthesis';
import {buildCheckedOverviewSynthesis,type OverviewInputIssues} from './overview-score-readiness';
import {buildItemCheckedOverviewSynthesis} from './overview-item-scoring';
import type {SellerSpriteCrnRow,SellerSpriteDistRow,SellerSpriteMarketReport,SellerSpriteTrendPoint} from './original-overview/sellersprite-market-niche';

const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const distributions=[
 ['prices','market_price_distribution','价格分布'],['ratingCounts','market_ratings_count_distribution','评分数分布'],
 ['ratingValues','market_rating_distribution','评分值分布'],['listingAge','market_listing_date_distribution','上架时间分布'],
 ['listingTrend','market_listing_trend_distribution','上架趋势分布'],['ebc','market_ebc_distribution','A+视频分布'],
 ['countries','market_seller_country_distribution','卖家所属地分布'],['sellerTypes','market_seller_type_concentration','卖家类型分布'],
] as const;
const moneyKey=(key:string)=>/price|revenue|fba$/i.test(key)&&!/^fbaProportion$/i.test(key);

const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const unique=(values:string[])=>[...new Set(values)];
const rowShare=(row:Pick<SellerSpriteDistRow,'unitsShare'|'asinRatio'>)=>finite(row.unitsShare)?row.unitsShare:finite(row.asinRatio)?row.asinRatio:null;
const sumShares=(rows:readonly Pick<SellerSpriteDistRow,'unitsShare'|'asinRatio'>[])=>{
 const values=rows.map(rowShare),known=values.filter((value):value is number=>value!==null);
 return known.length===values.length?known.reduce((sum,value)=>sum+value,0):null;
};
type TrendAggregation='sum'|'last';
export function normalizeTrendPoints(points:readonly SellerSpriteTrendPoint[],aggregation:TrendAggregation='last'){
 const byMonth=new Map<string,number>();
 for(const point of points){
  const month=typeof point.month==='string'?point.month.slice(0,7):'';
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||typeof point.value!=='number'||!Number.isFinite(point.value)||point.value<0)continue;
  byMonth.set(month,aggregation==='sum'?(byMonth.get(month)??0)+point.value:point.value);
 }
 return [...byMonth.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([month,value])=>({month,value}));
}
export function rankConcentrationRows<T extends {label?:string;unitsShare?:number|null;units?:number|null}>(rows:readonly T[]){
 const share=(row:T)=>typeof row.unitsShare==='number'&&Number.isFinite(row.unitsShare)?row.unitsShare:null;
 return [...rows].sort((left,right)=>{
  const a=share(left),b=share(right);
  if(a===null&&b===null)return 0;
  if(a===null)return 1;
  if(b===null)return -1;
  return b-a;
 });
}
function consecutive(points:readonly SellerSpriteTrendPoint[]){
 return points.every((point,index)=>{
  if(index===0)return true;
  const [ay,am]=points[index-1].month.split('-').map(Number),[by,bm]=point.month.split('-').map(Number);
  return by*12+bm===ay*12+am+1;
 });
}
const trend=(points:readonly SellerSpriteTrendPoint[])=>{
 const clean=normalizeTrendPoints(points);
 if(clean.length<6)return 'unknown' as const;
 const recent=clean.slice(-6),prior=clean.slice(-12,-6),window=clean.slice(-12);
 if(prior.length<3)return 'unknown' as const;
 if(!consecutive(window))return 'unknown' as const;
 const avg=(items:readonly SellerSpriteTrendPoint[])=>items.reduce((sum,item)=>sum+item.value,0)/items.length;
 const base=avg(prior),change=base>0?(avg(recent)-base)/base:0;
 return change>0.05?'up' as const:change<-.05?'down' as const:'flat' as const;
};
const trendPhrase=(direction:ReturnType<typeof trend>,subject:string)=>direction==='up'?`${subject}正在增长`:direction==='down'?`${subject}正在收缩`:direction==='flat'?`${subject}相对稳定`:`${subject}趋势依据不足`;
export const buildSeasonalPhrase=(points:readonly SellerSpriteTrendPoint[],subject:string,aggregation:TrendAggregation='last')=>{
 const clean=normalizeTrendPoints(points,aggregation);
 if(clean.length<6)return `${subject}有效月份不足6个月，暂不能判断旺淡季。`;
 const sorted=[...clean].sort((a,b)=>a.value-b.value),middle=sorted[Math.floor(sorted.length/2)]?.value??0;
 if(middle<=0)return `${subject}基准值无效，暂不能判断旺淡季。`;
 const peaks=clean.filter(point=>point.value>=middle*1.56).map(point=>point.month);
 const lows=clean.filter(point=>point.value<=middle*.82).map(point=>point.month);
 if(!peaks.length&&!lows.length)return `${subject}未形成明显旺淡季。`;
 const displayMonths=(months:string[])=>{
  const distinct=unique(months),shown=distinct.slice(0,4).map(month=>clean.length>12?month:`${month.slice(5)}月`);
  return `${shown.join('、')}${distinct.length>shown.length?`等${distinct.length}个月`:''}`;
 };
 return `${peaks.length?`旺季集中在 ${displayMonths(peaks)}`:'未识别明显旺季'}${lows.length?`，淡季集中在 ${displayMonths(lows)}`:'，未识别明显淡季'}；旺季前2–3个月需提前安排备货。`;
};
const mixConclusion=(rows:readonly SellerSpriteDistRow[],label:string)=>{
 const top=rows[0];if(!top)return `暂无${label}有效分组，不能判断经营模式。`;
 const products=rows.reduce((sum,row)=>sum+(row.products??0),0),units=rows.reduce((sum,row)=>sum+(row.units??0),0);
 const productShare=products>0&&top.products!=null?top.products/products*100:null,unitShare=units>0&&top.units!=null?top.units/units*100:rowShare(top);
 if(productShare==null||unitShare==null)return `${label}最高分组为“${top.label}”，销量/链接占比 ${unitShare==null?'未知':unitShare.toFixed(1)+'%'}；商品数与销量分母不完整，暂不能判断经营效率。`;
 const gap=unitShare-productShare;
 if(gap>=15)return `“${top.label}”商品占比 ${productShare.toFixed(1)}%，销量占比 ${unitShare.toFixed(1)}%，经营效率明显更高；市场对该类型的履约与库存能力要求更高。`;
 if(gap<=-15)return `“${top.label}”商品占比 ${productShare.toFixed(1)}%，但销量占比仅 ${unitShare.toFixed(1)}%，链接供给多于实际成交；经营模式仍较分散。`;
 return `${label}最高分组为“${top.label}”，商品占比 ${productShare.toFixed(1)}%、销量占比 ${unitShare.toFixed(1)}%接近，经营模式相对多元，履约竞争并未集中于单一类型。`;
};
const countryConclusion=(rows:readonly SellerSpriteDistRow[])=>{
 const top=rows[0];if(!top)return '暂无卖家所属地有效分组，不能判断地域竞争。';
 const products=rows.reduce((sum,row)=>sum+(row.products??0),0),units=rows.reduce((sum,row)=>sum+(row.units??0),0);
 const productShare=products>0&&top.products!=null?top.products/products*100:null,unitShare=units>0&&top.units!=null?top.units/units*100:rowShare(top);
 if(productShare==null||unitShare==null)return `卖家所属地最高分组为“${top.label}”，但商品数或销量分母不完整，暂不能判断地域效率。`;
 const gap=unitShare-productShare;
 return gap>=15?`“${top.label}”商品占比 ${productShare.toFixed(1)}%，销量占比 ${unitShare.toFixed(1)}%，已形成明显经营效率与供应链优势。`:gap<=-15?`“${top.label}”商品占比 ${productShare.toFixed(1)}%，销量占比 ${unitShare.toFixed(1)}%，供给数量多但平均经营效率偏低。`:`“${top.label}”占据主要分组，但商品与销量占比差距有限，地域集中度与经营效率仍需结合其他分组判断。`;
};
const reviewConclusion=(rows:readonly SellerSpriteDistRow[])=>{
 const low=rows.filter(row=>/^(?:<|＜)?\s*(?:50|100)|50-100|100-300/.test(row.label)),high=rows.filter(row=>/500|1000|以上|>/.test(row.label));
 const lowShare=sumShares(low),highShare=sumShares(high);
 if(lowShare!=null&&lowShare>=15)return `低 Review 区间仍贡献约 ${lowShare.toFixed(1)}% 销量，新品不需要很高 Review 也有机会进入主流成交。`;
 if(highShare!=null&&highShare>=55)return `高 Review 区间贡献约 ${highShare.toFixed(1)}% 销量，Review 积累壁垒较高，新品需要预留评论增长周期。`;
 return 'Review 区间分布较分散，需结合低 Review 与高 Review 销量份额评估进入壁垒。';
};
const ratingConclusion=(rows:readonly SellerSpriteDistRow[])=>{
 const mid=sumShares(rows.filter(row=>/4\.0|4\.1|4\.2|4\.3|＜4|<4/.test(row.label)));
 if(mid!=null&&mid>=15)return `4.0–4.3 分区间贡献约 ${mid.toFixed(1)}% 销量，需求已经验证但满意度一般，存在产品体验优化空间。`;
 const high=sumShares(rows.filter(row=>/4\.6|4\.7|4\.8|4\.9|5\.0|以上/.test(row.label)));
 return high!=null&&high>=55?`高评分区间贡献约 ${high.toFixed(1)}% 销量，现有产品体验较成熟，单纯优化评分的空间有限。`:'评分值分布不足以判断品质门槛，需结合评论文本确认具体痛点。';
};

function buildChapterExplanations(niche:ReturnType<typeof mapNiche>, report:SellerSpriteMarketReport, refs:readonly string[], parameters:{headTopN:5|10|20;newProductMonths:1|3|6|12}) {
 const value=(input:unknown)=>typeof input==='number'&&Number.isFinite(input)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(input):'未知';
 const pct=(input:unknown)=>typeof input==='number'&&Number.isFinite(input)?`${value(input)}%`:'未知';
 const rows=(key:keyof SellerSpriteMarketReport)=>Array.isArray(report[key])?report[key] as readonly unknown[]:[];
 const withData=(id:string,hasData:boolean,performance:string,meaning:string,conclusion:string,missing:string[]=[])=>(
   {id,status:hasData?(missing.length?'partial':'ready'):'insufficient',performance,meaning,conclusion,missing,sourceRefs:[...refs]});
 const rawKeywordPoints=report.keywordTrends.flatMap(s=>s.points);
 const keywordPoints=normalizeTrendPoints(rawKeywordPoints,'sum');
 const salesTrend=normalizeTrendPoints(report.salesTrend,'last');
 const amountTrend=normalizeTrendPoints(report.salesAmountTrend,'last');
 const demandPoints=keywordPoints.length;
 const salesPoints=salesTrend.length;
 const amountPoints=amountTrend.length;
 const commonMonths=new Set(salesTrend.map(point=>point.month).filter(month=>amountTrend.some(point=>point.month===month)));
 const alignedSales=salesTrend.filter(point=>commonMonths.has(point.month));
 const alignedAmount=amountTrend.filter(point=>commonMonths.has(point.month));
 const productRows=rankConcentrationRows(rows('products') as readonly SellerSpriteCrnRow[]),brandRows=rankConcentrationRows(rows('brands') as readonly SellerSpriteCrnRow[]),sellerRows=rankConcentrationRows(rows('sellers') as readonly SellerSpriteCrnRow[]);
 const rankedReport={...report,products:productRows,brands:brandRows,sellers:sellerRows};
 const original=buildMarketOverviewSynthesis(niche,rankedReport);
 const coreCrnReady=niche.productCrn!==null&&niche.brandCrn!==null&&niche.sellerCrn!==null;
 const coreScaleReady=niche.totalUnits!==null&&niche.sampleProducts!==null;
 const overviewReady=coreScaleReady&&coreCrnReady&&niche.newRatio!==null&&niche.avgUnits!==null&&niche.newAvgUnits!==null&&report.keywordTrends.length>0&&report.salesTrend.length>0&&(report.productDemand?.pageViews.length??0)>0&&report.prices.length>0&&report.listingAge.length>0&&report.ratingCounts.length>0&&report.ratingValues.length>0&&report.ebc.length>0;
 const keywordDirection=trend(keywordPoints),salesDirection=trend(salesTrend),amountDirection=trend(amountTrend);
 const dynamicDemand=coreScaleReady&&demandPoints>=6
   ?`${trendPhrase(keywordDirection,'搜索需求')}；${buildSeasonalPhrase(keywordPoints,'搜索需求')}${keywordDirection==='up'?' 市场需求旺盛，且需求仍在扩张。':keywordDirection==='down'?' 市场需求正在收缩，应谨慎进入。':' 市场需求稳定，属于成熟型需求市场。'}`
   :null;
 const dynamicSales=coreScaleReady&&salesPoints>=6
   ?`${trendPhrase(salesDirection,'行业销量')}；${commonMonths.size>=6&&alignedSales.length>=6&&alignedAmount.length>=6&&amountDirection!=='unknown'&&salesDirection!=='unknown'?(amountDirection==='up'&&salesDirection!=='up'?'销售额增长快于销量，可能存在客单价提升或产品升级。':salesDirection==='up'&&amountDirection!=='up'?'销量增长快于销售额，可能存在低价带增长或价格竞争。':salesDirection==='up'&&amountDirection==='up'?'销量与销售额同步增长，市场处于真实增长阶段。':'销量与销售额联动相对稳定。'):'销量与销售额共同月份不足，暂不判断客单价变化。'} ${buildSeasonalPhrase(salesTrend,'销售')}`
   :null;
 const dynamicMaturity=report.listingAge.length>0&&niche.newRatio!==null?original.sections.maturity:null;
 const dynamicReview=report.ratingCounts.length>0?reviewConclusion(report.ratingCounts):null;
 const dynamicProductOpportunity=report.ratingValues.length>0||report.productDemand?.pageViews.length?original.sections.productOpportunity:null;
 const dynamicPrice=report.prices.length>0?original.sections.priceOpportunity:null;
 const dynamicDistribution=(key:keyof SellerSpriteMarketReport,label:string)=>{
  const list=rankConcentrationRows(rows(key) as readonly {label?:string;unitsShare?:number|null;units?:number|null}[]);
  const top=list[0],share=top?.unitsShare;
  return top?`${label}最高分组为“${String(top.label??'未知')}”，销量占比 ${pct(share)}；其余分组需结合完整样本和来源范围判断。`:`暂无${label}有效分组，不能形成该章节结论。`;
 };
 const ebcConclusion=report.ebc.length>0&&niche.ebcProportion!==null?original.sections.newEntry:null;
 const sellerTypeConclusion=report.sellerTypes.length>0?mixConclusion(rankConcentrationRows(report.sellerTypes),'卖家类型'):null;
 const countryConclusionText=report.countries.length>0?countryConclusion(rankConcentrationRows(report.countries)):null;
 const listingTrendDirection=trend(salesTrend);
 const listingTrendConclusion=report.listingTrend.length>0
   ?niche.newRatio!=null&&niche.newRatio>=10&&listingTrendDirection==='up'?'新品持续增加且市场需求同步增长，市场处于成长阶段。'
     :niche.newRatio!=null&&niche.newRatio>=10&&(listingTrendDirection==='flat'||listingTrendDirection==='down')?'新增供给可能快于需求增长，未来竞争可能进一步加剧。'
     :niche.newRatio!=null&&niche.newRatio<10&&listingTrendDirection==='down'?'新品减少且销量走弱，市场吸引力下降。'
     :'上架趋势已保存，但缺少与需求或销量同窗数据，暂不能判断成长或竞争方向。'
   :null;
 const productShare=productRows.slice(0,3).map(row=>row.unitsShare).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));
 const top3=productShare.length?productShare.reduce((a,b)=>a+b,0):null;
 const concentrationConclusion=(list:readonly SellerSpriteCrnRow[],label:string)=>{
  const known=list.filter(row=>typeof row.unitsShare==='number'&&Number.isFinite(row.unitsShare));
  const top=known[0],top3Share=known.slice(0,3).reduce((sum,row)=>sum+(row.unitsShare??0),0);
  if(!top)return `暂无${label}有效销量份额，不能形成集中度结论。`;
  return `${label}头部为“${top.label}”，销量占比 ${pct(top.unitsShare)}；Top3销量份额 ${pct(top3Share)}。该结果仅代表本次保存的 Top${parameters.headTopN} 样本，不外推全市场。`;
 };
 const salesMissing=unique([
  ...(salesPoints<2?['行业销量趋势有效月份不足']:[]),
  ...(amountPoints===0?['销售额趋势缺失']:[]),
  ...(amountPoints>0&&commonMonths.size<6?['销量与销售额共同月份不足6个月']:[]),
 ]);
 const keywordMissing=keywordPoints.length<6||keywordDirection==='unknown'?['关键词有效月份不足或月份不连续']:[];
 const dist=(key:keyof SellerSpriteMarketReport,label:string,id=String(key))=>{const count=rows(key).length;return withData(id,count>0,`${label}已保存 ${count} 个分组。`,`分组反映本次返回样本的构成，不能直接外推全市场。`,count?`${label}可用于比较各组占比；需结合来源范围和缺失项判断。`:`暂无可用分组，不能形成该章节结论。`,count?[]:[`${label}来源未返回有效分组`]);};
 return [
  withData('overview',niche.totalUnits!==null||niche.sampleProducts!==null,`样本商品 ${value(niche.sampleProducts)}，销量 ${value(niche.totalUnits)}，品牌 ${value(niche.brands)}，卖家 ${value(niche.sellers)}。`,'基础指标描述当前保存样本的规模与结构，不等于全类目总量。',overviewReady?original.finalVerdict:'规模、集中度和新品指标需在输入齐全时联合判断。',Object.entries({totalUnits:niche.totalUnits,sampleProducts:niche.sampleProducts,brands:niche.brands,sellers:niche.sellers}).filter(([,v])=>v===null).map(([k])=>`${k}缺失`)),
  withData('demand-keywords',demandPoints>0,`关键词趋势汇总覆盖 ${demandPoints} 个有效月份（原始观测点 ${rawKeywordPoints.length} 个）。`,'先按月份汇总关键词搜索量，再判断需求方向和季节性；重复、缺失或不连续月份不作为完整季节性依据。',dynamicDemand??(demandPoints>=6?'可结合窗口趋势判断需求方向；旺季月份和备货提前期仍需完整月序列。':'当前观测不足，先补齐关键词趋势再判断旺淡季。'),keywordMissing),
  withData('sales-trend',salesPoints>0,`行业销量趋势覆盖 ${salesPoints} 个有效月份；销售额趋势覆盖 ${amountPoints} 个有效月份，共同月份 ${commonMonths.size} 个。`,'销量与销售额必须按相同月份和相同类目范围对齐；销售额由已保存的同月数据推算时必须注明来源。',dynamicSales??(salesPoints>=2?'可比较最近与前段变化；缺月不补零。':'只有一个或没有月份，不能判断升降趋势。'),salesMissing),
  withData('product-crn',productRows.length>0,`商品集中度返回 ${productRows.length} 条排名明细；Top1-3销量份额合计 ${pct(top3)}。`,'头部份额反映本次保存样本内商品集中程度，先按销量份额排序；TopN必须与请求参数一致。',productRows.length?concentrationConclusion(productRows,'商品集中度'):'缺少商品排名，无法判断商品集中度。',productRows.length?[]:['商品集中度排名缺失']),
  withData('brand-crn',brandRows.length>0,`品牌集中度返回 ${brandRows.length} 条排名明细；头部品牌销量占比 ${pct(brandRows[0]?.unitsShare)}。`,'品牌份额反映本次保存样本内品牌结构和潜在品牌壁垒，不能替代商品集中度。',brandRows.length?concentrationConclusion(brandRows,'品牌集中度'):'缺少品牌排名，无法判断品牌壁垒。',brandRows.length?[]:['品牌集中度排名缺失']),
  withData('seller-crn',sellerRows.length>0,`卖家集中度返回 ${sellerRows.length} 条排名明细；头部卖家销量占比 ${pct(sellerRows[0]?.unitsShare)}。`,'卖家份额反映经营主体集中程度，不等同品牌集中度；结论仅限本次保存样本。',sellerRows.length?concentrationConclusion(sellerRows,'卖家集中度'):'缺少卖家排名，无法判断经营主体集中度。',sellerRows.length?[]:['卖家集中度排名缺失']),
  withData('seller-type',rows('sellerTypes').length>0,`卖家类型分布保存 ${rows('sellerTypes').length} 个分组。`,'卖家类型反映经营主体结构，不能直接等同品牌或商品集中度。',sellerTypeConclusion??dynamicDistribution('sellerTypes','卖家类型'),rows('sellerTypes').length?[]:['卖家类型分布缺失']),
  withData('ebc',rows('ebc').length>0,`A+视频分布保存 ${rows('ebc').length} 个分组。`,'A+与视频覆盖反映内容门槛；覆盖率缺失时不能推断新品友好程度。',ebcConclusion??dynamicDistribution('ebc','A+视频'),rows('ebc').length?[]:['A+视频分布缺失']),
  withData('seller-country',rows('countries').length>0,`卖家所属地分布保存 ${rows('countries').length} 个分组。`,'卖家所属地反映供给来源结构，不能直接推断本地履约或竞争强度。',countryConclusionText??dynamicDistribution('countries','卖家所属地'),rows('countries').length?[]:['卖家所属地分布缺失']),
  withData('product-demand',!!report.productDemand&&report.productDemand.pageViews.length>0,`商品浏览趋势保存 ${report.productDemand?.pageViews.length??0} 个观测点，退货率 ${pct(report.productDemand?.returnRatio)}。`,'浏览、退货和搜索购买比共同描述需求质量；缺一项时不能替代完整判断。',dynamicProductOpportunity??(report.productDemand?.pageViews.length?'可结合趋势和退货/转化指标判断需求质量，缺失指标保留待验证。':'暂无浏览量趋势，无法判断商品需求质量。'),report.productDemand?.pageViews.length?[]:['商品浏览量趋势缺失']),
  withData('listing-age',rows('listingAge').length>0,`上架时间分布保存 ${rows('listingAge').length} 个分组。`,'上架年龄用于判断老品沉淀与新品进入窗口。',dynamicMaturity??(rows('listingAge').length?'需结合老品、新品占比判断市场成熟度。':'暂无上架时间分布，无法判断市场成熟度。'),rows('listingAge').length?[]:['上架时间分布缺失']),
  withData('listing-trend',rows('listingTrend').length>0,`上架趋势分布保存 ${rows('listingTrend').length} 个分组。`,'上架趋势用于判断新品供给是否持续进入。',listingTrendConclusion??dynamicDistribution('listingTrend','上架趋势'),rows('listingTrend').length?[]:['上架趋势分布缺失']),
  withData('rating-count',rows('ratingCounts').length>0,`评分数分布保存 ${rows('ratingCounts').length} 个分组。`,'评论数量是新品建立信任和获取转化的门槛代理指标。',dynamicReview??(rows('ratingCounts').length?'需结合高评论与低评论区间份额判断评论壁垒。':'暂无评分数分布，无法判断评论壁垒。'),rows('ratingCounts').length?[]:['评分数分布缺失']),
  withData('rating-value',rows('ratingValues').length>0,`评分值分布保存 ${rows('ratingValues').length} 个分组。`,'评分值用于识别体验问题集中区间，不能代替评论文本中的具体痛点。',rows('ratingValues').length?ratingConclusion(report.ratingValues):dynamicProductOpportunity??'暂无评分值分布，无法判断体验机会。',rows('ratingValues').length?[]:['评分值分布缺失']),
  withData('price',rows('prices').length>0,`价格带保存 ${rows('prices').length} 个分组，均价 ${value(niche.avgPrice)}。`,'价格带明细用于比较链接数、销量份额、需求效率和已取得毛利率，缺失项不能补算。',dynamicPrice??(rows('prices').length?'可按价格带筛选切入区间；利润与需求效率缺失时结论只能部分成立。':'暂无价格带，无法形成价格结构结论。'),rows('prices').length?[]:['价格带分布缺失'])
 ];
}

/** Pure projection of receipts already verified by the frozen-catalog reader. No fetching or cross-module lookup. */
export function projectMarketOverviewOriginalSynthesis(input:{scope:MarketAnalysisScope;parameters:{headTopN:5|10|20;newProductMonths:1|3|6|12};sources:readonly MarketSourceEvidence[];industryDemand?:MarketOverviewIndustryDemand;externalData?:MarketOverviewExternalData;scoringVersion?:'observed-inputs/1'|'observed-items/2'}){
 const {scope,parameters}=input,month=scope.toMonth;
 const gaps=new Set<string>(),refs=new Set<string>();
 const inputIssues:OverviewInputIssues={};
 const source=(operation:string)=>input.sources.find(s=>s.provider==='sellerSprite'&&s.operation===operation&&s.scope.organizationId===scope.organizationId&&s.scope.researchId===scope.researchId&&s.scope.marketplace===scope.marketplace&&s.scope.nodeIdPath===scope.nodeIdPath&&s.scope.currency===scope.currency&&s.requestIdentity.marketplace===scope.marketplace&&s.requestIdentity.nodeIdPath===scope.nodeIdPath&&overviewSourceMonth(s)===month&&(scope.overviewPeriod==='last30'?s.observationPeriod.kind==='trailing-days'&&s.observationPeriod.days===30:s.observationPeriod.kind==='calendar-months'&&s.observationPeriod.fromMonth===month&&s.observationPeriod.toMonth===month));
 const remember=(s:MarketSourceEvidence)=>refs.add(`market-source:${digest(s)}`);
 const currencyValid=(s:MarketSourceEvidence,r:Record<string,unknown>)=>s.responseIdentity.currency.echoes.every(e=>e.value===scope.currency)&&(r.currency===undefined||r.currency===scope.currency);
 const sanitize=(raw:Record<string,unknown>,s:MarketSourceEvidence,label:string):Record<string,unknown>=>{
  const row={...raw};
  for(const [key,value] of Object.entries(row)){
   const unit=s.units[key];
   if(moneyKey(key)&&(!currencyValid(s,row)||unit?.status==='unknown'||unit?.status==='known'&&(unit.unit!=='currency'||unit.currency!==scope.currency))){delete row[key];gaps.add(`${label}的金额币种未确认，相关金额按原版缺失输入处理。`);}
   // Numeric mapping preserves missing values; invalid numbers never become observations.
   else if(typeof value==='number'&&!Number.isFinite(value)){delete row[key];gaps.add(`${label}含无效数值，已按原版缺失输入处理。`);}
  }
  return row;
 };
 const aggregate=(operation:string,label:string)=>{
  const s=source(operation);if(!s){gaps.add(`${label}：未采集同一研究、类目、站点和月份的数据。`);return {};}
  const raw=obj(obj(s.payload).data??s.payload);
  const candidates=operation==='market_research'?(Array.isArray(raw.items)?raw.items.map(obj).filter(r=>r.nodeIdPath===scope.nodeIdPath||r.nodeIdPath===undefined&&String(r.nodeId??'')===scope.nodeIdPath.split(':').at(-1)):[]):[raw].filter(r=>r.nodeIdPath===undefined||r.nodeIdPath===scope.nodeIdPath);
  if(candidates.length!==1){gaps.add(`${label}：未找到唯一匹配的类目记录。`);return {};}
  remember(s);return sanitize(candidates[0],s,label);
 };
 const main=aggregate('market_research','市场研究汇总'),stats=aggregate('market_research_statistics','市场统计汇总');
 const niche=mapNiche(main,stats,{marketplace:scope.marketplace,topN:parameters.headTopN,newProductMonths:parameters.newProductMonths,fetchedAt:''});
 for(const [key,label] of Object.entries({totalUnits:'市场总销量',productCrn:'商品集中度',brandCrn:'品牌集中度',sellerCrn:'卖家集中度',newRatio:'新品占比',avgUnits:'平均销量',newAvgUnits:'新品平均销量',avgRating:'平均评分',ebcProportion:'A+覆盖比例',amazonSelfProportion:'亚马逊自营比例',fbaProportion:'FBA比例',returnRatio:'退货率',avgReturnRatio:'平均退货率',searchToPurchaseRatio:'搜索购买转化率'})){
  if(niche[key as keyof typeof niche]===null)gaps.add(`${label}缺失，不使用默认值代替。`);
 }
 const report:SellerSpriteMarketReport={sampleSize:100,concentrationSampleSize:100,productDemand:null,products:[],brands:[],sellers:[],sellerTypes:[],ebc:[],countries:[],listingAge:[],listingTrend:[],ratingCounts:[],ratingValues:[],prices:[],keywordTrends:[],salesTrend:[],salesAmountTrend:[]};
 for(const [key,operation,label] of distributions){
  const s=source(operation);if(!s){gaps.add(`${label}缺失，保留原版空分布判断。`);continue;}
  const raw=obj(s.payload).data??s.payload,container=obj(raw);
  if(container.nodeIdPath!==undefined&&container.nodeIdPath!==scope.nodeIdPath){gaps.add(`${label}类目不匹配，保留原版空分布判断。`);continue;}
  // Prices encode currency in their labels, so reject explicit currency conflicts.
  if(key==='prices'&&!currencyValid(s,container)){gaps.add('价格分布币种未确认，保留原版空分布判断。');continue;}
  const rows=Array.isArray(raw)?raw:Array.isArray(container.items)?container.items:[];
  const clean=rows.map(item=>{
   const row=sanitize(obj(item),s,label);
   for(const productsKey of ['asins','items','productList'])if(Array.isArray(row[productsKey]))row[productsKey]=(row[productsKey] as unknown[]).map(product=>typeof product==='string'?product:sanitize(obj(product),s,label));
   return row;
  });
  report[key]=distRows(clean,r=>String(r.label||(key==='countries'?r.country:key==='listingAge'?r.shelfTime:'')||''));
  if(['prices','ratingCounts','ratingValues','listingAge','ebc'].includes(key)&&s.coverage.truncation.status==='truncated')inputIssues[key as keyof OverviewInputIssues]=[`${label}来源被截断，分布不完整`];
  remember(s);if(!report[key].length)gaps.add(`${label}为空，保留原版空分布判断。`);
 }
 for(const [key,kind,label] of [['products','product','商品集中度'],['brands','brand','品牌集中度'],['sellers','seller','卖家集中度']] as const){
  const s=source(`market_${kind}_concentration`);
  if(!s){gaps.add(`${label}排名明细缺失，保留原版空排名判断。`);continue;}
  const raw=obj(s.payload).data??s.payload,container=obj(raw);
  if(container.nodeIdPath!==undefined&&container.nodeIdPath!==scope.nodeIdPath){gaps.add(`${label}排名类目不匹配，保留原版空排名判断。`);continue;}
  const rows=Array.isArray(raw)?raw:Array.isArray(container.items)?container.items:[];
  report[key]=crnRows(rows.map(r=>sanitize(obj(r),s,label)),kind);
  remember(s);if(!report[key].length)gaps.add(`${label}排名来源返回空数据，保留原版空排名判断。`);
 }
 const demand=input.industryDemand;
 if(demand&&demand.referenceMonth===month){
  if(demand.status!=='ready'||demand.series.some(s=>s.status!=='ready'))inputIssues.keywords=['选定关键词尚有未完成或缺失的来源'];
  report.keywordTrends=demand.series.filter(s=>s.status==='ready'&&s.sourceRef&&s.points.length).map(s=>({keyword:s.keyword,searches:s.searches,points:s.points.map(p=>({...p}))}));
  if(input.scoringVersion==='observed-items/2'){
   // The frozen keyword query can contain observed monthly searches even when
   // its independent history fetch failed. Do not discard that observation.
   report.keywordTrends=demand.series.map(s=>({keyword:s.keyword,searches:s.searches,points:s.status==='ready'&&s.sourceRef?s.points.map(p=>({...p})):[]}));
   if(demand.status==='failed'||demand.issues.some(i=>i.operation==='keyword_research'))inputIssues.keywordSearches=['关键词查询来源未完整就绪'];
  }
  for(const series of demand.series)if(series.status==='ready'&&series.sourceRef)refs.add(series.sourceRef);
 }
 if(!report.keywordTrends.length)gaps.add('行业关键词需求趋势缺失，保留原版空趋势判断。');
 if(input.externalData&&input.externalData.referenceMonth===month){
  report.salesTrend=input.externalData.salesTrend.points;report.salesAmountTrend=input.externalData.salesAmountTrend.points;report.asinProfits=input.externalData.asinProfits.items;
  for(const [key,label] of [['salesTrend','行业销量趋势'],['salesAmountTrend','行业销售额趋势'],['asinProfits','价格带商品毛利率']] as const){const value=input.externalData[key];for(const ref of value.sourceRefs)refs.add(ref);if(value.status!=='ready')gaps.add(`${label}：${value.status==='failed'?'采集失败':value.status==='empty'?'来源返回空数据':value.status==='not-collected'?'尚未采集':'部分数据缺失'}${value.errorCode?`（${value.errorCode}）`:''}。`);}
  if(input.externalData.salesTrend.status!=='ready')inputIssues.sales=['行业销量来源未完整就绪'];
  if(input.externalData.salesAmountTrend.status!=='ready')inputIssues.amount=['行业销售额来源未完整就绪'];
 }else gaps.add('原版行业销量及销售额趋势依赖 Sorftime 类目销量与均价，当前冻结目录未采集，保留空趋势。');
 const productDemandSource=source('market_product_demand_trend');
 if(productDemandSource){
  const raw=obj(obj(productDemandSource.payload).data??productDemandSource.payload);
  if(raw.nodeIdPath===undefined||raw.nodeIdPath===scope.nodeIdPath){
   if(input.externalData){const normalized=projectOverviewProductDemand([productDemandSource],month,[]);report.productDemand={asinCount:normalized.asinCount,returnRatio:normalized.returnRatio,avgReturnRatio:normalized.avgReturnRatio,searchToPurchaseRatio:normalized.searchToPurchaseRatio,avgSearchToPurchaseRatio:normalized.avgSearchToPurchaseRatio,pageViews:normalized.points,updatedAt:normalized.points.at(-1)?.month??null};if(normalized.errorCode){gaps.add(`商品浏览量趋势部分数据不可用（${normalized.errorCode}），仅使用已验证月份。`);inputIssues.views=[`商品浏览量趋势存在来源冲突（${normalized.errorCode}）`];}}
   else report.productDemand=parseProductDemand(raw,{totalProducts:niche.totalProducts,returnRatio:niche.returnRatio,avgReturnRatio:niche.avgReturnRatio,searchToPurchaseRatio:niche.searchToPurchaseRatio});
   if(productDemandSource.coverage.truncation.status==='truncated')inputIssues.views=[...(inputIssues.views??[]),'商品浏览量来源被截断'];
   remember(productDemandSource);
   if(!report.productDemand.pageViews.length)gaps.add('商品浏览量趋势来源返回空数据，保留原版空趋势判断。');
  }else gaps.add('商品浏览量趋势类目不匹配，保留原版空趋势判断。');
 }else gaps.add('商品浏览量趋势未采集，保留原版空趋势判断。');
 if(!Object.values(report.asinProfits??{}).some(p=>p.profit!==null)&&!report.prices.some(r=>r.items?.some(p=>p.profit!=null)))gaps.add('价格带商品毛利率样本缺失，未使用平均毛利率或跨模块数据补齐。');
 const checked=input.scoringVersion==='observed-items/2'?buildItemCheckedOverviewSynthesis(niche,report,inputIssues):buildCheckedOverviewSynthesis(niche,report,inputIssues);
 for(const dimension of Object.values(checked.evaluation!.dimensions))for(const gap of dimension.missing)gaps.add(gap);
 const sourceRefs=[...refs],chapters=buildChapterExplanations(niche,report,sourceRefs,parameters);
 return MarketOverviewOriginalSynthesisSchema.parse({version:6,...checked,inputGaps:[...gaps].map(g=>g.replace(/保留原版空(分布|排名|趋势)判断/g,'相关判断须以有效输入为依据')),sourceRefs,chapters,originalAssumptions:[
  '沿用原版第6版评分权重、阈值和完整输入下的结论；缺失输入不补默认分，六维未齐全时不输出总分或准入等级。',
  `缺失校验版本 ${input.scoringVersion??'observed-inputs/1'}：真实0保留；null、空字符串和无效数字不当作0。当前结果根据保存来源重新计算，不覆盖历史快照。`,
  `集中度使用保存的 Top ${parameters.headTopN}，新品数据使用保存的 ${parameters.newProductMonths} 个月窗口；原版部分分析文案固定写作近6个月。`,
  '分布比例直接采用原始接口比例；价格毛利率仅使用该分布内商品的原始毛利率。',
  '来源未回显确认月份或类目时，按本报告保存的请求范围绑定使用，不代表响应已确认范围。',
  '金额币种无回显时沿用冻结请求绑定的站点和币种；明确冲突的金额数据不参与分析。',
  '原版金额分析文案固定使用美元符号；其他币种仍保留该原版文案限制。',
 ]});
}
