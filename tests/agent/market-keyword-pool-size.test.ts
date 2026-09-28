import assert from 'node:assert/strict';
import test from 'node:test';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {keywordRuleBaselineFromPool} from '../../server/domain/market-research/keyword-rule-baseline';
import {MarketInputRecordSchema} from '../../shared/market-analysis-contracts';
const scope={organizationId:'22222222-2222-4222-8222-222222222222',researchId:'33333333-3333-4333-8333-333333333333',marketplace:'US' as const,nodeIdPath:'1063294',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD' as const};
test('100 keyword pool metrics cite their own records and fit the unchanged settlement JSON bound',()=>{
 const records=Array.from({length:100},(_,i)=>({id:`kw_${String(i).padStart(64,'0')}`,scope,data:{member:{monthlySearchVolume:{value:i,reason:null}}}}));
 const snapshot=createMarketInputSnapshot({scope,kind:'keywords',sourceVersion:'source/v1',ruleVersion:'rule/v1',collectedAt:'2026-09-01T00:00:00.000Z',expectedRecordIds:records.map(r=>r.id),records});
 const args={scope,snapshot,clusterCount:0};
 const baseline=keywordRuleBaselineFromPool({...args,evidenceMode:'keyword-record/v2'});
 assert.equal(MarketInputRecordSchema.shape.data.safeParse(baseline).success,true);
 for(const record of records){const metric=baseline.metrics.find(m=>m.key===`${record.id}:searchVolume`)!;assert.deepEqual(metric.evidenceRefs.map(e=>e.id),[`${snapshot.snapshotId}:${record.id}`]);}
 assert.equal(baseline.metrics[0].value,0);
 assert.ok(JSON.stringify(baseline).length<150000);
 const legacy=keywordRuleBaselineFromPool(args);assert.equal(legacy.metrics[0].evidenceRefs.length,100,'Unversioned historical outputs retain their original evidence identity');
 assert.equal(legacy.metrics[0].value,baseline.metrics[0].value);
});

