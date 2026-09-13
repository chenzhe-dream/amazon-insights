import {z} from 'zod';
import {MarketAnalysisScopeSchema,type MarketAnalysisScope} from '../../../shared/market-analysis-contracts';
import type {MarketSourceEvidence} from '../../../shared/market-source-contracts';
import {MARKET_OVERVIEW_ADDITIONAL_OPERATIONS,MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION,MarketOverviewExpandedSourceFailureSchema,MarketOverviewDistributionEntrySchema,type MarketOverviewExpandedSourceFailure,type MarketOverviewDistributionEntry} from '../../../shared/market-overview-distribution-contracts';
import {buildMarketOverviewSourceCatalog,MarketOverviewSourceFailureSchema} from './overview-source-catalog';
import {createMarketInputSnapshot} from './snapshot';
import {projectMarketOverviewDistribution} from '../../services/market-overview-distribution-collector';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';

/** Extended catalog keeps legacy scalar rules frozen and adds separately scoped
 * response distributions. It never borrows a denominator from the scalar API. */
export function buildMarketOverviewExpandedCatalog(input:{scope:MarketAnalysisScope;parameters:{headTopN:5|10|20;newProductMonths:1|3|6|12};dataCutoffAt:string;sources:readonly MarketSourceEvidence[];failures?:readonly MarketOverviewExpandedSourceFailure[]}){
  const scope=MarketAnalysisScopeSchema.parse(input.scope),cutoff=z.string().datetime().parse(input.dataCutoffAt),failures=z.array(MarketOverviewExpandedSourceFailureSchema).parse(input.failures??[]);
  const additional=(op:string)=>(MARKET_OVERVIEW_ADDITIONAL_OPERATIONS as readonly string[]).includes(op),basic=input.sources.filter(s=>!additional(s.operation));
  const base=buildMarketOverviewSourceCatalog({...input,scope,sources:basic,failures:failures.filter(f=>!additional(f.operation)).map(f=>MarketOverviewSourceFailureSchema.parse(f)),version:MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION});
  const distributions:MarketOverviewDistributionEntry[]=[],accepted=new Map<string,MarketSourceEvidence>(),failed=new Map<string,MarketOverviewExpandedSourceFailure>();
  for(const source of input.sources.filter(s=>additional(s.operation))){
    const month=source.requestIdentity.month,key=`${month}/${source.operation}`;
    if(digest(source.scope)!==digest(scope)||source.provider!=='sellerSprite'||!month||month<scope.fromMonth||month>scope.toMonth||accepted.has(key))throw new TypeError('Expanded overview source scope or endpoint differs');accepted.set(key,source);
  }
  for(const failure of failures.filter(f=>additional(f.operation))){const key=`${failure.month}/${failure.operation}`;
    if(failure.month<scope.fromMonth||failure.month>scope.toMonth||accepted.has(key)||failed.has(key))throw new TypeError('Expanded overview failure conflicts with source');failed.set(key,failure);}
  for(const row of base.months)for(const operation of MARKET_OVERVIEW_ADDITIONAL_OPERATIONS){
    const source=accepted.get(`${row.month}/${operation}`),failure=failed.get(`${row.month}/${operation}`);
    if(!source){distributions.push({month:row.month,operation,status:failure?'failed':'not-collected',sourceRef:null,fetchedAt:null,scopeBasis:null,distribution:null,issues:failure?[{code:failure.code,retryable:false}]:[]});continue;}
    const projection=projectMarketOverviewDistribution({scope,month:row.month,operation,...input.parameters,payload:source.payload,fetchedAt:source.fetchedAt,now:new Date(cutoff)});
    if(!projection.evidence||digest(projection.evidence)!==digest(source))throw new TypeError('Expanded overview source projection differs');
    distributions.push(MarketOverviewDistributionEntrySchema.parse({month:row.month,operation,status:projection.status,sourceRef:`market-source:${digest(source)}`,fetchedAt:source.fetchedAt,
      scopeBasis:source.responseIdentity.nodeIdPath.status==='verified'&&source.responseIdentity.month.status==='verified'?'response-verified':'request-bound',distribution:projection.distribution,issues:projection.issues}));
  }
  const version=MARKET_OVERVIEW_EXPANDED_CATALOG_VERSION,numericSnapshot=createMarketInputSnapshot({scope,kind:'overview',sourceVersion:base.numericSnapshot.sourceVersion,ruleVersion:version,collectedAt:cutoff,
    expectedRecordIds:base.numericSnapshot.expectedRecordIds,records:base.numericSnapshot.records.map(r=>({id:r.id,scope,data:{...(r.data as object),distributions:distributions.filter(d=>d.month===r.id)}}))});
  // The existing semantic task still explains scalar facts only. Distribution
  // synthesis is explicitly incomplete until its evidence contract is wired.
  const s=base.semanticSnapshot,semanticSnapshot=s?createMarketInputSnapshot({scope,kind:s.kind,sourceVersion:s.sourceVersion,ruleVersion:version,collectedAt:s.collectedAt,expectedRecordIds:s.expectedRecordIds,records:s.records}):null;
  return {...base,version,numericSnapshot,semanticSnapshot,distributions,sourceRefs:[...new Set([...base.sourceRefs,...distributions.flatMap(d=>d.sourceRef?[d.sourceRef]:[])])].sort()};
}
