import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { PostgresQueryContext } from '../../../server/db/postgres/query-context';
import { PostgresMarketAnalysisSnapshotStore } from '../../../server/db/postgres/market-analysis-snapshot-store';
import { PostgresMarketModuleExecutionStore } from '../../../server/db/postgres/market-module-execution-store';
import { PostgresMarketAgentRunStore } from '../../../server/db/postgres/market-agent-run-store';
import { canonicalJsonSha256 } from '../../../server/runtime/model-request-accounting';
import type { MarketAnalysisScope } from '../../../shared/market-analysis-contracts';
import type { MarketExecutionSubject, MarketModelExecutionAuthority } from '../../../shared/market-execution-subject';
import type { BeginMarketAgentRunInput } from '../../../server/db/market-agent-run-repository';
import type { SkillManifest } from '../../../server/skills/manifest';

/** Synthetic data only; caller supplies an isolated, migrated PostgreSQL pool. */
export async function createMarketSemanticFixture(pool:Pool,options:{organizationId?:string; manifest?:SkillManifest; configurationVersion?:string}={}) {
  const context=new PostgresQueryContext(pool);
  const stores={snapshots:new PostgresMarketAnalysisSnapshotStore(pool),steps:new PostgresMarketModuleExecutionStore(context),audit:new PostgresMarketAgentRunStore(context)};
  const actor={organizationId:options.organizationId??randomUUID(),userId:randomUUID()};
  await pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Semantic fixture','member','active',clock_timestamp(),clock_timestamp())",[actor.userId,actor.organizationId,`${actor.userId}@example.com`]);
  const clock=(await pool.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;
  const cutoff=new Date(clock.getTime()-1_000).toISOString();
  const scope:MarketAnalysisScope={organizationId:actor.organizationId,researchId:randomUUID(),marketplace:'US',nodeIdPath:'12:34',fromMonth:'2026-07',toMonth:'2026-08',currency:'USD'};
  await stores.snapshots.createStudy({actor,scope,idempotencyKey:randomUUID(),now:clock.toISOString()});
  const source=await stores.snapshots.saveSource({actor,studyId:scope.researchId,now:clock.toISOString(),input:{scope,provider:'sorftime',operation:'keyword_extends',requestIdentity:{marketplace:'US',keyword:'fixture'},responseIdentityPaths:{},payload:{synthetic:true,keyword:'fixture'},fetchedAt:cutoff,observationPeriod:{kind:'unknown',reason:'Synthetic fixture window'},units:{},coverage:{receivedCount:1,expectedCount:1,truncation:{status:'unknown',reason:'Synthetic fixture'}}}});
  const task='market-keyword-semantics' as const;
  const catalog={dictionaryVersion:'fixture/v1',categoryContext:'Synthetic lamp category',dimensionLabels:{W1:[],W2:[],W3:[],W4:[]},clusterCatalog:[]};
  const keywords=[{keywordId:'keyword-a',text:{refId:'text-a',sourceRef:source.id,recordId:'keyword-a',field:'keyword',text:'fixture lamp'}}];
  const saved=await stores.snapshots.saveInput({actor,studyId:scope.researchId,now:clock.toISOString(),input:{scope,kind:'keywords',sourceVersion:'synthetic/v1',ruleVersion:'semantic/v1',collectedAt:cutoff,expectedRecordIds:['keyword-a'],records:[{id:'keyword-a',scope,data:{semantic:{task,...catalog,keyword:keywords[0]}}}]}});
  const {organizationId:_organizationId,...modelScope}=scope;
  const projectionWithoutDigest={schemaVersion:'1.0.0',task,batchId:randomUUID(),scopeDigest:canonicalJsonSha256(scope),scope:modelScope,contentSnapshotId:saved.snapshot.snapshotId,selectionRevision:'selection/v1',batchKey:'keywords/batch-1',dataCutoffAt:cutoff,sourceRefs:[source.id],...catalog,keywords};
  const inputDigest=canonicalJsonSha256(projectionWithoutDigest);
  const inputProjection={...projectionWithoutDigest,inputDigest};
  const bindingId=randomUUID();
  const prepare={stepKey:'prepare/model',kind:'prepare-model-batches' as const,subject:{task},input:{},inputRefs:[{kind:'input' as const,id:saved.snapshot.snapshotId}]};
  const created=await stores.steps.createModuleRun({actor,scope,moduleKind:'keywords',params:{},versions:{source:'synthetic/v1',rule:'semantic/v1',mapping:'mapping/v1',planner:'planner/v1',model:'market.semantic.text.v1',prompt:'prompt/v1',configuration:options.configurationVersion??'fixture/v1'},collectionRevision:randomUUID(),idempotencyKey:randomUUID(),initialSteps:[prepare]});
  const prepareClaim=await stores.steps.claimStep({moduleRunId:created.run.id,leaseOwnerId:randomUUID(),leaseMs:120_000}); assert.ok(prepareClaim);
  const toSubject=(claim:typeof prepareClaim):MarketExecutionSubject=>({kind:'market-module-run',organizationId:actor.organizationId,studyId:scope.researchId,moduleRunId:created.run.id,stepId:claim.stepId,attemptId:claim.attemptId,leaseOwnerId:claim.leaseOwnerId,leaseGeneration:claim.leaseGeneration,dataCutoffAt:cutoff});
  let binding:Awaited<ReturnType<typeof stores.audit.saveSnapshotBinding>>['binding'];
  await context.transaction(async()=>{
    binding=(await stores.audit.saveSnapshotBinding({id:bindingId,subject:toSubject(prepareClaim),inputSnapshotId:saved.snapshot.snapshotId,inputProjection,memberRefs:['keyword-a'],sourceRefs:[source.id],selectionRevision:'selection/v1',batchKey:'keywords/batch-1'})).binding;
    await stores.steps.settleAndEnqueue({claim:prepareClaim,outcome:{status:'succeeded',output:{bindingId}},children:[{stepKey:'model/keywords-1',kind:'model-batch',subject:{task},input:{task,bindingId,inputDigest},inputRefs:[{kind:'input',id:saved.snapshot.snapshotId}]}]});
  });
  const modelClaim=await stores.steps.claimStep({moduleRunId:created.run.id,leaseOwnerId:randomUUID(),leaseMs:120_000});assert.ok(modelClaim);
  const subject=toSubject(modelClaim);
  const manifest=options.manifest??{id:'market-classify-keyword-demand',version:'1.0.0',entry:'SKILL.md',allowedReferences:['references/contract.md'],inputSchema:'MarketKeywordSemanticsInput@1.0.0',outputSchema:'MarketKeywordSemanticsOutput@1.0.0',fixtures:['synthetic-fixture'],contentHash:'a'.repeat(64)};
  const skillVersion=await stores.audit.registerSkillVersion({id:randomUUID(),skillId:manifest.id,version:manifest.version,contentHash:manifest.contentHash,manifest,createdAt:clock.toISOString()});
  const beginInput:BeginMarketAgentRunInput={id:randomUUID(),subject,task,bindingId,skillVersionId:skillVersion.id,skill:{id:manifest.id,version:manifest.version,contentHash:manifest.contentHash},inputSchema:manifest.inputSchema,outputSchema:manifest.outputSchema,executionFingerprint:canonicalJsonSha256({bindingId,skill:manifest.contentHash}),outputSchemaDigest:'b'.repeat(64),provider:'synthetic',model:'market.semantic.text.v1',claimToken:randomUUID(),claimTtlMs:60_000};
  const begun=await stores.audit.beginAgentRun(beginInput);
  const authority:MarketModelExecutionAuthority={...subject,agentRunId:begun.record.id,claimToken:beginInput.claimToken};
  return {actor,scope,subject,authority,stores,record:begun.record,binding:binding!,beginInput,inputProjection,source,inputSnapshot:saved.snapshot,context,prepareClaim,modelClaim};
}
