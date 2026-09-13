import type {MarketOverviewExplanationInput} from '../../../shared/market-semantic-contracts';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
type Metric=MarketOverviewExplanationInput['metrics'][number];
/** This formula is a within-response ratio, not a period comparison. Even with
 * an unknown response month it is valid only for an exact row/group/source and
 * independently checkable numerator and denominator with the same unit. */
export function isValidOverviewResponseShare(metric:Metric,metrics:ReadonlyMap<string,Metric>):boolean{
  if(metric.formulaVersion!=='overview-response-group-share/v1'||metric.unit.unit!=='percent'||metric.unit.currency!==undefined)return false;
  const match=/^(dist:\d{4}-\d{2}:market_[a-z_]+:(?:sample|new-products)):(row-\d+):(products|units|revenue)SharePct$/.exec(metric.metricId);
  if(!match||metric.numeratorRef!==`${match[1]}:${match[2]}:${match[3]}`||metric.denominatorRef!==`${match[1]}:total:${match[3]}`)return false;
  const numerator=metrics.get(metric.numeratorRef),denominator=metrics.get(metric.denominatorRef);
  if(!numerator||!denominator||numerator.numeratorRef!==null||numerator.denominatorRef!==null||denominator.numeratorRef!==null||denominator.denominatorRef!==null||numerator.formulaVersion!=='overview-response-row-value/v1'||denominator.formulaVersion!=='overview-response-row-value/v1')return false;
  const unit=match[3]==='revenue'?'currency':'count';
  if(numerator.unit.unit!==unit||digest(numerator.unit)!==digest(denominator.unit)||denominator.value<=0||numerator.value<0||numerator.value>denominator.value||metric.value<0||metric.value>100)return false;
  if(metric.sourceRefs.length!==1||[numerator,denominator].some(m=>digest(m.sourceRefs)!==digest(metric.sourceRefs)||digest(m.period)!==digest(metric.period)||m.coverage.status!=='complete'))return false;
  return Math.abs(metric.value-numerator.value/denominator.value*100)<=1e-10;
}
