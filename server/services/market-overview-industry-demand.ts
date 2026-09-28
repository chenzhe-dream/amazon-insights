import {ResourceGovernorAdmissionError,type LocalAdmission} from '../db/concurrency-control-repository';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {MarketOverviewIndustryDemandSchema,type MarketOverviewIndustryDemand} from '../../shared/market-overview-industry-demand';
import {MarketAnalysisScopeSchema,MarketInputRecordSchema,type MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {MarketSourceIdentityValueSchemas,type MarketSourcePayloadPath,type MarketSourceEvidenceInput,type MarketSourceEvidence} from '../../shared/market-source-contracts';
import {ConnectorError,type ConnectorMap} from '../connectors/connector-contract';
import {createMarketSourceEvidence} from '../domain/market-research/source-evidence';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:typeof v==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v.trim())?Number(v):null;
const unwrap=(v:unknown):unknown=>Object.hasOwn(obj(v),'data')?obj(v).data:v;
const list=(v:unknown):Record<string,unknown>[]=>{const value=unwrap(v);return (Array.isArray(value)?value:Array.isArray(obj(value).items)?obj(value).items as unknown[]:[]).map(obj);};
export function parseAbaPoints(value:unknown,referenceMonth:string){const points=list(value).flatMap(item=>{const raw=String(item.label??item.month??''),compact=raw.replace(/[^\d]/g,''),month=compact.length===6?`${compact.slice(0,4)}-${compact.slice(4)}`:raw,value=num(item.searches);return /^20\d{2}-(0[1-9]|1[0-2])$/.test(month)&&month<=referenceMonth&&value!==null?[{month,value}]:[];});if(new Set(points.map(p=>p.month)).size!==points.length)throw Error('malformed-response');return points.slice(-48);}
function categoryKeywordStems(seed: string) {
  const words = seed
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, " ")
    .split(/\s+/)
    .filter(word => word.length >= 4);
  const stems = new Set<string>();
  words.forEach(word => {
    stems.add(word);
    if (word.endsWith("s") && word.length >= 5) stems.add(word.slice(0, -1));
  });
  return [...stems];
}

function isOffCategoryKeyword(keyword: string, seed: string) {
  const text = keyword.toLowerCase();
  const seedText = seed.toLowerCase();
  const powered =
    /\b(electric|electrical|eletric|e-?scooter|escooter|segway|hover\s?board|emoto|mobility|patineta electrica)\b/.test(
      text,
    );
  if (powered && !/\belectric\b/.test(seedText)) return true;
  return false;
}

function isOnCategoryKeyword(keyword: string, stems: string[]) {
  if (!stems.length) return keyword.split(/\s+/).length >= 2;
  const text = keyword.toLowerCase();
  return stems.some(stem => text.includes(stem));
}

const KEYWORD_MODIFIERS = new Set([
  "kids",
  "kid",
  "toddler",
  "child",
  "children",
  "adult",
  "adults",
  "baby",
  "boy",
  "boys",
  "girl",
  "girls",
  "men",
  "women",
  "man",
  "woman",
  "mini",
  "portable",
  "outdoor",
  "indoor",
  "year",
  "years",
  "old",
  "age",
  "ages",
]);

function isLikelyBrandKeyword(keyword: string, stems: string[]) {
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length !== 2) return false;
  const [head, tail] = words;
  const matchesStem = (word: string) => stems.some(stem => word === stem || word.includes(stem));
  return matchesStem(tail) && !matchesStem(head) && !KEYWORD_MODIFIERS.has(head) && !/^\d/.test(head);
}

type CategoryKeywordRow = {
  keyword: string;
  searches: number | null;
  resultCount: number | null;
};

export function pickCategoryKeywords(rows: CategoryKeywordRow[], seed: string) {
  const stems = categoryKeywordStems(seed);
  return rows
    .filter(item => {
      if (isOffCategoryKeyword(item.keyword, seed)) return false;
      if (!isOnCategoryKeyword(item.keyword, stems)) return false;
      if (item.keyword.split(/\s+/).length < 2) return false;
      if (isLikelyBrandKeyword(item.keyword, stems)) return false;
      if (item.resultCount != null && item.resultCount >= 100000) return false;
      return true;
    })
    .sort((a, b) => (b.searches ?? 0) - (a.searches ?? 0))
    .slice(0, 5);
}


