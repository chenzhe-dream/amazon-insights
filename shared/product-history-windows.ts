import type {ProductHistoryPoint,ProductAmountHistoryPoint} from './market-product-history-contracts';
export const CALENDAR_HISTORY_POLICY='calendar-windows/v2' as const;
const index=(s:string)=>Number(s.slice(0,4))*12+Number(s.slice(5))-1;
const month=(i:number)=>`${Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`;

/** Each calendar window stands alone. Missing, conflicting or invalid months never contribute zero. */
export function calendarHistoryWindows(points:readonly (ProductHistoryPoint|ProductAmountHistoryPoint)[],referenceMonth:string){
 const end=index(referenceMonth),year=Number(referenceMonth.slice(0,4)),map=new Map<string,number|null>();
 for(const point of points){
  const raw='amount'in point?point.amount:point.units;
  const value=point.issues.length===0&&typeof raw==='number'&&Number.isFinite(raw)&&raw>=0&&raw<=Number.MAX_SAFE_INTEGER?raw:null;
  map.set(point.month,map.has(point.month)&&map.get(point.month)!==value?null:value);
 }
 return [{id:'last-3',start:end-2,end},{id:'last-6',start:end-5,end},...[year-1,year-2].map(y=>({id:`year-${y}`,start:y*12,end:y*12+11}))].map(window=>{
  const months=Array.from({length:window.end-window.start+1},(_,i)=>month(window.start+i));
  const missingMonths=months.filter(m=>map.get(m)==null);
  const total=missingMonths.length?null:months.reduce((sum,m)=>sum+map.get(m)!,0);
  return {id:window.id,fromMonth:months[0],toMonth:months.at(-1)!,months,missingMonths,value:total!==null&&Number.isFinite(total)&&total<=Number.MAX_SAFE_INTEGER?total:null};
 });
}
