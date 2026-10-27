import assert from 'node:assert/strict';
import test from 'node:test';
import {projectStageOutput} from '../../scripts/lib/sync-stage-output.mjs';
test('international context preserves local analysis, ratings and gaps and excludes foreign scope',()=>{
 const asin='B0C3Z8F66G',scope={organizationId:'org',projectId:'project',marketplace:'CA'};
 const local={asin,marketplace:'CA',status:'pending',terminalReason:'valid-empty',sampledReviews:0,mentionTopics:0,fetchedAt:'2026-10-26',blocks:[]};
 const context={...scope,asin,page:{checkedAt:'2026-10-27T00:00:00Z'},internationalReferences:[{sourceCountry:'US',body:'reference only'}]};
 const project=ctx=>projectStageOutput('reviews',[asin],{...scope,stageStatus:'partial',dataAsins:[],updatedAt:'2026-10-27T03:00:00Z',readExport:(_,name)=>name==='reviewContextData'?{[asin]:ctx}:name==='sorftimeReviewAnalysisData'?{[asin]:local}:{}});
 const before=project(undefined),after=project(context);
 assert.deepEqual(after.data.contextByAsin,{[asin]:context});
 assert.deepEqual(after.data.analysisByAsin,before.data.analysisByAsin);assert.deepEqual(after.data.ratingByAsin,before.data.ratingByAsin);assert.deepEqual(after.gap,before.gap);
 assert.notEqual(after.contentHash,before.contentHash);
 for(const patch of [{projectId:'other'},{marketplace:'US'},{organizationId:'other'},{asin:'B0H7BLV7JS'},{page:{checkedAt:'2099-01-01'}}])assert.equal(project({...context,...patch}).data.contextByAsin,undefined);
});
