import {overviewSourceMonth} from '../../../shared/market-overview-period';
import {MarketOverviewProductDemandSchema} from '../../../shared/market-overview-external';
import type {MarketSourceEvidence} from '../../../shared/market-source-contracts';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export function projectOverviewProductDemand(sources:readonly MarketSourceEvidence[],referenceMonth:string,failures:unknown){
 const source=sources.find(s=>s.operation==='market_product_demand_trend'&&overviewSourceMonth(s)===referenceMonth),raw=obj(obj(source?.payload).data),rows=Array.isArray(raw.items)?raw.items:[];
 const finite=(v:unknown)=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
 const rawPoints=rows.flatMap(v=>{const row=obj(v),month=String(row.date??row.month??''),value=finite(row.glanceViews??row.pageViews??row.views??row.value);return /^20\d{2}-(0[1-9]|1[0-2])(?:-\d{2})?$/.test(month)&&month.slice(0,7)<=referenceMonth&&value!==null?[{month,value}]:[];});
 const grouped=new Map<string,number|null>();for(const point of rawPoints){const old=grouped.get(point.month);grouped.set(point.month,old===undefined||old===point.value?point.value:null);}
 const conflict=[...grouped.values()].some(v=>v===null),points=[...grouped].filter((p):p is [string,number]=>p[1]!==null).sort(([a],[b])=>a.localeCompare(b)).map(([month,value])=>({month,value}));
 const metrics={asinCount:finite(raw.asinCount),returnRatio:finite(raw.returnRatio),avgReturnRatio:finite(raw.avgReturnRatio),searchToPurchaseRatio:finite(raw.searchToPurchaseRatio),avgSearchToPurchaseRatio:finite(raw.avgSearchToPurchaseRatio)};
 const failure=Array.isArray(failures)?failures.map(obj).find(f=>f.operation==='market_product_demand_trend'&&f.month===referenceMonth):undefined;
 return MarketOverviewProductDemandSchema.parse({status:source?conflict?'partial':points.length||Object.values(metrics).some(v=>v!==null)?'ready':'empty':failure?'failed':'not-collected',points,...metrics,sourceRef:source?`market-source:${digest(source)}`:null,errorCode:conflict?'conflicting-demand-month':failure?String(failure.code):null});
}
