import type {MarketAnalysisScope,MarketInputSnapshot} from '../../../shared/market-analysis-contracts';
import {MARKET_SOURCE_HANDLER_VERSION,type MarketSourceEvidence} from '../../../shared/market-source-contracts';
import {normalizeMarketKeywordAbaSource} from './keyword-aba-source';
import {createMarketInputSnapshot} from './snapshot';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';

const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))throw new TypeError('ABA evidence differs from its frozen source');};
/** Full raw replay validates both the projection and immutable source/snapshot envelope. */
export function readMarketKeywordAbaEvidence(input:{scope:MarketAnalysisScope;snapshot:MarketInputSnapshot;sourceRef:string;source:MarketSourceEvidence;
 members:{keywordId:string;keyword:string}[];referenceMonth:string}){
 const {scope,snapshot:s,sourceRef,source,members,referenceMonth}=input;
 same(scope,s.scope);same(scope,source.scope);
 if(s.kind!=='keywords'||s.sourceVersion!==MARKET_SOURCE_HANDLER_VERSION||s.ruleVersion!=='source-normalization/v1'||s.collectedAt!==source.fetchedAt||
  sourceRef!==`market-source:${digest(source)}`||source.provider!=='sif'||source.operation!=='market_get_keyword_history')throw new TypeError('Invalid ABA source identity');
 const now=new Date(source.fetchedAt);
 same(s,createMarketInputSnapshot({scope,kind:s.kind,sourceVersion:s.sourceVersion,ruleVersion:s.ruleVersion,collectedAt:s.collectedAt,expectedRecordIds:s.expectedRecordIds,records:s.records},now));
 const result=normalizeMarketKeywordAbaSource({scope,keywords:members.map(m=>m.keyword),referenceMonth,fetchedAt:source.fetchedAt,rawPayload:source.payload},now);
 if(result.status==='failed')throw new TypeError('Saved ABA raw payload failed validation');
 same(result.evidence,source);
 same(result.members.map(m=>({keywordId:m.memberId,keyword:m.keyword})),members);
 const {evidence:_evidence,...batch}=result;void _evidence;
 const batchId=`keyword-aba-batch:${digest(members.map(m=>m.keywordId))}`;
 same(s.expectedRecordIds,[batchId]);same(s.records,[{id:batchId,scope,data:{collection:'keyword-aba',result:batch,sourceRef}}]);
 return result;
}
