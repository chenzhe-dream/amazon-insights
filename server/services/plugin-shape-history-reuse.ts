import {z} from 'zod';
import {PLUGIN_HISTORY_POLICY,LEGACY_PLUGIN_HISTORY_POLICY,ShapeHistoryPolicySchema,type ShapeHistorySelection} from '../../shared/shape-history-selection';
import {MarketAnalysisScopeSchema,type MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {PluginSiteSchema} from '../../shared/plugin-collection-contracts';
import type {MarketSourceEvidence} from '../../shared/market-source-contracts';
import type {PluginProductSource} from './plugin-shape-image-reuse';
import {normalizeProductHistory,normalizeProductAmountHistory} from './market-product-history-collector';
import {createMarketSourceEvidence} from '../domain/market-research/source-evidence';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';
const currencies={US:['USD','$'],CA:['CAD','$','CA$','C$','CDN$'],UK:['GBP','£'],DE:['EUR','€']} as const;
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const index=(s:string)=>Number(s.slice(0,4))*12+Number(s.slice(5))-1;
const month=(i:number)=>`${Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`;
const payloadSchema=z.object({historyPolicy:ShapeHistoryPolicySchema,asin:z.string().regex(/^[A-Z0-9]{10}$/),marketplace:PluginSiteSchema,nodeIdPath:z.string(),metric:z.enum(['SalesVolume','SalesAmount']),sourceSnapshotId:z.string().regex(/^plugin-source:[a-f0-9]{64}$/),pluginJobId:z.string().uuid(),sourceNode:z.string().regex(/^\d+$/),collectedAt:z.string().datetime({offset:true}),basic:z.record(z.string(),z.unknown()),history:z.record(z.string(),z.unknown())}).strict();
type Input={scope:MarketAnalysisScope;asin:string;metric:'SalesVolume'|'SalesAmount';source:PluginProductSource|null;policy?:ShapeHistorySelection['version'];reuseSaved?:boolean;now?:Date;notBefore?:string};
function initial(input:Input):ShapeHistorySelection{
 const start=Math.min(index(input.scope.fromMonth),index(input.scope.toMonth)-5,(Number(input.scope.toMonth.slice(0,4))-2)*12);
 return {version:input.policy??PLUGIN_HISTORY_POLICY,selectedProvider:'sorftime',nativeField:input.metric==='SalesAmount'?'amount':'sale',sourceSnapshotId:input.source?.snapshotId??null,reason:'no-bound-snapshot',requiredFrom:month(start),requiredTo:input.scope.toMonth,missingMonths:[]};
}
function project(scope:MarketAnalysisScope,value:unknown){
 const p=payloadSchema.parse(value),selection=initial({scope,asin:p.asin,metric:p.metric,source:null,policy:p.historyPolicy});selection.sourceSnapshotId=p.sourceSnapshotId;
 const reject=(reason:ShapeHistorySelection['reason'])=>{selection.reason=reason;return {selection,reuse:null};};
 if(p.marketplace!==scope.marketplace||p.nodeIdPath!==scope.nodeIdPath||p.sourceNode!==scope.nodeIdPath.split(':').at(-1)||scope.currency!==currencies[p.marketplace][0])throw new TypeError('Plugin history scope differs');
 for(const row of [p.basic,p.history]){
  if(row.asin!==undefined&&row.asin!==p.asin||['site','marketplace','amz_site'].some(k=>row[k]!==undefined&&row[k]!==scope.marketplace))return reject('identity-conflict');
  if(row.currency!==undefined&&row.currency!==null&&row.currency!==''&&!(currencies[p.marketplace] as readonly unknown[]).includes(row.currency))return reject('currency-mismatch');
 }
 if(p.metric==='SalesAmount'&&!(currencies[p.marketplace] as readonly unknown[]).includes(p.basic.currency))return reject('currency-missing');
 const nodes=Array.isArray(p.history.nodes)?p.history.nodes.map(obj).filter(n=>n.type===selection.nativeField):[],rows:string[]=[],observedMonths:string[]=[],nonNullMonths=new Set<string>();
 for(const node of nodes){
  if(!Array.isArray(node.data))throw new TypeError('Plugin history rows unavailable');
  for(const row of node.data){
   if(!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(row[0])||row[1]!==null&&(typeof row[1]!=='number'||!Number.isFinite(row[1])))throw new TypeError('Plugin history row invalid');
   rows.push(`${row[0]}=${row[1]??''}`);
   if(row[0]<=scope.toMonth){observedMonths.push(row[0]);if(row[1]!==null)nonNullMonths.add(row[0]);}
  }
 }
 // Inspect raw range before the shared normalizer's bounded projection can discard early months.
 const rawStart=Math.min(index(selection.requiredFrom),...observedMonths.map(index));
 selection.requiredFrom=month(rawStart);
 if(index(scope.toMonth)-rawStart>=120)return reject('history-range-exceeded');
 const points=p.metric==='SalesAmount'?normalizeProductAmountHistory(rows,scope.toMonth):normalizeProductHistory(rows,scope.toMonth);
 const start=Math.min(index(selection.requiredFrom),...points.map(v=>index(v.month))),end=index(scope.toMonth);
 if(end-start>=120)throw new TypeError('Required history exceeds supported range');
 selection.requiredFrom=month(start);
 const byMonth=new Map(points.map(v=>[v.month,v]));
 selection.missingMonths=Array.from({length:end-start+1},(_,i)=>month(start+i)).filter(m=>{const point=byMonth.get(m);return !point||point.issues.length>0||('amount'in point?point.amount:point.units)===null;});
 const conflicts=points.filter(p=>p.issues.includes('conflicting-month')).map(p=>p.month),invalid=points.filter(p=>p.issues.includes('invalid-value')&&nonNullMonths.has(p.month)).map(p=>p.month);
 if(conflicts.length)selection.conflictMonths=conflicts;
 if(invalid.length)selection.invalidMonths=invalid;
 selection.reason=conflicts.length?'conflicting-history':invalid.length?'invalid-history':selection.missingMonths.length?'incomplete':'complete';
 const legacy=p.historyPolicy===LEGACY_PLUGIN_HISTORY_POLICY;
 if(legacy&&selection.missingMonths.length||!points.some(point=>point.issues.length===0&&('amount'in point?point.amount:point.units)!==null))return {selection,reuse:null};
 if(!legacy&&selection.missingMonths.length)selection.reason='partial-windows';
 selection.selectedProvider='sellerSprite';
 const fetchedAt=new Date(p.collectedAt).toISOString();
 const evidence=createMarketSourceEvidence({scope,provider:'sellerSprite',operation:'plugin_history',requestIdentity:{asin:p.asin,marketplace:p.marketplace,nodeIdPath:p.nodeIdPath},responseIdentityPaths:{asin:[['asin']],marketplace:[['marketplace']],nodeIdPath:[['nodeIdPath']]},payload:JSON.parse(JSON.stringify(p)),fetchedAt,observationPeriod:{kind:'calendar-months',fromMonth:selection.requiredFrom,toMonth:scope.toMonth},units:p.metric==='SalesAmount'?{amount:{status:'known',unit:'currency',currency:scope.currency,rawUnit:'SellerSprite native amount; separate vendor series, not Sorftime SalesAmount'}}:{units:{status:'known',unit:'count',rawUnit:'SellerSprite native sale; parent/child equivalence to Sorftime is not asserted'}},coverage:{receivedCount:points.length,expectedCount:end-start+1,truncation:{status:'not-truncated'}}},new Date(fetchedAt));
 return {selection,reuse:{status:(!legacy&&selection.missingMonths.length?'partial':'ready') as 'partial'|'ready',asin:p.asin,points,evidence}};
}
/** Select a whole metric series; never splice provider months or substitute child fields. */
export function evaluatePluginShapeHistory(input:Input){
 const scope=MarketAnalysisScopeSchema.parse(input.scope),selection=initial(input),source=input.source,now=input.now??new Date();
 if(!source)return {selection,reuse:null};
 if(scope.toMonth>=now.toISOString().slice(0,7)){selection.reason='invalid-source';return {selection,reuse:null};}
 const stamp=Date.parse(source.collectedAt);
 if(source.asin!==input.asin||source.marketplace!==scope.marketplace||source.node!==scope.nodeIdPath.split(':').at(-1)){selection.reason='identity-conflict';return {selection,reuse:null};}
 if(!Number.isFinite(stamp)||stamp>now.getTime()||(!input.reuseSaved&&now.getTime()-stamp>6*3600000)){selection.reason='stale';return {selection,reuse:null};}
 if(input.notBefore!==undefined&&(!Number.isFinite(Date.parse(input.notBefore))||stamp<Date.parse(input.notBefore))){selection.reason='force-refresh';return {selection,reuse:null};}
 try{return project(scope,{historyPolicy:input.policy??PLUGIN_HISTORY_POLICY,asin:input.asin,marketplace:source.marketplace,nodeIdPath:scope.nodeIdPath,metric:input.metric,sourceSnapshotId:source.snapshotId,pluginJobId:source.jobId,sourceNode:source.node,collectedAt:source.collectedAt,basic:source.basic,history:source.history});}
 catch{selection.reason='invalid-source';return {selection,reuse:null};}
}
export function replayPluginShapeHistory(scope:MarketAnalysisScope,evidence:MarketSourceEvidence){
 if(evidence.provider!=='sellerSprite'||evidence.operation!=='plugin_history')throw new TypeError('Plugin history evidence differs');
 const {reuse}=project(scope,evidence.payload);
 if(!reuse||digest(reuse.evidence)!==digest(evidence))throw new TypeError('Plugin history replay differs');
 return reuse;
}
