import type {MarketShapePublicRevision} from '../../../shared/market-shape-public-contracts';
import {MARKET_SHAPE_PERIOD_PROJECTION_VERSION,MarketShapePeriodProjectionSchema,type MarketShapePeriodProjection} from '../../../shared/market-shape-period-contracts';
const index=(month:string)=>Number(month.slice(0,4))*12+Number(month.slice(5))-1;
const format=(n:number)=>`${Math.floor(n/12)}-${String(n%12+1).padStart(2,'0')}`;
const ratio=(numerator:number|null,denominator:number|null)=>({numerator,denominator,value:numerator===null||denominator===null||denominator===0?null:numerator/denominator});
/** Pure read projection. Never changes the catalog or broadens its comparable cohort. */
export function buildMarketShapePeriodProjection(report:MarketShapePublicRevision):MarketShapePeriodProjection {
 const end=index(report.scope.toMonth),year=Number(report.scope.toMonth.slice(0,4));
 const periods=[{id:'last-3',label:'近3个月',fromMonth:format(end-2),toMonth:report.scope.toMonth},{id:'last-6',label:'近6个月',fromMonth:format(end-5),toMonth:report.scope.toMonth},
  ...[year-1,year-2].map(y=>({id:`year-${y}`,label:String(y),fromMonth:`${y}-01`,toMonth:`${y}-12`})),{id:'study',label:`${report.scope.fromMonth} 至 ${report.scope.toMonth}`,fromMonth:report.scope.fromMonth,toMonth:report.scope.toMonth}];
 const selected=new Set(report.selectedAsins),eligible=new Set(report.eligibleAsins),rows=report.products.filter(p=>selected.has(p.asin));
 if(selected.size!==report.selectedAsins.length||eligible.size!==report.eligibleAsins.length||rows.length!==selected.size||new Set(rows.map(p=>p.asin)).size!==rows.length||[...eligible].some(asin=>!selected.has(asin)))throw new TypeError('Saved comparable cohort differs from selected products');
 if(rows.some(p=>new Set(p.observations.map(o=>o.month)).size!==p.observations.length))throw new TypeError('Saved product has duplicate month observations');
 const metadata=new Map(report.structure?.products.map(p=>[p.asin,p]));
 return MarketShapePeriodProjectionSchema.parse({version:MARKET_SHAPE_PERIOD_PROJECTION_VERSION,basisCatalogId:report.catalogId,comparisonBasis:'whole-study-complete-common-members',periods:periods.map(period=>{
  const monthCount=index(period.toMonth)-index(period.fromMonth)+1,months=Array.from({length:monthCount},(_,i)=>format(index(period.fromMonth)+i));
  const saved=period.fromMonth>=report.scope.fromMonth&&period.toMonth<=report.scope.toMonth;
  const products=rows.map(p=>{
   const values=months.map(month=>p.observations.find(o=>o.month===month)?.units);
   if(saved&&eligible.has(p.asin)&&values.some(v=>v==null))throw new TypeError('Saved comparable cohort has a missing period observation');
   return {asin:p.asin,units:saved&&eligible.has(p.asin)?values.reduce<number>((sum,v)=>sum+v!,0):null,issues:!saved?['period-not-saved']:!eligible.has(p.asin)?['outside-comparable-cohort']:[]};
  });
  const units=new Map(products.map(p=>[p.asin,p.units]));
  const sum=(members:typeof rows)=>{const values=members.map(p=>units.get(p.asin)).filter((v):v is number=>v!=null);return values.length?values.reduce((a,b)=>a+b,0):null};
  const stats=(members:typeof rows,denominator:typeof rows)=>{const total=sum(members),comparableLinks=members.filter(p=>units.get(p.asin)!=null).length;return {requestedLinks:members.length,comparableLinks,units:total,monthlyUnitsPerLink:total===null||!comparableLinks?null:total/(comparableLinks*monthCount),linkShare:ratio(members.length,denominator.length),salesShare:ratio(total,sum(denominator))}};
  const bandOf=(p:typeof rows[number])=>p.price===null?null:report.bands.find(b=>p.price!>=b.minInclusive&&(b.maxExclusive===null||p.price!<b.maxExclusive))?.id??null;
  const bandIds=[...report.bands.map(b=>b.id),null];
  const segments=[{kind:'all',labelId:null,rows},...report.groups.map(g=>({kind:'shape',labelId:g.labelId,rows:rows.filter(p=>p.shape===g.labelId)}))].map(segment=>{
   const members=segment.rows,brandOf=(p:typeof rows[number])=>metadata.get(p.asin)?.brand.value??null,yearOf=(p:typeof rows[number])=>{const date=metadata.get(p.asin)?.listing.value;return date?Number(date.slice(0,4)):null};
   return {kind:segment.kind,labelId:segment.labelId,requestedAsins:members.map(p=>p.asin),eligibleAsins:members.filter(p=>units.get(p.asin)!=null).map(p=>p.asin),stats:stats(members,rows),
    bands:bandIds.filter(id=>id!==null||members.some(p=>bandOf(p)===null)).map(bandId=>({bandId,stats:stats(members.filter(p=>bandOf(p)===bandId),members)})),
    brands:[...new Set(members.map(brandOf))].sort((a,b)=>a===null?1:b===null?-1:a.localeCompare(b)).map(brand=>{const matching=members.filter(p=>brandOf(p)===brand);return {brand,stats:stats(matching,members),bands:bandIds.filter(id=>matching.some(p=>bandOf(p)===id)).map(bandId=>({bandId,stats:stats(matching.filter(p=>bandOf(p)===bandId),members.filter(p=>bandOf(p)===bandId))}))}}),
    listingYears:[...new Set(members.map(yearOf))].sort((a,b)=>a===null?1:b===null?-1:b-a).map(year=>({year,stats:stats(members.filter(p=>yearOf(p)===year),members)}))};
  });
  return {...period,monthCount,status:saved&&eligible.size?'available':'unavailable',issues:!saved?['period-not-saved']:!eligible.size?['no-comparable-members']:[],products,segments};
 })});
}
