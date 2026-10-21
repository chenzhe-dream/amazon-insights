import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {openRuntimeAgentRepository} from '../../server/db/open-runtime-repository';
import {loadAgentStorageConfig} from '../../server/config';
import {AnalysisRunService} from '../../server/services/analysis-run-service';

assert.equal(new URL(process.env.AGENT_DATABASE_URL!).pathname,'/amazon_de_ca_formalbase_20261021');
assert.equal(process.env.AGENT_SERVICE_PORT,'33901');
const root=path.resolve(process.env.AGENT_RUNTIME_ROOT!,'..');
const identity=JSON.parse(fs.readFileSync(path.join(root,'qa-login.json'),'utf8'));
const file=path.join(root,'evidence','live-run-state.json');
const entries=JSON.parse(fs.readFileSync(file,'utf8'));
const repository=await openRuntimeAgentRepository(loadAgentStorageConfig());
try{
 const service=new AnalysisRunService({repository,executionContext:{actorId:identity.userId,organizationId:identity.organizationId}});
 for(const entry of entries){
  if(entry.analysisRunId||!entry.baseSyncRunId)continue;
  const inventory=await service.getVocInputs(entry.projectId,entry.baseSyncRunId,entry.asins);
  fs.writeFileSync(path.join(root,'evidence',`${entry.marketplace}-inventory-fixed.json`),JSON.stringify(inventory,null,2));
  const manifest=inventory.fallback;
  if(manifest.sourceMode!=='review-fallback'){
   console.log(JSON.stringify({marketplace:entry.marketplace,waiting:true,reason:'No published same-site review evidence yet'}));continue;
  }
  assert.equal(manifest.marketplace,entry.marketplace);
  assert.deepEqual([...manifest.selectedAsins].sort(),[...entry.asins].sort());
  const created=await service.createRun(entry.projectId,{mode:'existing-data',idempotencyKey:`de-ca-analysis:${entry.jobId}`,evidenceSelection:{baseSyncRunId:entry.baseSyncRunId,selectedAsins:entry.asins,sourcePolicy:'manual-with-review-fallback',expectedInputFingerprint:manifest.fingerprint}});
  entry.analysisRunId=created.run.id;
  entry.analysisCreationMethod='candidate AnalysisRunService';
  entry.publicHttpReplay='pending idle service refresh';
  fs.writeFileSync(file,JSON.stringify(entries,null,2));
  console.log(JSON.stringify({marketplace:entry.marketplace,runId:entry.analysisRunId,sourceMode:manifest.sourceMode,selectedAsins:manifest.selectedAsins,coverage:manifest.coverage.map(row=>({asin:row.asin,primary:row.primary,missingDimensions:row.missingDimensions})),queued:true}));
 }
}finally{await repository.close();}
