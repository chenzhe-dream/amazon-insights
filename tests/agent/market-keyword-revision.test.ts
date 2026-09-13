import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMarketKeywordRevision } from '../../server/domain/market-research/keyword-revision';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import type { MarketKeywordFacts } from '../../shared/market-keyword-public-contracts';
const uuid = '00000000-0000-4000-8000-000000000001', hash = 'a'.repeat(64);
function fixture(volumes: (number|null)[] = [10, 30, 0, null]) {
  const missing = { value: null, reason: 'missing' }, value = {
    version: 'market-keyword-facts/v1', moduleRunId: uuid,
    scope: { organizationId: uuid, researchId: uuid, marketplace: 'US', nodeIdPath: '12', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' }, referenceMonth: '2026-08',
    pool: { attemptId: uuid, rawInputSnapshotId: `market-input:${hash}`, semanticInputSnapshotId: `market-input:${hash}`, basisHash: hash, dataCutoffAt: '2026-09-01T00:00:00.000Z', plannedPageCount: 1, receivedPageCount: 1, missingPages: [], emptyPages: [], fullPages: [], collectionCoverage: 'complete', exhaustive: false, maxMembers: 2000, uniqueObservedMemberCount: volumes.length, omittedMemberIds: [], conflictingMemberIds: [], duplicateMemberCount: 0, memberLimitReached: false, selectionPolicy: 'seed-page-source-order/first-observation/v1' },
    members: volumes.map((searchVolume, i) => ({ keywordId: `keyword:${i}`, keyword: `lamp ${i}`, sourceRef: `market-source:${hash}`, occurrences: [],
      pageMetrics: { monthlySearchVolume: { value: 999, reason: null }, weeklySearchVolume: missing, weeklySearchRank: missing, recommendedCpcUsd: { value: 4, reason: null }, period: 'unspecified-source-window' },
      trend: { status: 'empty', stepId: null, attemptId: null, inputSnapshotId: null, sourceRef: null, fetchedAt: null, cpcCurrency: null, months: [] },
      reference: { searchVolume, yoyGrowth: i === 0 ? 0 : i === 1 ? 1 : null, recentGrowth: i === 0 ? -1 : null, actualCpcUsd: null, actualCpcReason: 'source-provides-recommended-bid-only' } })),
    semantics: { status: 'unavailable', unavailableKeywordIds: volumes.map((_,i)=>`keyword:${i}`), unknownDimensionCount: 0, unknownClusterCount: 0, batches: [] }
  };
  const facts = { ...value, factsId: `market-keyword-facts:${digest(value)}` } as MarketKeywordFacts;
  const request = { factsId: facts.factsId, expectedParentRevisionId: null, labels: { W1: [{ labelId: 'human-new', label: '人工新标签', definition: '人工定义' }], W2: [], W3: [], W4: [] }, clusters: [{ clusterId: 'one', label: '同名', definition: '第一簇' }, { clusterId: 'two', label: '同名', definition: '第二簇' }], assignments: facts.members.map((m,i)=>({ keywordId:m.keywordId,W1:['human-new'],W2:[],W3:[],W4:[],clusterId:i<2?'one':null })), note: '人工校对' };
  return { facts, request, authorId: uuid, createdAt: '2026-09-13T00:00:00.000Z' };
}
test('revision conserves every original member, unknown/zero reference metrics and untouched semantics', () => {
  const input=fixture(), before=structuredClone(input), result=buildMarketKeywordRevision(input);
  assert.deepEqual(input,before); assert.deepEqual(result.facts,input.facts);
  assert.equal(result.aggregation.pool.memberCount,4); assert.equal(result.aggregation.pool.knownSearchVolume,40);
  assert.equal(result.aggregation.pool.totalSearchVolume,null); assert.equal(result.aggregation.clusters[0].searchVolumeSharePercent,null);
  assert.equal(result.aggregation.clusters[0].yoyGrowth.value,.75); assert.equal(result.aggregation.clusters[0].recentGrowth.value,-1);
  assert.equal(result.aggregation.clusters[0].cpc.value,null); assert.equal(result.aggregation.unassigned.knownSearchVolumeCount,1);
  result.classification.assignments[0].W1.length=0; assert.equal(input.request.assignments[0].W1.length,1);
});
test('reclassification recomputes from original members and full pool denominator even with duplicate display labels',()=>{
  const input=fixture([10,30,60]); input.request.assignments[1].clusterId='two';
  const result=buildMarketKeywordRevision(input); assert.equal(result.aggregation.clusters[0].searchVolumeSharePercent,10);
  assert.equal(result.aggregation.clusters[1].searchVolumeSharePercent,30); assert.equal(result.aggregation.unassigned.searchVolumeSharePercent,60);
  input.request.assignments[1].clusterId='one'; const merged=buildMarketKeywordRevision(input);
  assert.equal(merged.aggregation.clusters[0].searchVolumeSharePercent,40); assert.equal(merged.aggregation.clusters[0].yoyGrowth.value,.75);
});
test('reject omitted, duplicate, foreign members, invalid labels and cluster assignments',()=>{
  for(const mutate of [
    (i:ReturnType<typeof fixture>)=>{i.request.assignments.pop();},
    (i:ReturnType<typeof fixture>)=>{i.request.assignments[1].keywordId=i.request.assignments[0].keywordId;},
    (i:ReturnType<typeof fixture>)=>{i.request.assignments[0].keywordId='foreign';},
    (i:ReturnType<typeof fixture>)=>{i.request.assignments[0].W1=['missing'];},
    (i:ReturnType<typeof fixture>)=>{i.request.assignments[0].W1=['human-new','human-new'];},
    (i:ReturnType<typeof fixture>)=>{i.request.assignments[0].clusterId='missing';},
    (i:ReturnType<typeof fixture>)=>{i.request.labels.W1.push(i.request.labels.W1[0]);},
    (i:ReturnType<typeof fixture>)=>{i.request.clusters.push(i.request.clusters[0]);},
  ]) { const input=fixture(); mutate(input); assert.throws(()=>buildMarketKeywordRevision(input)); }
});
test('validates full facts identity and deterministic revision identity',()=>{
  const input=fixture(), one=buildMarketKeywordRevision(input); assert.deepEqual(buildMarketKeywordRevision(input),one);
  input.request.note='改订'; assert.notEqual(buildMarketKeywordRevision(input).revision.revisionId,one.revision.revisionId);
  input.facts.members[0].reference.searchVolume=500; assert.throws(()=>buildMarketKeywordRevision(input));
  const corrupt=fixture(); corrupt.facts.pool.exhaustive=true as false; assert.throws(()=>buildMarketKeywordRevision(corrupt));
});
test('enforces 2000 members, 48 labels, 3 assignments and supports explicit empty assignments',()=>{
  const input=fixture(); input.request.assignments.forEach(a=>{a.W1=[];a.clusterId=null;});
  assert.equal(buildMarketKeywordRevision(input).aggregation.unassigned.memberCount,4);
  input.request.labels.W1=Array.from({length:49},(_,i)=>({labelId:`l${i}`,label:'人工',definition:'定义'}));
  assert.throws(()=>buildMarketKeywordRevision(input));
  input.request.labels.W1=input.request.labels.W1.slice(0,4); input.request.assignments[0].W1=['l0','l1','l2','l3']; assert.throws(()=>buildMarketKeywordRevision(input));
  assert.throws(()=>buildMarketKeywordRevision(fixture(Array.from({length:2001},()=>0))));
  assert.equal(buildMarketKeywordRevision(fixture([])).aggregation.pool.memberCount,0);
});
