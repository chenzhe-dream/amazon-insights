import assert from 'node:assert/strict';
import {openRuntimeAgentRepository} from '../../server/db/open-runtime-repository';
import {loadAgentStorageConfig} from '../../server/config';
import {preprocessVocSnapshot} from '../../server/domain/voc/preprocess-voc-snapshot';
assert.equal(new URL(process.env.AGENT_DATABASE_URL!).pathname,'/amazon_de_ca_formalbase_20261021');
assert.equal(process.env.AGENT_SERVICE_PORT,'33901');
const repository=await openRuntimeAgentRepository(loadAgentStorageConfig());
try {
 const run=await repository.findAnalysisRun('f4809527-9e3d-45ac-adda-a705008cfd06');assert.ok(run);
 const project=await repository.findProjectById(run.projectId);assert.ok(project);
 const snapshots=await repository.listDataSnapshotsByRun({actorOrganizationId:project.organizationId,runId:run.id});
 for(const snapshot of snapshots){
  try{const facts=preprocessVocSnapshot(snapshot);console.log(JSON.stringify({snapshotId:snapshot.id,selected:snapshot.asins.length,reviews:snapshot.payload.records.sorftimeReviewAnalysis.length,evidenceCount:facts.evidenceIndex.length,preflight:'pass'}));}
  catch(error){console.log(JSON.stringify({snapshotId:snapshot.id,error:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:null}));process.exitCode=1;}
 }
}finally{await repository.close();}
