import oldSkillManifests from "./helpers/pre-evidence-skill-manifests.json";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { test } from "node:test";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { AnalysisRunService } from "../../server/services/analysis-run-service";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import { preprocessVocSnapshot } from "../../server/domain/voc/preprocess-voc-snapshot";
import { createAgentService } from "../../server/agent-service";
import { validAmazonVocInsightOutput } from "./helpers/voc-positioning-fixture";
import { validProductOutput, runtimeEnv } from "./helpers/voc-evidence-runtime-fixture";
import type { ProductDefinitionInput } from "../../server/domain/product/product-definition-contracts";
import type { ModelProvider, StructuredGenerationRequest } from "../../server/runtime/model-provider";
const ASINS=["B08L7DD8L9","B07498JDX4","B0829MZFDP"];
for (const [marketplace, scenario] of [["US","missing"], ["US","fallback"], ["US","manual"], ["US","failure"], ["DE","fallback"], ["CA","fallback"]] as const) test(`fixed evidence full worker chain: ${marketplace} ${scenario}`,async t=>{
 const keywordsAvailable=scenario!=="missing", manual=scenario==="manual", fail=scenario==="failure";
 const repository=openSqliteAgentRepository({path:":memory:",busyTimeoutMs:5000});
 const organizationId = randomUUID(), actorId = randomUUID(), projectId = randomUUID(), baseSyncRunId = randomUUID(), now = "2026-09-10T00:00:00.000Z";
 await repository.createUser({ id: actorId, organizationId, email: `${actorId}@example.invalid`, displayName: "fixture", role: "member", status: "active", createdAt: now, updatedAt: now });
 await repository.createProject({ id: projectId, organizationId, name: "Fixture original", marketplace, asins: ASINS, createdBy: actorId, createdAt: now, updatedAt: now });
 await repository.createAnalysisRun({ id: baseSyncRunId, projectId, createdBy: actorId, mode: "existing-data", status: "succeeded", dataCutoffAt: now, idempotencyScope: `sync:${organizationId}:${projectId}`, idempotencyKey: "job", createdAt: now, updatedAt: now });
 const data = { analysisByAsin: { [ASINS[0]]: { asin: ASINS[0], marketplace, status: "ready", fetchedAt: "2026-09-09", sampledReviews: 2, blocks: [{ key: "negatives", label: "问题", rows: [{ label: "结构断裂", reason: "支架断裂", sharePct: 50 }] }] } }, ratingByAsin: {} };
 const output = { projectId, runId: baseSyncRunId, jobId: "job", jobVersion: 1, outputVersion: 1, stage: "reviews", stageStatus: "done", updatedAt: "2026-09-09T23:59:59.999Z", data, contentHash: canonicalJsonSha256({ stage: "reviews", data }) };
 const keywordData = { analysisByAsin: { [ASINS[0]]: { asin: ASINS[0], marketplace, status: "ready", fetchedAt: "2026-09-09", keywords: [{ keyword: "reading light", searchVolume: 123 }] } }, enrichmentByKeyword: {} };
 const keywordOutput = { ...output, stage: "keywords", data: keywordData, contentHash: canonicalJsonSha256({ stage: "keywords", data: keywordData }) };
 const syncJobs = { findById: async () => ({ jobId: "job", organizationId, projectId, runId: baseSyncRunId, marketplace, asins: ASINS }), readStageOutput: async ({ stage }: { stage: string }) => stage === "reviews" ? output : keywordsAvailable ? keywordOutput : null };
 const manualRecord={asin:ASINS[0],captureStatus:"dialog",alexaReport:{asin:ASINS[0],title:"Fixture",rating:4,reviewCount:99,prompt:"Fixture",overallConclusion:"Fixture"},attention:[],positives:[],negatives:["结构断裂"],unmet:[],audiences:[],scenarios:[],motives:[]};
 if(manual) await repository.transaction(async baseTransaction=>{
  const transaction=baseTransaction as typeof repository;
  await transaction.manualAlexaVoc.lockScopes({organizationId,marketplace:"US",asins:[ASINS[0]]});
  const expectedRevision=await transaction.manualAlexaVoc.peekNextRevision({organizationId,marketplace:"US",asin:ASINS[0]});
  await transaction.manualAlexaVoc.put({organizationId,marketplace:"US",asin:ASINS[0],createdBy:actorId,expectedRevision,normalizedRecord:manualRecord as never,normalizedSchemaVersion:"alexa-voc-record/v2",parserVersion:"deterministic-alexa-parser/v3",contentHash:canonicalJsonSha256(manualRecord),raw:{algVersion:"AES-256-GCM/v1",keyId:"fixture",wrappedDek:randomBytes(60),nonce:randomBytes(12),ciphertext:randomBytes(48),tag:randomBytes(16),aadSha256:"a".repeat(64),plaintextBytes:48,plaintextSha256:"b".repeat(64)}});
 });
 const wrap = (repo: typeof repository): typeof repository => new Proxy(repo, { get(target, key) {

   if (key === "syncJobs") return syncJobs;
   if (key === "transaction") return (fn: (r: unknown) => Promise<unknown>) => target.transaction((transaction) => fn(wrap(transaction as typeof repository)));
   const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
 } });
 const wrapped = wrap(repository);
 const service = new AnalysisRunService({ repository: wrapped, executionContext: { actorId, organizationId } });

 const inventory=await service.getVocInputs(projectId,baseSyncRunId,[ASINS[0]]);
 const selectedManifest=manual?inventory.manual:inventory.fallback;
 const created=await service.createRun(projectId,{mode:"existing-data",idempotencyKey:"chain",evidenceSelection:{baseSyncRunId,selectedAsins:[ASINS[0]],sourcePolicy:selectedManifest.sourcePolicy,expectedInputFingerprint:selectedManifest.fingerprint}});
 const snapshots=await repository.listDataSnapshotsByRun({actorOrganizationId:organizationId,runId:created.run.id});
 const facts=preprocessVocSnapshot(snapshots[0]);let vocCalls=0,productCalls=0;
 const provider:ModelProvider={async generateStructured<T>(request:StructuredGenerationRequest<T>){
  const input=request.input as {kind:string};let value:unknown;
  if(input.kind==="voc-positioning-input"){vocCalls++;value=validAmazonVocInsightOutput(facts);}
  else { assert.equal(input.kind,"amazon-product-definition-input");productCalls++;if(fail)return {value:{} as T,responseId:"fixture-invalid",inputTokens:100,outputTokens:50};const productInput=request.input as ProductDefinitionInput;assert.deepEqual(productInput.asins,[ASINS[0]]);assert.equal(productInput.evidenceSelection?.fingerprint,selectedManifest.fingerprint);value={...validProductOutput(productInput),opportunity:{grade:"B",scope:"demand-and-product-definition-opportunity",projectApproval:"not-approved"}};}
  return {value:value as T,responseId:"fixture-only",inputTokens:100,outputTokens:50};
 }};
 for(const manifest of oldSkillManifests) await repository.registerSkillVersion({id:randomUUID(),skillId:manifest.id,version:manifest.version,contentHash:manifest.contentHash,manifest,createdAt:now});
 const runtime=await createAgentService({repository:wrapped as never,provider,providerName:"evidence-fixture",env:runtimeEnv(":memory:")});
 t.after(async()=>{await runtime.stop();repository.close();});
 await runtime.start({host:"127.0.0.1",port:0});
 const deadline=Date.now()+6000;let state=await service.getRun(created.run.id);
 while(Date.now()<deadline){state=await service.getRun(created.run.id);if(state.stages.find(s=>s.stage==="voc-positioning")?.status==="succeeded" && (!keywordsAvailable || state.stages.find(s=>s.stage==="product-definition")?.status===(fail?"failed":"succeeded")))break;await new Promise(r=>setTimeout(r,25));}
 assert.equal(state.stages.find(s=>s.stage==="voc-positioning")?.status,"succeeded",JSON.stringify(state));
 assert.equal(vocCalls,1);if(fail)assert.ok(productCalls>=1);else assert.equal(productCalls,keywordsAvailable?1:0);
 const { reports }=await service.listReports(created.run.id);
 assert.equal(reports.filter(r=>r.stage==="product-definition").length,keywordsAvailable&&!fail?1:0);
 assert.equal(state.evidenceSelection?.sourceMode,manual?"manual":"review-fallback");
 if(keywordsAvailable&&!fail){const product=reports.find(r=>r.stage==="product-definition")!;assert.equal((product.result as ProductDefinitionInput).evidenceSelection?.fingerprint,selectedManifest.fingerprint);}
 else assert.equal(state.stages.find(s=>s.stage==="product-definition")?.status,fail?"failed":"waiting-input");
 assert.ok(reports.some(report=>report.stage==="voc-positioning"));
 assert.equal(state.stages.some(stage=>stage.stage==="traffic-analysis"),false);
});
