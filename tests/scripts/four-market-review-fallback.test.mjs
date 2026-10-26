import assert from 'node:assert/strict';
import test from 'node:test';
import * as fallback from '../../scripts/lib/uk-review-fallback.mjs';
import { projectStageOutput } from '../../scripts/lib/sync-stage-output.mjs';
import { runSellerSpriteReviewAnalysis } from '../../scripts/build-sellersprite-review-analysis.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readAsinStatusSources, deriveAsinModuleStatus } from '../../scripts/lib/asin-data-status.mjs';
import { generatedAppDataPath } from '../../scripts/lib/generated-app-data-path.mjs';

const asin = 'B0C3Z8F66G';
const empty = marketplace => ({asin, marketplace, status:'pending', terminalReason:'valid-empty', sampledReviews:0, mentionTopics:0, fetchedAt:'2026-10-26', blocks:[]});
const ready = marketplace => ({asin, marketplace, status:'ready', sampledReviews:1, fetchedAt:'2026-10-26', blocks:[{key:'positives',rows:[{label:'Easy assembly',sharePct:100,metricKind:'review_sample_incidence',numerator:1,denominator:1,reason:'easy assembly'}]}]});

for (const marketplace of ['US','UK','DE','CA']) {
  test(`${marketplace}: persisted fallback participates in readiness only when enabled`, () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'review-fallback-'));
    const env={AGENT_FORMAL_WORKTREE_ROOT:process.cwd(),AGENT_DATA_ROOT:path.join(root,'data'),AGENT_RUNTIME_ROOT:path.join(root,'runtime'),
      AGENT_SYNC_MARKETPLACE:marketplace,AGENT_EXECUTION_ORGANIZATION_ID:'fixture-org',AGENT_SYNC_PROJECT_ID:'fixture-project',AGENT_SELLERSPRITE_REVIEW_FALLBACK:'1'};
    const write=(file,name,record)=>fs.writeFileSync(generatedAppDataPath(process.cwd(),file,env),`export const ${name} = ${JSON.stringify({[asin]:record})};`);
    write('sorftime-review-analysis-data.ts','sorftimeReviewAnalysisData',empty(marketplace));
    write('seller-sprite-mcp-review-analysis-data.ts','sellerSpriteMcpReviewAnalysisData',ready(marketplace));
    assert.equal(deriveAsinModuleStatus(asin,readAsinStatusSources(env)).reviews,'ready');
    assert.equal(deriveAsinModuleStatus(asin,readAsinStatusSources({...env,AGENT_SELLERSPRITE_REVIEW_FALLBACK:'0'})).reviews,'missing');
    write('seller-sprite-mcp-review-analysis-data.ts','sellerSpriteMcpReviewAnalysisData',ready('FR'));
    assert.equal(deriveAsinModuleStatus(asin,readAsinStatusSources(env)).reviews,'missing');
  });
  test(`${marketplace}: empty primary selects exact fallback and preserves provider in projection`, () => {
    assert.equal(typeof fallback.selectReviewFallbackAsins, 'function');
    assert.deepEqual(fallback.selectReviewFallbackAsins([asin],{[asin]:empty(marketplace)},{marketplace,enabled:true}),[asin]);
    const output = projectStageOutput('reviews',[asin],{marketplace,sellerSpriteReviewFallback:true,
      readExport:(_file,name)=>name==='sorftimeReviewAnalysisData'?{[asin]:empty(marketplace)}:name==='sellerSpriteMcpReviewAnalysisData'?{[asin]:ready(marketplace)}:{},
      updatedAt:'2026-10-26T06:00:00.000Z'});
    assert.equal(output.data.analysisByAsin[asin].sourceProvider,'sellerSprite');
    assert.equal(output.data.analysisByAsin[asin].sampledReviews,1);
    assert.equal(fallback.selectReviewEvidence(asin,marketplace,empty(marketplace),{...ready(marketplace),marketplace:'FR'}),null);
    assert.deepEqual(fallback.selectReviewEvidence(asin,marketplace,ready(marketplace),ready(marketplace)),ready(marketplace));
  });
  test(`${marketplace}: runtime fallback request and collector use the requested market`, async () => {
    assert.equal(typeof fallback.sellerSpriteReviewFallbackEnv,'function');
    const env=fallback.sellerSpriteReviewFallbackEnv([asin],marketplace);
    assert.equal(env.SELLERSPRITE_MARKETPLACE,marketplace);
    let requested;
    const records=await runSellerSpriteReviewAnalysis({env,key:'fixture',asins:[asin],existing:{},writeFileSync:()=>{},wait:async()=>{},
      fetchReviews:async(_key,site,id)=>{requested={site,id};return [{title:'Easy to assemble',content:'Easy to assemble and sturdy for my child.',star:5}];}});
    assert.deepEqual(requested,{site:marketplace,id:asin});
    assert.equal(records[asin].marketplace,marketplace);
    assert.equal(records[asin].sampledReviews,1);
  });
}

test('four-market switch keeps explicit off, legacy UK scope and unsupported markets isolated',()=>{
  assert.equal(typeof fallback.reviewFallbackEnabled,'function');
  for(const marketplace of ['US','UK','DE','CA']) {
    assert.equal(fallback.reviewFallbackEnabled(marketplace,{AGENT_SELLERSPRITE_REVIEW_FALLBACK:'1'}),true);
    assert.equal(fallback.reviewFallbackEnabled(marketplace,{AGENT_SELLERSPRITE_REVIEW_FALLBACK:'0',AGENT_UK_SELLERSPRITE_REVIEW_FALLBACK:'1'}),false);
    assert.equal(fallback.reviewFallbackEnabled(marketplace,{AGENT_UK_SELLERSPRITE_REVIEW_FALLBACK:'1'}),marketplace==='UK');
    for(const causeCode of ['CONNECT_TIMEOUT','HTTP_4XX','MCP_RPC','RESOURCE_GOVERNOR']) {
      assert.deepEqual(fallback.selectReviewFallbackAsins([asin],{[asin]:empty(marketplace)},{marketplace,enabled:true,attempts:[{succeeded:false,diagnostics:[{asin,causeCode,failureKind:'rpc'}]}]}),[]);
    }
  }
  assert.equal(fallback.reviewFallbackEnabled('FR',{AGENT_SELLERSPRITE_REVIEW_FALLBACK:'1'}),false);
  assert.deepEqual(fallback.selectReviewFallbackAsins([asin],{[asin]:empty('FR')},{marketplace:'FR',enabled:true}),[]);
});