export function overviewDemandSeed(sources:readonly MarketSourceEvidence[],scope:MarketAnalysisScope):string|null{
 for(const source of sources){if(source.operation!=='market_research'||source.requestIdentity.month!==scope.toMonth)continue;const row=list(source.payload).find(r=>r.nodeIdPath===scope.nodeIdPath||String(r.nodeId??'')===scope.nodeIdPath.split(':').at(-1));if(!row)continue;const seed=String(row.nodeLabelPath??row.nodeLabelName??row.name??'').split(':').filter(Boolean).at(-1)?.replace(/\s+/g,' ').trim();if(seed&&!/^\d+$/.test(seed))return seed;}return null;
}
export async function collectOverviewIndustryDemand(input:{scope:MarketAnalysisScope;seed:string|null;jobId:string;connectors:Pick<ConnectorMap,'sellerSprite'|'sorftime'>;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}){
 const scope=MarketAnalysisScopeSchema.parse(input.scope),now=input.now??(()=>new Date()),sources:MarketSourceEvidenceInput[]=[],evidence:MarketSourceEvidence[]=[],issues:MarketOverviewIndustryDemand['issues']=[],series:MarketOverviewIndustryDemand['series']=[];
 if(scope.toMonth>=now().toISOString().slice(0,7))throw new TypeError('Demand requires complete reference month');
 const wholeDeadline=performance.now()+110000,whole=new AbortController(),wholeTimer=setTimeout(()=>whole.abort(),110000);wholeTimer.unref();
 try{
 let admission:LocalAdmission|undefined;const errors=new Map<string,string>();
 let seed=input.seed?.replace(/\s+/g,' ').trim()||null;
 async function call(provider:'sellerSprite'|'sorftime',operation:string,args:Record<string,unknown>,keyword?:string,page?:number){
  input.signal?.throwIfAborted();if(performance.now()>=wholeDeadline)whole.abort();if(whole.signal.aborted){issues.push({operation,code:'timeout',retryable:true});return null;}const controller=new AbortController(),signal=AbortSignal.any([controller.signal,whole.signal,...(input.signal?[input.signal]:[])]),timeout=z.number().int().min(1).max(120000).parse(input.timeoutMs??60000),deadline=Math.min(wholeDeadline,performance.now()+timeout),timer=setTimeout(()=>controller.abort(),timeout);timer.unref();
  try{const connector=input.connectors[provider];if(connector.id!==provider)throw Error('source-mismatch');const response=await new Promise<Awaited<ReturnType<typeof connector.execute>>>((resolve,reject)=>{const abort=()=>reject(new ConnectorError(provider,'timeout',true));signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>connector.execute({operation,input:args,signal,governorScope:{organizationId:scope.organizationId,jobId:input.jobId}})).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});if(performance.now()>=deadline)controller.abort();signal.throwIfAborted();
   if(response.source.connectorId!==provider||response.source.operation!==operation||response.source.attemptCount<1)throw Error('source-mismatch');
   const payload=MarketInputRecordSchema.shape.data.parse(response.data),envelope=obj(payload);if(envelope.isError===true||(envelope.code!==undefined&&envelope.code!=='OK'&&envelope.code!==0&&envelope.code!==200))throw Error('upstream-permanent');
   const body=unwrap(payload);if(!Array.isArray(body)&&!Array.isArray(obj(body).items))throw Error('malformed-response');
   const responseIdentityPaths:Partial<Record<'marketplace'|'nodeIdPath'|'nodeId'|'keyword'|'page'|'month',MarketSourcePayloadPath[]>>={};
   for(const [record,path] of [[envelope,[]],[obj(body),Object.hasOwn(envelope,'data')?['data']:[]]] as [Record<string,unknown>,MarketSourcePayloadPath][]){for(const field of ['marketplace','nodeIdPath','nodeId','keyword','page','month'] as const){if(!Object.hasOwn(record,field))continue;const actual=MarketSourceIdentityValueSchemas[field].parse(record[field]),expected=field==='marketplace'?scope.marketplace:field==='nodeIdPath'?scope.nodeIdPath:field==='nodeId'?scope.nodeIdPath.split(':').at(-1):field==='keyword'?keyword:field==='month'?['keyword_research','product_node'].includes(operation)?scope.toMonth:undefined:page;if(expected!==undefined&&actual!==expected)throw Error('scope-mismatch');if(expected!==undefined)(responseIdentityPaths[field]??=[]).push([...path,field]);}}
   if(operation==='product_node'){productNodeSeed(payload,scope);}
   if(operation==='aba_research_trend')parseAbaPoints(payload,scope.toMonth);
   const proposal:MarketSourceEvidenceInput={scope,provider,operation,requestIdentity:{marketplace:scope.marketplace,nodeIdPath:scope.nodeIdPath,...(['keyword_research','product_node'].includes(operation)?{month:scope.toMonth}:{}),...(keyword?{keyword}:{}),...(page?{page}:{})},responseIdentityPaths,payload,fetchedAt:response.source.fetchedAt,observationPeriod:{kind:'unknown',reason:'Original provider response; normalized monthly points are cut off at the reference month'},units:operation==='aba_research_trend'?{searches:{status:'known',unit:'count',rawUnit:'searches'}}:{},coverage:{receivedCount:list(payload).length,expectedCount:null,truncation:{status:'unknown',reason:'Provider result coverage is not a category total'}}};
   const accepted=createMarketSourceEvidence(proposal,now());sources.push(proposal);evidence.push(accepted);return {value:payload,sourceRef:`market-source:${digest(accepted)}`};
  }catch(error){if(performance.now()>=deadline)controller.abort();input.signal?.throwIfAborted();if(error instanceof ConnectorError&&error.admission)admission=error.admission;if(error instanceof ResourceGovernorAdmissionError)admission={reason:error.reason,retryAt:error.retryAt};issues.push({operation,code:controller.signal.aborted||whole.signal.aborted?'timeout':error instanceof ConnectorError?error.code:error instanceof ResourceGovernorAdmissionError?'local-admission':error instanceof Error&&['source-mismatch','scope-mismatch','upstream-permanent'].includes(error.message)?error.message:'malformed-response',retryable:controller.signal.aborted||whole.signal.aborted||error instanceof ResourceGovernorAdmissionError&&['concurrency','rolling-window'].includes(error.reason)||error instanceof ConnectorError&&error.retryable});errors.set(keyword??operation,issues.at(-1)!.code);return null;}finally{clearTimeout(timer);}
 }
 const marketplace=scope.marketplace,nodeId=scope.nodeIdPath.split(':').at(-1)!,month=scope.toMonth.replaceAll('-','');
 if(!seed||/^\d+$/.test(seed)){const found=await call('sellerSprite','product_node',{request:{marketplace,keyword:nodeId,month}});seed=found?productNodeSeed(found.value,scope):null;if(seed&&/^\d+$/.test(seed))seed=null;}
 const rows:CategoryKeywordRow[]=[];
 if(seed){const pages=await Promise.all([1,2].map(page=>call('sorftime','category_keywords',{node_id:nodeId,amz_site:marketplace==='UK'?'GB':marketplace,page},undefined,page)));for(const found of pages)if(found)rows.push(...categoryRows(found.value));}
 let selected=seed?pickCategoryKeywords(rows,seed):[];
 if(seed&&selected.length<5){const stems=categoryKeywordStems(seed),researchSeed=[...stems].sort((a,b)=>b.length-a.length)[0]||seed.replace(/s\b/i,'').trim()||seed,found=await call('sellerSprite','keyword_research',{request:{marketplace,keywords:researchSeed,...(/\belectric\b/.test(seed.toLowerCase())?{}:{excludeKeywords:'electric,segway,mobility,escooter'}),page:1,size:10,order:{desc:true,field:'searches'},month}});
 if(found){const extra=list(found.value).map(r=>({keyword:String(r.keywords??r.keyword??'').trim(),searches:num(r.searches),resultCount:null})).filter(r=>r.keyword&&!isOffCategoryKeyword(r.keyword,seed!)&&isOnCategoryKeyword(r.keyword,stems)&&r.keyword.split(/\s+/).length>=2&&!isLikelyBrandKeyword(r.keyword,stems)&&!selected.some(s=>s.keyword===r.keyword));selected=[...selected,...extra].slice(0,5);}}
 if(!selected.length&&seed)selected=[{keyword:seed,searches:null,resultCount:null}];
 // Preserve original selection order, but avoid duplicate trend calls from overlapping pages.
 selected=selected.filter((r,i)=>selected.findIndex(s=>s.keyword===r.keyword)===i);
 series.push(...await Promise.all(selected.map(async row=>{const found=await call('sellerSprite','aba_research_trend',{marketplace,keyword:row.keyword,timeGranularity:'M'},row.keyword),points=found?parseAbaPoints(found.value,scope.toMonth):[];return {keyword:row.keyword,searches:points.at(-1)?.value??row.searches,status:found?points.length?'ready' as const:'empty' as const:'failed' as const,points,sourceRef:found?.sourceRef??null,errorCode:found?null:errors.get(row.keyword)??'timeout'};})));
 if(!seed)issues.push({operation:'product_node',code:'category-seed-unavailable',retryable:false});
 const result=MarketOverviewIndustryDemandSchema.parse({seed,referenceMonth:scope.toMonth,series,issues,status:series.some(s=>s.points.length)?issues.length||series.some(s=>s.status!=='ready')?'partial':'ready':issues.length?'failed':'empty'});
 return {result,sources,evidence,...(admission?{admission}:{})};
 }finally{clearTimeout(wholeTimer);}
}


