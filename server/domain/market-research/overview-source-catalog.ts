import {z} from 'zod';
import {MarketAnalysisScopeSchema, type MarketAnalysisScope, type MarketJsonValue} from '../../../shared/market-analysis-contracts';
import type {MarketSourceEvidence,MarketSourceUnit} from '../../../shared/market-source-contracts';
import {MarketSemanticRecordSchema, type MarketSemanticRecord} from '../../../shared/market-semantic-contracts';
import {createMarketSourceEvidence} from './source-evidence';
import {createMarketInputSnapshot} from './snapshot';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION} from '../../../shared/market-overview-distribution-contracts';

export const MARKET_OVERVIEW_CATALOG_VERSION='market-overview-source-catalog/v3';
export const MarketOverviewCatalogVersionSchema=z.enum(['market-overview-source-catalog/v2',MARKET_OVERVIEW_CATALOG_VERSION,MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION]);
const parametersSchema=z.object({headTopN:z.union([z.literal(5),z.literal(10),z.literal(20)]),newProductMonths:z.union([z.literal(1),z.literal(3),z.literal(6),z.literal(12)])}).strict();
type Parameters=z.infer<typeof parametersSchema>;
type Reason='not-collected'|'collection-failed'|'field-absent'|'invalid-source'|'unit-unknown'|'period-incompatible';
export const MarketOverviewSourceFailureSchema=z.object({month:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),operation:z.enum(['market_research','market_research_statistics']),attemptId:z.string().uuid(),code:z.string().min(1).max(100)}).strict();
export type MarketOverviewSourceFailure=z.infer<typeof MarketOverviewSourceFailureSchema>;
type Observation={sourceRef:string;field:string;raw:MarketJsonValue;value:number|null;unit:MarketSourceUnit|null;reason:Reason|null;scopeBasis?:'request-bound'|'response-verified'};
type Metric={state:'known'|'missing'|'conflict';value:number|null;unit:MarketSourceUnit|null;reason:Reason|null;observations:Observation[]};
const metricNames=['sampleProducts','brands','sellers','totalUnits','totalRevenue','avgPrice','avgUnits','avgRatings','avgRating','productConcentrationRaw','brandConcentrationRaw','sellerConcentrationRaw','newCount','newAvgPrice','newAvgUnits'] as const;
type MetricName=typeof metricNames[number];
const obj=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const equal=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))throw new TypeError('Overview source identity differs');};
const numeric=(raw:unknown)=>typeof raw==='number'?Number.isFinite(raw)&&raw>=0?raw:null:typeof raw==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw.trim())?Number.isFinite(Number(raw))?Number(raw):null:null;
const unitKey=(unit:MarketSourceUnit|null)=>unit?.status==='known'?`${unit.unit}:${unit.currency??''}`:null;
function fields(name:MetricName,p:Parameters,statistics:boolean):string[]{
  if(name==='sampleProducts')return statistics?['products']:['topProducts','products'];
  if(name.endsWith('ConcentrationRaw'))return statistics?[]:[`top${p.headTopN}${name.startsWith('product')?'Product':name.startsWith('brand')?'Brand':'Seller'}Crn`];
  if(name==='newCount')return statistics?['newProducts']:[`l${p.newProductMonths}NewCount`];
  if(name==='newAvgPrice')return statistics?['newAvgPrice']:[`l${p.newProductMonths}NewAvgPrice`];
  if(name==='newAvgUnits')return statistics?['newAvgUnits']:[`l${p.newProductMonths}NewAvgSales`];
  return [name];
}
export function marketOverviewSourceFields(parameters:Parameters,statistics:boolean):string[]{
  const p=parametersSchema.parse(parameters);return [...new Set(metricNames.flatMap(name=>fields(name,p,statistics)))];
}
function validUnit(name:MetricName,value:number,unit:MarketSourceUnit|undefined,scope:MarketAnalysisScope):boolean {
  if(unit?.status!=='known')return false;
  if(name.endsWith('ConcentrationRaw'))return unit.unit==='ratio'?value<=1:unit.unit==='percent'&&value<=100;
  if(['totalRevenue','avgPrice','newAvgPrice'].includes(name))return unit.unit==='currency'&&unit.currency===scope.currency;
  return unit.unit==='count'&&value<=Number.MAX_SAFE_INTEGER&&(!['sampleProducts','brands','sellers','totalUnits','newCount'].includes(name)||Number.isSafeInteger(value))&&(name!=='avgRating'||value<=5);
}

/** Deterministic source-to-fact projection. Does not call providers, guess units,
 * infer missing months or replace the existing overview report/UI. */
