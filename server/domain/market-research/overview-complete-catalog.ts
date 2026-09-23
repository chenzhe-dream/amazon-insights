import {buildMarketOverviewExpandedCatalog} from './overview-expanded-catalog';
import {createMarketInputSnapshot} from './snapshot';
import {MarketSemanticRecordSchema,type MarketSemanticRecord} from '../../../shared/market-semantic-contracts';
import type {MarketOverviewAnalysisBrief} from '../../../shared/market-overview-analysis-contracts';
import {validateOverviewAnalysisBrief} from './overview-analysis-validation';

export const MARKET_OVERVIEW_COMPLETE_CATALOG_VERSION='market-overview-source-catalog/v5';
export const MARKET_OVERVIEW_TABLE_CATALOG_VERSION='market-overview-source-catalog/v6';
export const MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION='market-overview-source-catalog/v7';
type Semantic=Extract<MarketSemanticRecord,{task:'market-overview-explanation'}>;
type Dimension=MarketOverviewAnalysisBrief['dimensions'][number];
const labels:Record<string,string>={market_price_distribution:'价格分布',market_ratings_count_distribution:'评价数分布',market_rating_distribution:'评分分布',market_listing_date_distribution:'上架年龄分布',market_listing_trend_distribution:'上架年份结构',market_brand_concentration:'品牌份额',market_seller_concentration:'卖家份额',market_seller_country_distribution:'卖家所属地',market_seller_type_concentration:'发货类型',market_ebc_distribution:'内容配置',market_product_demand_trend:'搜索需求',market_product_concentration:'商品份额'};
const scalarLabels:Record<string,string>={sampleProducts:'样本商品数',brands:'品牌数',sellers:'卖家数',totalUnits:'样本销量',totalRevenue:'样本销售额',avgPrice:'平均价格',avgUnits:'平均单品销量',avgRatings:'平均评价数',avgRating:'平均评分',productConcentrationRaw:'商品集中度',brandConcentrationRaw:'品牌集中度',sellerConcentrationRaw:'卖家集中度',newCount:'新品数',newAvgPrice:'新品平均价格',newAvgUnits:'新品平均销量',totalUnitsChangePct:'样本销量环比',totalRevenueChangePct:'样本销售额环比'};
const scalarDimension=(name:string)=>name.endsWith('ChangePct')?'sample-trend':name.includes('Concentration')?'concentration':name.startsWith('new')?'new-products':['brands','sellers'].includes(name)?'participants':['avgPrice','avgRatings','avgRating'].includes(name)?'rating-price':'sample-scale';
const scalarDimensionLabels:Record<string,string>={'sample-trend':'可比样本趋势',concentration:'头部集中度','new-products':'新品概况',participants:'品牌与卖家数量','rating-price':'评分与价格均值','sample-scale':'样本规模'};

/** Complete evidence projection. Every returned distribution row is retained,
 * including zero, unknown and overlapping summary rows. Its size is independent
 * of a provider request; admission/analysis is a separate versioned stage.
 * Structural comparisons concern the last requested month. The numeric history
 * keeps every requested month; only verified scalar trends cross months. */