export function productNodeSeed(payload:unknown,scope:MarketAnalysisScope){
 const rows=list(payload),matches=rows.filter(r=>r.nodeIdPath===scope.nodeIdPath||String(r.nodeId??'')===scope.nodeIdPath.split(':').at(-1));
 const row=matches.length===1?matches[0]:rows.length===1&&rows[0].nodeIdPath===undefined&&rows[0].nodeId===undefined?rows[0]:null;
 if(rows.length&&!row)throw Error('scope-mismatch');const seed=String(row?.nodeLabelPath??'').split(':').filter(Boolean).at(-1)?.replace(/\s+/g,' ').trim()||null;return seed&&!/^\d+$/.test(seed)?seed:null;
}
export function categoryRows(payload:unknown):CategoryKeywordRow[]{return list(payload).flatMap(r=>{const keyword=String(r.keyword??'').trim();return keyword?[{keyword,searches:num(String(r.monthly_search_volume??'').replace(/[^\d.]/g,'')),resultCount:num(String(r.search_result_count??'').replace(/[^\d.]/g,''))}]:[];});}
export function replayDemandSelection(seed:string|null,sources:readonly MarketSourceEvidence[]){
 if(!seed)return [];const rows=sources.filter(s=>s.operation==='category_keywords').sort((a,b)=>Number(a.requestIdentity.page)-Number(b.requestIdentity.page)).flatMap(s=>categoryRows(s.payload));let selected=pickCategoryKeywords(rows,seed);const research=sources.find(s=>s.operation==='keyword_research');
 if(selected.length<5&&research){const stems=categoryKeywordStems(seed),extra=list(research.payload).map(r=>({keyword:String(r.keywords??r.keyword??'').trim(),searches:num(r.searches),resultCount:null})).filter(r=>r.keyword&&!isOffCategoryKeyword(r.keyword,seed)&&isOnCategoryKeyword(r.keyword,stems)&&r.keyword.split(/\s+/).length>=2&&!isLikelyBrandKeyword(r.keyword,stems)&&!selected.some(s=>s.keyword===r.keyword));selected=[...selected,...extra].slice(0,5);}
 if(!selected.length)selected=[{keyword:seed,searches:null,resultCount:null}];return selected.filter((r,i)=>selected.findIndex(s=>s.keyword===r.keyword)===i);
}