export function buildMarketOverviewSourceCatalog(input:{scope:MarketAnalysisScope;parameters:Parameters;dataCutoffAt:string;sources:readonly MarketSourceEvidence[];failures?:readonly MarketOverviewSourceFailure[];version?:z.infer<typeof MarketOverviewCatalogVersionSchema>}){
  const version=MarketOverviewCatalogVersionSchema.parse(input.version??MARKET_OVERVIEW_CATALOG_VERSION);
  const expanded=version===MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION;
  const scope=MarketAnalysisScopeSchema.parse(input.scope),parameters=parametersSchema.parse(input.parameters),cutoff=z.string().datetime().parse(input.dataCutoffAt);
  if(scope.toMonth>=cutoff.slice(0,7))throw new TypeError('Overview requires complete calendar months');
  const byMonth=new Map<string,Array<{source:MarketSourceEvidence;ref:string;row:Record<string,unknown>;statistics:boolean}>>(),seen=new Set<string>();
  for(const source of input.sources){
    equal(source.scope,scope);
    const paths=Object.fromEntries(Object.entries(source.responseIdentity).filter(([,v])=>v.echoes.length+v.missingPaths.length>0).map(([k,v])=>[k,[...v.echoes.map(e=>e.path),...v.missingPaths]]));
    const rebuilt=createMarketSourceEvidence({scope:source.scope,provider:source.provider,operation:source.operation,requestIdentity:source.requestIdentity,responseIdentityPaths:paths,payload:source.payload,
      fetchedAt:source.fetchedAt,observationPeriod:source.observationPeriod,units:source.units,coverage:source.coverage});equal(rebuilt,source);
    if(source.provider!=='sellerSprite'||!['market_research','market_research_statistics'].includes(source.operation)||source.requestIdentity.nodeIdPath!==scope.nodeIdPath||source.requestIdentity.marketplace!==scope.marketplace||Date.parse(source.fetchedAt)>Date.parse(cutoff))throw new TypeError('Unsupported overview source');
    const month=source.requestIdentity.month;if(!month||month<scope.fromMonth||month>scope.toMonth)throw new TypeError('Overview source month is missing');
    const key=`${month}/${source.operation}`;if(seen.has(key))throw new TypeError('Duplicate overview endpoint');seen.add(key);
    const payload=obj(source.payload);if(payload.isError===true||(payload.code!==undefined&&payload.code!=='OK'))throw new TypeError('Unsuccessful overview response');
    const data=obj(payload.data??payload),statistics=source.operation==='market_research_statistics';let row=data;
    if(!statistics){
      if(!Array.isArray(data.items))throw new TypeError('Overview category rows are unavailable');
      const matches=data.items.map(obj).filter(r=>r.nodeIdPath===scope.nodeIdPath||String(r.nodeId??'')===scope.nodeIdPath.split(':').at(-1));
      if(data.items.length===0&&source.coverage.receivedCount===0)row={};
      else{if(matches.length!==1)throw new TypeError('Overview category row is ambiguous');row=matches[0];}
    }
    for(const [field,value] of Object.entries({marketplace:scope.marketplace,currency:scope.currency,nodeIdPath:scope.nodeIdPath,nodeId:scope.nodeIdPath.split(':').at(-1),month})){
      if(row[field]!==undefined&&(field==='month'?String(row[field]).replaceAll('-',''):String(row[field]))!==(field==='month'?String(value).replaceAll('-',''):String(value)))throw new TypeError('Overview response row conflicts with scope');
    }
    const group=byMonth.get(month)??[];group.push({source,ref:`market-source:${digest(source)}`,row,statistics});byMonth.set(month,group);
  }
  const failures=z.array(MarketOverviewSourceFailureSchema).max(2000).parse(input.failures??[]).sort((a,b)=>`${a.month}/${a.operation}`.localeCompare(`${b.month}/${b.operation}`));
  for(const failure of failures){const key=`${failure.month}/${failure.operation}`;if(failure.month<scope.fromMonth||failure.month>scope.toMonth||seen.has(key))throw new TypeError('Overview failure is outside scope, duplicated or conflicts with accepted evidence');seen.add(key);}
  const months:Array<{month:string;metrics:Record<MetricName,Metric>;sourceRefs:string[];failures:MarketOverviewSourceFailure[]}>=[];
  for(let month=scope.fromMonth;month<=scope.toMonth;){
    const sources=(byMonth.get(month)??[]).sort((a,b)=>a.ref.localeCompare(b.ref));
    const metrics=Object.fromEntries(metricNames.map(name=>{
      // Existing runs retain their frozen v2 reason and snapshot identities.
      const legacy=version==='market-overview-source-catalog/v2';
      const relevantSources=legacy?sources:sources.filter(s=>fields(name,parameters,s.statistics).length>0);
      const collectionFailed=failures.some(f=>f.month===month&&(legacy||fields(name,parameters,f.operation==='market_research_statistics').length>0));
      const observations:Observation[]=relevantSources.flatMap(({source,ref,row,statistics})=>{
        const field=fields(name,parameters,statistics).find(k=>row[k]!==undefined&&row[k]!==null);if(!field)return [];
        const raw=row[field] as MarketJsonValue,value=numeric(raw),unit=source.units[field]??null;
        const period=source.observationPeriod;
        const verified=source.responseIdentity.nodeIdPath.status==='verified'&&source.responseIdentity.month.status==='verified';
        const reason:Reason|null=value===null?'invalid-source':!expanded&&!verified?'invalid-source':period.kind!=='calendar-months'||period.fromMonth!==month||period.toMonth!==month?'period-incompatible':!validUnit(name,value,unit??undefined,scope)?'unit-unknown':null;
        return [{sourceRef:ref,field,raw,value,unit,reason,...(expanded?{scopeBasis:verified?'response-verified' as const:'request-bound' as const}:{})}];
      });
      const valid=observations.filter(o=>o.reason===null),conflict=valid.some(o=>o.value!==valid[0].value||unitKey(o.unit)!==unitKey(valid[0].unit));
      // An invalid competing observation must not disappear behind a valid one.
      const rejected=observations.find(o=>o.reason!==null);
      return [name,{state:conflict?'conflict':valid.length&&!rejected?'known':'missing',value:!conflict&&valid.length&&!rejected?valid[0].value:null,unit:!conflict&&valid.length&&!rejected?valid[0].unit:null,
        reason:conflict?'invalid-source':rejected?.reason??(valid.length?null:collectionFailed?'collection-failed':relevantSources.length?'field-absent':'not-collected'),observations} satisfies Metric];
    })) as Record<MetricName,Metric>;
    months.push({month,metrics,sourceRefs:sources.map(s=>s.ref),failures:failures.filter(f=>f.month===month)});
    const [y,m]=month.split('-').map(Number);month=`${m===12?y+1:y}-${String(m===12?1:m+1).padStart(2,'0')}`;
  }
  type Semantic=Extract<MarketSemanticRecord,{task:'market-overview-explanation'}>;
  const semantic:Semantic={task:'market-overview-explanation',metrics:[],gaps:[],facts:[],interpretationOptions:[],validationOptions:[]};
  const latest=months.at(-1)!,prior=months.at(-2),fact=(metricId:string)=>`fact:${metricId}`;
  const add=(row:typeof latest,name:MetricName)=>{
    const m=row.metrics[name],metricId=`${row.month}/${name}`;if(semantic.metrics.some(m=>m.metricId===metricId))return metricId;
    const refs=[...new Set(m.observations.map(o=>o.sourceRef))].sort();
    if(m.state!=='known'||m.unit?.status!=='known'||m.value===null){semantic.gaps.push({gapId:`gap:${metricId}`,metricId,reason:m.reason??'invalid-source',sourceRefs:refs});return null;}
    const unverified=expanded&&m.observations.some(o=>o.scopeBasis==='request-bound');
    if(unverified)semantic.gaps.push({gapId:`gap:${metricId}/response-scope`,metricId:`${metricId}/response-scope`,reason:'invalid-source',sourceRefs:refs});
    semantic.metrics.push({metricId,state:'known',value:m.value,unit:m.unit,period:unverified?{kind:'unknown',reason:`Requested ${row.month}; response scope not confirmed`}:{kind:'calendar-months',fromMonth:row.month,toMonth:row.month},sourceRefs:refs,formulaVersion:version,numeratorRef:null,denominatorRef:null,coverage:{status:'complete',expectedCount:1,availableCount:1}});
    semantic.facts.push({factId:fact(metricId),kind:'value',metricRefs:[metricId],sourceRefs:refs,statementTemplateId:`overview.sample.${name}${name.startsWith('new')?`.window-${parameters.newProductMonths}-months`:''}.value/v1`});return metricId;
  };
  for(const name of metricNames)add(latest,name);
  const trendGaps:Array<{metricId:string;reason:string}>=[];
  if(prior){
    const comparable=latest.metrics.sampleProducts.state==='known'&&prior.metrics.sampleProducts.state==='known'&&latest.metrics.sampleProducts.value===prior.metrics.sampleProducts.value;
    for(const name of ['totalUnits','totalRevenue'] as const){
      const a=latest.metrics[name],b=prior.metrics[name];
      if(expanded&&[a,b,latest.metrics.sampleProducts,prior.metrics.sampleProducts].some(m=>m.observations.some(o=>o.scopeBasis==='request-bound'))){
        const metricId=`${latest.month}/${name}ChangePct`;trendGaps.push({metricId,reason:'period-response-unverified'});
        semantic.gaps.push({gapId:`gap:${metricId}`,metricId,reason:'invalid-source',sourceRefs:[...new Set([...a.observations,...b.observations,...latest.metrics.sampleProducts.observations,...prior.metrics.sampleProducts.observations].map(o=>o.sourceRef))].sort()});continue;
      }
      if(!comparable||a.state!=='known'||b.state!=='known'||b.value===0||unitKey(a.unit)!==unitKey(b.unit)){
        const metricId=`${latest.month}/${name}ChangePct`,reason=b.state!=='known'?'previous-month-unavailable':a.state!=='known'?'current-month-unavailable':!comparable?'sample-count-not-comparable':b.value===0?'zero-baseline':'unit-not-comparable';
        trendGaps.push({metricId,reason});semantic.gaps.push({gapId:`gap:${metricId}`,metricId,reason:b.reason==='not-collected'?'not-collected':'invalid-source',sourceRefs:[...new Set([...a.observations,...b.observations].map(o=>o.sourceRef))].sort()});continue;
      }
      const currentId=add(latest,name)!,previousId=add(prior,name)!,metricId=`${latest.month}/${name}ChangePct`,value=(a.value!/b.value!-1)*100;if(!Number.isFinite(value))continue;
      const refs=[...new Set([...a.observations,...b.observations].map(o=>o.sourceRef))].sort();
      semantic.metrics.push({metricId,state:'known',value,unit:{status:'known',unit:'percent',rawUnit:'percent change'},period:{kind:'calendar-months',fromMonth:prior.month,toMonth:latest.month},sourceRefs:refs,
        formulaVersion:'overview-reported-sample-month-change/v1',numeratorRef:currentId,denominatorRef:previousId,coverage:{status:'complete',expectedCount:2,availableCount:2}});
      const currentSample=add(latest,'sampleProducts')!,previousSample=add(prior,'sampleProducts')!;
      const factRefs=[...new Set([...refs,...latest.metrics.sampleProducts.observations.map(o=>o.sourceRef),...prior.metrics.sampleProducts.observations.map(o=>o.sourceRef)])].sort();
      semantic.facts.push({factId:fact(metricId),kind:'trend',metricRefs:[currentId,previousId,metricId,currentSample,previousSample],sourceRefs:factRefs,statementTemplateId:`overview.reported-sample.${name}.month-change/v1`});
      semantic.interpretationOptions.push({optionId:`sample-${name}-${value<0?'decrease':value>0?'increase':'unchanged'}`,kind:'inference',templateId:`overview.sample-${name}-${value<0?'decreased':value>0?'increased':'unchanged'}-not-causal/v1`,allowedFactIds:[fact(metricId)],allowedGapIds:[],requiredFactIds:[fact(metricId)],requiredGapIds:[]});
    }
  }
  const factIds=semantic.facts.map(f=>f.factId),gapIds=semantic.gaps.map(g=>g.gapId);
  if(gapIds.length)semantic.interpretationOptions.push({optionId:'incomplete-evidence',kind:'risk',templateId:'overview.missing-evidence-limits-conclusions/v1',allowedFactIds:factIds,allowedGapIds:gapIds,requiredFactIds:[],requiredGapIds:[gapIds[0]]});
  semantic.validationOptions.push({actionId:'verify-sample-representativeness',templateId:'overview.verify-sample-before-market-inference/v1',allowedFactIds:factIds,allowedGapIds:gapIds});
  const numericSnapshot=createMarketInputSnapshot({scope,kind:'overview',sourceVersion:'market-overview-sources/v1',ruleVersion:version,collectedAt:cutoff,
    expectedRecordIds:months.map(m=>m.month),records:months.map(m=>({id:m.month,scope,data:JSON.parse(JSON.stringify({parameters,...m,trendGaps:m.month===latest.month?trendGaps:[]}))}))});
  const semanticSnapshot=semantic.facts.length?createMarketInputSnapshot({scope,kind:'overview',sourceVersion:'market-overview-sources/v1',ruleVersion:`${version}:${digest(parameters)}`,collectedAt:cutoff,
    expectedRecordIds:['overview'],records:[{id:'overview',scope,data:{semantic:MarketSemanticRecordSchema.parse(semantic)}}]}):null;
  return {version,parameters,months,trendGaps,numericSnapshot,semanticSnapshot,sourceRefs:[...new Set(months.flatMap(m=>m.sourceRefs))].sort(),status:semanticSnapshot?'ready' as const:'no-input' as const};
}
