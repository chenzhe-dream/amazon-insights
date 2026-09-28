import type {MarketKeywordFacts} from '../../../shared/market-keyword-public-contracts';
export const ORIGINAL_HISTORY_FORMULA='equal-history-window-growth/v1' as const;
export const ORIGINAL_THREE_MONTH_FORMULA='three-month-sum-growth/v1' as const;
export const ORIGINAL_LIFECYCLE_FORMULA='original-lifecycle-complete-inputs/v1' as const;
type Point=MarketKeywordFacts['members'][number]['trend']['months'][number];
export function previousMonth(month:string,offset:number){const [year,m]=month.split('-').map(Number),n=year*12+m-1-offset;return `${Math.floor(n/12)}-${String(n%12+1).padStart(2,'0')}`;}
/** Fixed contiguous calendar windows ending at the completed reference month; no gap compression. */
export function originalTrendGrowth(points:readonly Point[],referenceMonth:string,kind:'history'|'three-month'){
 const past=points.filter(p=>p.month<=referenceMonth);
 if(new Set(points.map(p=>p.month)).size!==points.length)throw new TypeError('Duplicate historical trend month');
 if(past.length!==points.length)throw new TypeError('Historical trend exceeds reference month');
 for(const p of points)if(p.searchVolume.value!==null&&(!Number.isSafeInteger(p.searchVolume.value)||p.searchVolume.value<0))throw new TypeError('Search volume must be a safe integer count');
 // Rank/bid series may extend farther back than volume. Size the comparison
 // from the first usable volume month, while retaining calendar gaps inside it.
 const volumePoints=past.filter(p=>p.searchVolume.value!==null&&p.searchVolume.reason===null);
 const firstVolumeMonth=volumePoints.reduce<string|null>((first,p)=>first===null||p.month<first?p.month:first,null);
 const ordinal=(month:string)=>{const [year,m]=month.split('-').map(Number);return year*12+m;};
 const volumeSpan=firstVolumeMonth===null?0:ordinal(referenceMonth)-ordinal(firstVolumeMonth)+1;
 const windowMonths=kind==='history'?Math.min(12,Math.floor(volumeSpan/2)):3;
 const formulaVersion=kind==='history'?ORIGINAL_HISTORY_FORMULA:ORIGINAL_THREE_MONTH_FORMULA;
 const months=(offset:number)=>Array.from({length:windowMonths},(_,i)=>previousMonth(referenceMonth,offset+windowMonths-1-i));
 const currentMonths=months(0),baselineMonths=months(windowMonths);
 const total=(window:string[])=>{const values=window.map(month=>past.find(p=>p.month===month)?.searchVolume);if(values.some(v=>!v||v.value===null||v.reason!==null))return null;const sum=values.reduce((sum,v)=>sum+v!.value!,0);if(!Number.isSafeInteger(sum))throw new TypeError('Historical sum exceeds safe integer count');return sum;};
 const insufficient=windowMonths<(kind==='history'?6:3)||volumePoints.length<windowMonths*2;
 const currentValue=insufficient?null:total(currentMonths),baselineValue=insufficient?null:total(baselineMonths);
 const reason=insufficient?'insufficient-history':currentValue===null?'missing-current-window':baselineValue===null?'missing-baseline-window':baselineValue===0?'zero-baseline':null;
 return {value:reason===null?currentValue!/baselineValue!-1:null,reason,unit:'fraction' as const,referenceMonth,currentValue,baselineMonth:baselineMonths.at(-1)??null,baselineValue,formulaVersion,window:{months:windowMonths,currentMonths,baselineMonths}};
}
export function originalLifecycle(history:number|null,threeMonth:number|null){
 if(history===null||threeMonth===null)return {status:'unavailable' as const,reason:'incomplete-lifecycle-growth-inputs'};
 const value=.6*history+.4*threeMonth;
 return {status:'computed' as const,diagnosis:value>=.2?'growing' as const:value<=-.2?'recent_weakening' as const:'mature_stable' as const,value,formulaVersion:ORIGINAL_LIFECYCLE_FORMULA};
}
