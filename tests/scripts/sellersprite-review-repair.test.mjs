import assert from 'node:assert/strict';
import test from 'node:test';
import * as collector from '../../scripts/build-sellersprite-review-analysis.mjs';
import { fetchSellerSpriteReviews } from '../../scripts/lib/sellersprite-mcp-client.mjs';
import * as runner from '../../scripts/run-asin-sync-job.mjs';
import { projectStageOutput } from '../../scripts/lib/sync-stage-output.mjs';

test('UK review collector distinguishes malformed sibling from genuine empty and real reviews', async t => {
  const asins=['B0FJ4T6V2C','B0F5NRLWB6','B0C6FP6LMY'];
  const env={AGENT_SYNC_JOB_ID:'review-schema-fixture',AGENT_SYNC_STAGE_ID:'reviews'};
  const oldExit=process.exitCode;
  t.after(()=>{process.exitCode=oldExit;});
  let stderr='';
  t.mock.method(process.stderr,'write',text=>{stderr+=text;return true;});
  const oldEmpty={asin:asins[1],marketplace:'UK',status:'pending',sampledReviews:0,blocks:[]};
  assert.equal(typeof collector.runSellerSpriteReviewAnalysis,'function');
  const records=await collector.runSellerSpriteReviewAnalysis({
    env,key:'fixture',marketplace:'UK',providerMarketplace:'UK',asins,existing:{[asins[1]]:oldEmpty},repair:true,
    fetchedAt:'2026-10-21',writeFileSync:()=>{},wait:async()=>{},
    fetchReviews:(_key,marketplace,asin)=>fetchSellerSpriteReviews('fixture',marketplace,asin,{env,callTool:async()=>({
      code:'OK',data:{items:asin===asins[0]?'bad':asin===asins[1]?[]:[{author:'A',title:'Fun',content:'Easy to use and fun for family',star:5}],total:asin===asins[2]?1:0,pages:1},
    })}),
  });
  assert.equal(process.exitCode,1);
  const diagnostics=stderr.split('\n').filter(line=>line.startsWith('@@provider-diagnostic@@')).map(line=>JSON.parse(line.slice('@@provider-diagnostic@@'.length)));
  assert.equal(diagnostics.length,1);
  assert.deepEqual(diagnostics[0],{connector:'sellerSprite',stage:'reviews',asin:asins[0],failureKind:'schema',causeCode:'MCP_SCHEMA',operation:'review',boundary:'consumer-shape'});
  assert.equal(records[asins[0]].status,'error');
  assert.equal(records[asins[1]].status,'pending');
  assert.equal(records[asins[1]].terminalReason,'valid-empty');
  assert.equal(records[asins[2]].status,'ready');
  assert.equal(records[asins[2]].sampledReviews,1);
  assert.deepEqual(runner.sellerSpriteReviewResultStatuses(asins,records,'UK',diagnostics),{
    [asins[0]]:'connector-failed',[asins[1]]:'upstream-empty',
  });
});

test('seven-ASIN persisted review stage retains two ready, four empty and one attributed schema failure', () => {
  const asins=['B0FJ4T6V2C','B0F5NRLWB6','B0C6FP6LMY','B0FPXDD2D4','B0DQCF6ZVZ','B0DLB22T15','B0GHQW7GYY'];
  const [failed,,sampled,,,,zero]=asins;
  const emptyAsins=asins.filter(asin=>![failed,sampled,zero].includes(asin));
  const validEmpty=asin=>({asin,marketplace:'UK',status:'pending',terminalReason:'valid-empty',sampledReviews:0,mentionTopics:0,blocks:[],fetchedAt:'2026-10-21'});
  const ssRecords=Object.fromEntries(emptyAsins.map(asin=>[asin,validEmpty(asin)]));
  ssRecords[failed]={...validEmpty(failed),status:'error',terminalReason:undefined};
  ssRecords[sampled]={...validEmpty(sampled),status:'ready',sampledReviews:8,blocks:[{key:'positives',rows:[{label:'fun'}]}]};
  const sorftime=Object.fromEntries(asins.map(asin=>[asin,validEmpty(asin)]));
  sorftime[zero]={...validEmpty(zero),status:'ready'};
  const diagnostics=[{connector:'sellerSprite',stage:'reviews',asin:failed,failureKind:'schema',causeCode:'MCP_SCHEMA',operation:'review',boundary:'consumer-shape'}];
  const statuses=runner.sellerSpriteReviewResultStatuses(asins,ssRecords,'UK',diagnostics);
  const job={asins,marketplace:'UK',asinProgress:Object.fromEntries(asins.map(asin=>[asin,{reviews:{status:'pending'}}]))};
  let committed;
  runner.applyPersistedStagePostcondition('fixture','reviews',asins,{
    commandSucceeded:false,resultStatusesByAsin:statuses,diagnostics,
    readReadiness:()=>({items:asins.map(asin=>({asin,reviews:[sampled,zero].includes(asin)?'ready':'missing'})),missingAsins:asins.filter(asin=>![sampled,zero].includes(asin)),ready:false}),
    markModule:(_jobId,asin,stage,value)=>{job.asinProgress[asin][stage]=value;},readJob:()=>job,
    commitStage:(_jobId,input)=>{committed=input;},
    projectOutput:(stage,cohort,options)=>projectStageOutput(stage,cohort,{...options,ukSellerSpriteReviewFallback:true,
      readExport:(_file,name)=>name==='sorftimeReviewAnalysisData'?sorftime:name==='sellerSpriteMcpReviewAnalysisData'?ssRecords:
        name==='sorftimeRatingData'?{[zero]:{asin:zero,marketplace:'UK',status:'ready',reviewCount:0,fetchedAt:'2026-10-21'}}:{},
    }),
  });
  const final=Object.values(job.asinProgress).map(record=>record.reviews.status);
  assert.equal(final.filter(status=>status==='ready').length,2);
  assert.equal(final.filter(status=>status==='upstream-empty').length,4);
  assert.equal(final.filter(status=>status==='connector-failed').length,1);
  assert.equal(job.asinProgress[failed].reviews.status,'connector-failed');
  assert.deepEqual(committed.output.gap.items.find(item=>item.asin===failed),{asin:failed,causeCode:'MCP_SCHEMA',operation:'review',boundary:'consumer-shape'});
  assert.equal(committed.output.data.analysisByAsin[sampled].sampledReviews,8);
  assert.equal(committed.output.data.analysisByAsin[sampled].sourceProvider,'sellerSprite');
});
