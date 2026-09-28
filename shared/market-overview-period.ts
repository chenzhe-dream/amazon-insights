import type {MarketAnalysisScope} from './market-analysis-contracts';
import type {MarketSourceEvidence} from './market-source-contracts';
/** Calendar months bound historical series; rolling snapshots have a separate identity. */
export function overviewSourceMonth(source:MarketSourceEvidence){
 return source.scope.overviewPeriod==='last30'&&source.observationPeriod.kind==='trailing-days'&&source.observationPeriod.days===30?source.scope.toMonth:source.requestIdentity.month;
}
export function overviewPeriodLabel(scope:Pick<MarketAnalysisScope,'fromMonth'|'toMonth'|'overviewPeriod'>){return scope.overviewPeriod==='last30'?'最近30天':`${scope.fromMonth} 至 ${scope.toMonth}`;}
export function overviewMonthLabel(month:string){return month==='last30'?'最近30天':month;}
export function latestCompleteOverviewMonth(now=new Date()){const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;}
