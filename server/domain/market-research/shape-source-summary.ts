import {MarketShapeSourceSummarySchema} from '../../../shared/market-shape-source-summary-contracts';
import type {readMarketProductMonth} from './product-month-evidence';
import {marketProductSourceAdmission} from './product-source-admission';
import {projectMarketShapeSourceMetadata} from './shape-source-metadata';
import {canonicalJsonSha256} from '../../runtime/model-request-accounting';
type Checked=Awaited<ReturnType<typeof readMarketProductMonth>>;
const index=(month:string)=>Number(month.slice(0,4))*12+Number(month.slice(5))-1;
const format=(n:number)=>`${Math.floor(n/12)}-${String(n%12+1).padStart(2,'0')}`;
const sum=(values:(number|null)[])=>values.length&&values.every(v=>v!==null)?values.reduce<number>((n,v)=>n+v!,0):null;
/** Frozen-source read projection. No classification, revision write or supplier request. */
export function buildMarketShapeSourceSummary(reference:Checked,history:Checked[],requestBound:boolean){
 const scope=reference.observation.snapshot.scope,pool=reference.products.map(p=>p.asin),sources=new Map([[reference.observation.month,reference]]);
 for(const checked of history){
  if(canonicalJsonSha256(checked.observation.snapshot.scope)!==canonicalJsonSha256(scope)||sources.has(checked.observation.month)||checked.observation.snapshot.expectedRecordIds.some(asin=>!pool.includes(asin)))throw new TypeError('Source summary history differs from frozen product scope');
  sources.set(checked.observation.month,checked);
 }
 const months=Array.from({length:index(scope.toMonth)-index(scope.fromMonth)+1},(_,i)=>format(index(scope.fromMonth)+i));
 const products=pool.map(asin=>({asin,observations:months.map(month=>{
  const source=sources.get(month),p=source?.products.find(p=>p.asin===asin),proof=requestBound&&source&&p?marketProductSourceAdmission(source,asin):null;
  const issues=!source?['not-collected']:!p?['member-missing']:[...(!requestBound&&!p.scopeConfirmed?['scope-unconfirmed']:[]),...(!requestBound&&!p.periodConfirmed?['period-unconfirmed']:[]),...(proof?.periodBasis==='unsupported-month'?['period-outside-provider-history']:[]),...(p.units===null?['units-missing']:[])];
  return {month,units:issues.length?null:p!.units,issues};
 })}));
 const comparable=products.filter(p=>p.observations.every(o=>o.units!==null));
 const monthly=months.map(month=>({month,totalUnits:sum(comparable.map(p=>p.observations.find(o=>o.month===month)!.units))}));
 const end=index(scope.toMonth),year=Number(scope.toMonth.slice(0,4));
 const periods=[{id:'last-3',start:end-2,end},{id:'last-6',start:end-5,end},...[year-1,year-2].map(y=>({id:`year-${y}`,start:y*12,end:y*12+11}))].map(period=>{
  const covered=period.start>=index(scope.fromMonth)&&period.end<=end;
  return {id:period.id,issues:covered?[]:['period-not-collected'],products:products.map(p=>({asin:p.asin,units:covered&&comparable.includes(p)?sum(p.observations.filter(o=>index(o.month)>=period.start&&index(o.month)<=period.end).map(o=>o.units)):null}))};
 });
 return MarketShapeSourceSummarySchema.parse({basis:'collected-source',scope,selectedAsins:pool,eligibleAsins:comparable.map(p=>p.asin),totalUnits:sum(monthly.map(m=>m.totalUnits)),referenceRevenue:sum(pool.map(asin=>projectMarketShapeSourceMetadata(reference,asin,requestBound).revenue.value)),monthly,products,periods});
}
