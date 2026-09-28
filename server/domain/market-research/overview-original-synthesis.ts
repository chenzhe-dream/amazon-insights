import {projectOverviewProductDemand} from './overview-product-demand';
import type {MarketOverviewExternalData} from '../../../shared/market-overview-external';
import type {MarketAnalysisScope} from '../../../shared/market-analysis-contracts';
import type {MarketSourceEvidence} from '../../../shared/market-source-contracts';
import type {MarketOverviewIndustryDemand} from '../../../shared/market-overview-industry-demand';
import {MarketOverviewOriginalSynthesisSchema} from '../../../shared/market-overview-original-synthesis';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {mapNiche,distRows,parseProductDemand,crnRows} from './original-overview/original-mappers';
import {buildMarketOverviewSynthesis} from './original-overview/sellersprite-market-overview-synthesis';
import type {SellerSpriteMarketReport} from './original-overview/sellersprite-market-niche';

const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const distributions=[
 ['prices','market_price_distribution','价格分布'],['ratingCounts','market_ratings_count_distribution','评分数分布'],
 ['ratingValues','market_rating_distribution','评分值分布'],['listingAge','market_listing_date_distribution','上架时间分布'],
 ['listingTrend','market_listing_trend_distribution','上架趋势分布'],['ebc','market_ebc_distribution','A+视频分布'],
 ['countries','market_seller_country_distribution','卖家所属地分布'],['sellerTypes','market_seller_type_concentration','卖家类型分布'],
] as const;
const moneyKey=(key:string)=>/price|revenue|fba$/i.test(key)&&!/^fbaProportion$/i.test(key);