export function buildMarketOverviewCompleteCatalog(input:Parameters<typeof buildMarketOverviewExpandedCatalog>[0],options:{metricTable?:boolean;productRows?:boolean}={}){
  const base=buildMarketOverviewExpandedCatalog(input,{productRows:options.productRows}),latest=base.months.at(-1)!;
  const sourceSemantic=base.semanticSnapshot?MarketSemanticRecordSchema.parse((base.semanticSnapshot.records[0].data as {semantic:unknown}).semantic):null;
  if(sourceSemantic&&sourceSemantic.task!=='market-overview-explanation')throw new TypeError('Expected overview');
  const semantic:Semantic=sourceSemantic?structuredClone(sourceSemantic):{task:'market-overview-explanation',metrics:[],facts:[],gaps:[],interpretationOptions:[],validationOptions:[]};
  // Free-form analysis uses the same facts, not the old template options.
  semantic.interpretationOptions=[];semantic.validationOptions=[];
  const dimensions=new Map<string,Dimension>(),factLabels:MarketOverviewAnalysisBrief['factLabels']=[];
  const dim=(id:string,label:string)=>{if(!dimensions.has(id))dimensions.set(id,{id,label,factIds:[],gapIds:[]});return dimensions.get(id)!;};
  const addGap=(d:Dimension,gapId:string,reason:Semantic['gaps'][number]['reason'],sourceRefs:string[],metricId:string|null=null)=>{semantic.gaps.push({gapId,metricId,reason,sourceRefs});d.gapIds.push(gapId);};
  for(const f of semantic.facts){const metricId=f.factId.replace(/^fact:/,''),name=metricId.split('/').at(-1)!,key=scalarDimension(name);dim(key,scalarDimensionLabels[key]).factIds.push(f.factId);factLabels.push({factId:f.factId,label:`${metricId.split('/')[0]} · ${scalarLabels[name]??name}`});}
  for(const g of semantic.gaps){const key=scalarDimension((g.metricId??g.gapId).replace(/\/response-scope$/,'').split('/').at(-1)!);dim(key,scalarDimensionLabels[key]).gapIds.push(g.gapId);}
  if(!sourceSemantic)for(const [name,m] of Object.entries(latest.metrics)){const key=scalarDimension(name);addGap(dim(key,scalarDimensionLabels[key]),`gap:${latest.month}/${name}`,m.reason??'invalid-source',[...new Set(m.observations.map(o=>o.sourceRef))],`${latest.month}/${name}`);}
  for(const entry of base.distributions.filter(e=>e.month===latest.month)){
    const prefix=`dist:${entry.month}:${entry.operation}`,refs=entry.sourceRef?[entry.sourceRef]:[],distribution=entry.distribution;
    const groupDimension=(group:string)=>dim(`${entry.operation}:${group}`,`${labels[entry.operation]} · ${group==='sample'?'返回全样本':group==='new-products'?'返回新品子集':group==='summary'?'重叠汇总':'未分类'}`);
    if(!distribution||!distribution.rows.length){const d=groupDimension('sample');addGap(d,`${prefix}:unavailable`,entry.status==='failed'?'collection-failed':entry.status==='not-collected'?'not-collected':'field-absent',refs);continue;}
    const period:Semantic['metrics'][number]['period']=entry.scopeBasis==='response-verified'?{kind:'calendar-months',fromMonth:entry.month,toMonth:entry.month}:{kind:'unknown',reason:'Returned response; requested month not confirmed by source'};
    const addMetric=(metricId:string,value:number,field:'products'|'units'|'revenue',extra?:{numeratorRef:string;denominatorRef:string})=>{semantic.metrics.push({metricId,state:'known',value,unit:extra?{status:'known',unit:'percent',rawUnit:'returned response group share'}:field==='revenue'?{status:'known',unit:'currency',currency:distribution.currency!,rawUnit:`confirmed ${distribution.currency}`}:{status:'known',unit:'count',rawUnit:field},period,sourceRefs:refs,formulaVersion:extra?'overview-response-group-share/v1':'overview-response-row-value/v1',numeratorRef:extra?.numeratorRef??null,denominatorRef:extra?.denominatorRef??null,coverage:{status:'complete',expectedCount:1,availableCount:1}});};
    const denominators=new Map<string,string>();
    for(const group of distribution.groups)for(const field of ['products','units','revenue'] as const){if(group[field]===null)continue;const id=`${prefix}:${group.id}:total:${field}`;addMetric(id,group[field],field);denominators.set(`${group.id}:${field}`,id);}
    for(const row of distribution.rows){
      const d=groupDimension(row.group),rowPrefix=`${prefix}:${row.group}:${row.id}`,metricRefs:string[]=[];
      for(const field of ['products','units','revenue'] as const){
        const id=`${rowPrefix}:${field}`,value=row[field];
        if(value===null){addGap(d,`gap:${id}`,field==='revenue'&&!distribution.currency?'unit-unknown':'field-absent',refs,id);continue;}
        addMetric(id,value,field);metricRefs.push(id);
        const shareField=`${field}SharePct` as 'productsSharePct'|'unitsSharePct'|'revenueSharePct',share=row[shareField],denominatorRef=denominators.get(`${row.group}:${field}`);
        if(share!==null&&denominatorRef){const shareId=`${rowPrefix}:${shareField}`;addMetric(shareId,share,field,{numeratorRef:id,denominatorRef});metricRefs.push(shareId);}
      }
      if(metricRefs.length){const factId=`fact:${rowPrefix}`;semantic.facts.push({factId,kind:metricRefs.some(id=>id.endsWith('SharePct'))?'share':'value',metricRefs,sourceRefs:refs,statementTemplateId:'overview.returned-distribution-row/v1'});d.factIds.push(factId);factLabels.push({factId,label:row.label});}
      else addGap(d,`gap:${rowPrefix}:no-values`,'field-absent',refs);
    }
    for(const group of new Set(distribution.rows.map(r=>r.group))){const d=groupDimension(group);
      if(entry.scopeBasis==='request-bound')addGap(d,`gap:${prefix}:${group}:response-scope`,'period-incompatible',refs);
      if(group==='summary'||group==='unclassified')addGap(d,`gap:${prefix}:${group}:not-disjoint`,'invalid-source',refs);
      if(distribution.issues.length||distribution.groups.some(g=>g.id===group&&g.issues.length))addGap(d,`gap:${prefix}:${group}:group-limitations`,'invalid-source',refs);
    }
  }
  semantic.analysisBrief={mode:'dimension',scopeStatement:`结构分布仅分析最后请求月份 ${latest.month} 的返回样本；其他月份保留在数字历史，仅明确可比的基础指标产生趋势。请求月份未获响应确认时只描述该响应，不代表全市场。各接口、内容全样本与新品子集的分母独立；重叠汇总不进入组分母。上架年份结构不是历史新增量，成交不代表搜索需求。`,dimensions:[...dimensions.values()],factLabels};
  const parsed=semantic.facts.length?MarketSemanticRecordSchema.parse(semantic):null;
  if(parsed?.task==='market-overview-explanation')validateOverviewAnalysisBrief(parsed);
  const version=options.productRows?MARKET_OVERVIEW_PRODUCT_CATALOG_VERSION:options.metricTable?MARKET_OVERVIEW_TABLE_CATALOG_VERSION:MARKET_OVERVIEW_COMPLETE_CATALOG_VERSION,n=base.numericSnapshot;
  const numericSnapshot=createMarketInputSnapshot({scope:n.scope,kind:n.kind,sourceVersion:n.sourceVersion,ruleVersion:version,collectedAt:n.collectedAt,expectedRecordIds:n.expectedRecordIds,records:n.records});
  const semanticSnapshot=parsed?createMarketInputSnapshot({scope:n.scope,kind:'overview',sourceVersion:n.sourceVersion,ruleVersion:version,collectedAt:n.collectedAt,expectedRecordIds:['overview'],records:[{id:'overview',scope:n.scope,data:{semantic:parsed}}]}):null;
  return {...base,version,numericSnapshot,semanticSnapshot,status:semanticSnapshot?'ready' as const:'no-input' as const};
}
