import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewContextSchema, scopedReviewContexts } from '../../shared/review-context';
import { describeReviewCoverage } from '../../app/lib/review-context-display';
import { LocalDataStageOutputResponseSchema } from '../../shared/agent-contracts';
import { stageOutputPatches } from '../../server/services/sync-job-worker-handler';

const scope={organizationId:'22222222-2222-4222-8222-222222222222',projectId:'a475efab-90ec-4b87-b957-3319f0b5022e',marketplace:'CA',asins:['B0C3Z8F66G']};
const context={schemaVersion:1,...scope,asins:undefined,asin:scope.asins[0],page:{url:'https://www.amazon.ca/dp/B0C3Z8F66G',checkedAt:'2026-10-27T02:00:00.000Z',status:'available',localReviews:'zero',evidence:'There are 0 reviews from Canada',identity:'asin-confirmed'},internationalReferences:[{reviewId:'R193V3RM3TW6DB',sourceCountry:'US',reviewedAt:'2026-04-08',countryDateText:'Reviewed in the United States on April 8, 2026',title:'Balance board',body:'Easy to use',sourceUrl:'https://www.amazon.ca/dp/B0C3Z8F66G',observedAt:'2026-10-27T02:00:00.000Z',relationship:'same-page-variant-unverified'}]};
delete (context as any).asins;
test('stage contract round trip retains separate references and rejects locally mislabeled references',()=>{
 const projection={jobId:'reference-job',projectId:scope.projectId,runId:'11111111-1111-4111-8111-111111111111',jobVersion:1,outputVersion:1,contentHash:'a'.repeat(64),updatedAt:'2026-10-27T03:00:00.000Z',stage:'reviews',stageStatus:'partial',data:{analysisByAsin:{},ratingByAsin:{},contextByAsin:{[context.asin]:context}},gap:{state:'partial',reasonCode:'UPSTREAM_EMPTY'}};
 const parsed=LocalDataStageOutputResponseSchema.parse(JSON.parse(JSON.stringify(projection))) as any;
 assert.equal(parsed.data.contextByAsin[context.asin].internationalReferences.length,1);
 assert.deepEqual(parsed.data.analysisByAsin,{});assert.deepEqual(parsed.gap,projection.gap);
 const ref=context.internationalReferences[0];
 assert.equal(LocalDataStageOutputResponseSchema.safeParse({...projection,data:{...projection.data,contextByAsin:{[context.asin]:{...context,internationalReferences:[{...ref,sourceCountry:'CA'}]}}}}).success,false);
 const {contextByAsin,...legacyData}=projection.data;
 assert.equal(LocalDataStageOutputResponseSchema.safeParse({...projection,data:legacyData}).success,true);
});
const local={asin:scope.asins[0],marketplace:'CA',status:'pending' as const,terminalReason:'valid-empty' as const,sampledReviews:0,fetchedAt:'2026-10-26',blocks:[]};
test('worker admits the optional context map and rejects cross-scope or malformed reference evidence',()=>{
 const job={...scope,runId:'11111111-1111-4111-8111-111111111111'} as any;
 const base={...job,stage:'reviews',stageStatus:'partial',contentHash:'b'.repeat(64),updatedAt:'2026-10-27T03:00:00.000Z',data:{analysisByAsin:{[context.asin]:local},ratingByAsin:{},contextByAsin:{[context.asin]:context}},gap:{state:'partial',reasonCode:'UPSTREAM_EMPTY'}};
 assert.equal(stageOutputPatches({outputs:[base]},job).length,1);
 for(const patch of [{projectId:'922a58f0-9fe2-4592-8e04-f7b7cb2cc838'},{internationalReferences:[{...context.internationalReferences[0],sourceCountry:'CA'}]}])assert.equal(stageOutputPatches({outputs:[{...base,data:{...base.data,contextByAsin:{[context.asin]:{...context,...patch}}}}]},job).length,0);
});

test('scoped context survives serialization, but other project/site/ASIN or future evidence is not admitted',()=>{
 assert.ok(ReviewContextSchema.safeParse(context).success);
 assert.equal(Object.keys(scopedReviewContexts({[context.asin]:JSON.parse(JSON.stringify(context))},scope,'2026-10-27T03:00:00Z')).length,1);
 for(const patch of [{projectId:'922a58f0-9fe2-4592-8e04-f7b7cb2cc838'},{marketplace:'UK'},{asin:'B0H7BLV7JS'},{page:{...context.page,checkedAt:'2099-01-01T00:00:00Z'}}]) assert.deepEqual(scopedReviewContexts({[context.asin]:{...context,...patch}},scope,'2026-10-27T03:00:00Z'),{});
});
test('local, unknown-country, wrong source, duplicate or future-dated international reviews are rejected',()=>{
 const ref=context.internationalReferences[0];
 for(const patch of [{sourceCountry:'CA'},{sourceCountry:'unknown'},{sourceUrl:'https://www.amazon.ca/dp/B0H7BLV7JS'},{sourceUrl:'javascript:alert(1)'},{reviewedAt:'2099-01-01'}]) assert.equal(ReviewContextSchema.safeParse({...context,internationalReferences:[{...ref,...patch}]}).success,false);
 assert.equal(ReviewContextSchema.safeParse({...context,internationalReferences:[ref,ref]}).success,false);
});
test('reason classification separates page-local-zero from unknown empty and connector failure',()=>{
 assert.match(describeReviewCoverage(local,context as any).reason,/页面确认.*本地.*0/);
 assert.match(describeReviewCoverage(local).reason,/接口.*0.*原因未核实/);
 assert.match(describeReviewCoverage({...local,status:'error'},context as any).reason,/请求失败/);
});
test('missing page preserves historical samples; generic praise and unmatched dimensions remain gaps',()=>{
 const historic={...local,status:'ready' as const,sampledReviews:8};
 const result=describeReviewCoverage(historic,{...context,page:{...context.page,status:'not-found',localReviews:'unknown',identity:'unverified'}} as any);
 assert.match(result.pageNote,/页面不可访问/);assert.match(result.reason,/8/);
 assert.match(describeReviewCoverage({...historic,sampledReviews:1,statusMessage:'仅有笼统好评（原文：Super），缺少具体主题，待补充。'}).reason,/笼统好评/);
 assert.match(describeReviewCoverage({...historic,blocks:[{key:'positives',label:'好评',rows:[{label:'质量',sharePct:50,reason:'good'}]}]} as any).reason,/维度待补/);
});