/** Pure projection of receipts already verified by the frozen-catalog reader. No fetching or cross-module lookup. */
export function projectMarketOverviewOriginalSynthesis(input:{scope:MarketAnalysisScope;parameters:{headTopN:5|10|20;newProductMonths:1|3|6|12};sources:readonly MarketSourceEvidence[];industryDemand?:MarketOverviewIndustryDemand;externalData?:MarketOverviewExternalData}){
 const {scope,parameters}=input,month=scope.toMonth;
 const gaps=new Set<string>(),refs=new Set<string>();
 const source=(operation:string)=>input.sources.find(s=>s.provider==='sellerSprite'&&s.operation===operation&&s.scope.organizationId===scope.organizationId&&s.scope.researchId===scope.researchId&&s.scope.marketplace===scope.marketplace&&s.scope.nodeIdPath===scope.nodeIdPath&&s.scope.currency===scope.currency&&s.requestIdentity.marketplace===scope.marketplace&&s.requestIdentity.nodeIdPath===scope.nodeIdPath&&s.requestIdentity.month===month&&s.observationPeriod.kind==='calendar-months'&&s.observationPeriod.fromMonth===month&&s.observationPeriod.toMonth===month);
 const remember=(s:MarketSourceEvidence)=>refs.add(`market-source:${digest(s)}`);
 const currencyValid=(s:MarketSourceEvidence,r:Record<string,unknown>)=>s.responseIdentity.currency.echoes.every(e=>e.value===scope.currency)&&(r.currency===undefined||r.currency===scope.currency);
 const sanitize=(raw:Record<string,unknown>,s:MarketSourceEvidence,label:string):Record<string,unknown>=>{
  const row={...raw};
  for(const [key,value] of Object.entries(row)){
   const unit=s.units[key];
   if(moneyKey(key)&&(!currencyValid(s,row)||unit?.status==='unknown'||unit?.status==='known'&&(unit.unit!=='currency'||unit.currency!==scope.currency))){delete row[key];gaps.add(`${label}的金额币种未确认，相关金额按原版缺失输入处理。`);}
   // Preserve original null/empty-to-zero coercion, but never admit invalid non-finite values.
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
  if(niche[key as keyof typeof niche]===null)gaps.add(`${label}缺失，保留原版对应默认判断。`);
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
  report.keywordTrends=demand.series.filter(s=>s.status==='ready'&&s.sourceRef&&s.points.length).map(s=>({keyword:s.keyword,searches:s.searches,points:s.points.map(p=>({...p}))}));
  for(const series of demand.series)if(series.status==='ready'&&series.sourceRef)refs.add(series.sourceRef);
 }
 if(!report.keywordTrends.length)gaps.add('行业关键词需求趋势缺失，保留原版空趋势判断。');
 if(input.externalData){
  report.salesTrend=input.externalData.salesTrend.points;report.salesAmountTrend=input.externalData.salesAmountTrend.points;report.asinProfits=input.externalData.asinProfits.items;
  for(const [key,label] of [['salesTrend','行业销量趋势'],['salesAmountTrend','行业销售额趋势'],['asinProfits','价格带商品毛利率']] as const){const value=input.externalData[key];for(const ref of value.sourceRefs)refs.add(ref);if(value.status!=='ready')gaps.add(`${label}：${value.status==='failed'?'采集失败':value.status==='empty'?'来源返回空数据':value.status==='not-collected'?'尚未采集':'部分数据缺失'}${value.errorCode?`（${value.errorCode}）`:''}。`);}
 }else gaps.add('原版行业销量及销售额趋势依赖 Sorftime 类目销量与均价，当前冻结目录未采集，保留空趋势。');
 const productDemandSource=source('market_product_demand_trend');
 if(productDemandSource){
  const raw=obj(obj(productDemandSource.payload).data??productDemandSource.payload);
  if(raw.nodeIdPath===undefined||raw.nodeIdPath===scope.nodeIdPath){
   if(input.externalData){const normalized=projectOverviewProductDemand([productDemandSource],month,[]);report.productDemand={asinCount:normalized.asinCount,returnRatio:normalized.returnRatio,avgReturnRatio:normalized.avgReturnRatio,searchToPurchaseRatio:normalized.searchToPurchaseRatio,avgSearchToPurchaseRatio:normalized.avgSearchToPurchaseRatio,pageViews:normalized.points,updatedAt:normalized.points.at(-1)?.month??null};if(normalized.errorCode)gaps.add(`商品浏览量趋势部分数据不可用（${normalized.errorCode}），仅使用已验证月份。`);}
   else report.productDemand=parseProductDemand(raw,{totalProducts:niche.totalProducts,returnRatio:niche.returnRatio,avgReturnRatio:niche.avgReturnRatio,searchToPurchaseRatio:niche.searchToPurchaseRatio});
   remember(productDemandSource);
   if(!report.productDemand.pageViews.length)gaps.add('商品浏览量趋势来源返回空数据，保留原版空趋势判断。');
  }else gaps.add('商品浏览量趋势类目不匹配，保留原版空趋势判断。');
 }else gaps.add('商品浏览量趋势未采集，保留原版空趋势判断。');
 if(!Object.values(report.asinProfits??{}).some(p=>p.profit!==null)&&!report.prices.some(r=>r.items?.some(p=>p.profit!=null)))gaps.add('价格带商品毛利率样本缺失，未使用平均毛利率或跨模块数据补齐。');
 return MarketOverviewOriginalSynthesisSchema.parse({version:6,summary:buildMarketOverviewSynthesis(niche,report),inputGaps:[...gaps],sourceRefs:[...refs],originalAssumptions:[
  '沿用原版第6版评分权重、阈值、机会标签及缺失数据默认判断；默认判断不表示源数据已完整。',
  '沿用原版数值转换：显式空值和空字符串可能转为零，未提供的字段保持缺失。',
  `集中度使用保存的 Top ${parameters.headTopN}，新品数据使用保存的 ${parameters.newProductMonths} 个月窗口；原版部分分析文案固定写作近6个月。`,
  '分布比例直接采用原始接口比例；价格毛利率仅使用该分布内商品的原始毛利率。',
  '来源未回显确认月份或类目时，按本报告保存的请求范围绑定使用，不代表响应已确认范围。',
  '金额币种无回显时沿用冻结请求绑定的站点和币种；明确冲突的金额数据不参与分析。',
  '原版金额分析文案固定使用美元符号；其他币种仍保留该原版文案限制。',
 ]});
}
