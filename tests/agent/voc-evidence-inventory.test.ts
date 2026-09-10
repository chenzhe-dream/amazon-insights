import assert from "node:assert/strict";
import { test } from "node:test";
import { buildVocEvidenceInventory } from "../../server/services/voc-evidence-inventory-service";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
const org = "22222222-2222-4222-8222-222222222222", projectId = "11111111-1111-4111-8111-111111111111", runId = "33333333-3333-4333-8333-333333333333";
const asin = "B08L7DD8L9", now = "2026-09-10T00:00:00.000Z";
const data = { analysisByAsin: { [asin]: { asin, marketplace: "US", status: "ready", fetchedAt: "2026-09-09", sampledReviews: 2, blocks: [{ key: "positives", label: "喜爱", rows: [{ label: "明亮", reason: "适合阅读", sharePct: 50 }] }] } }, ratingByAsin: {} };
const output = { projectId, runId, jobId: "job", jobVersion: 1, outputVersion: 1, stage: "reviews", stageStatus: "done", updatedAt: "2026-09-09T23:59:59.999Z", data, contentHash: canonicalJsonSha256({ stage: "reviews", data }) };
function fixture(projection: unknown = output) {
 return { manualAlexaVoc: { listAtCutoff: async () => [] }, findAnalysisRun: async () => ({ id: runId, projectId, idempotencyKey: "job", idempotencyScope: `sync:${org}:${projectId}` }), syncJobs: { findById: async () => ({ jobId: "job", organizationId: org, projectId, runId, marketplace: "US", asins: [asin] }), readStageOutput: async ({ stage }: { stage: string }) => stage === "reviews" ? projection : null } };
}
const project = { id: projectId, organizationId: org, marketplace: "US", asins: [asin] };
test("inventory is scoped, separates manual and explicit fallback, preserves keyword gap", async () => {
 const result = await buildVocEvidenceInventory({ repository: fixture() as never, project: project as never, baseSyncRunId: runId, selectedAsins: [asin], dataCutoffAt: now });
 assert.equal(result.manualCandidate, null);
 assert.equal(result.fallbackCandidate?.payload.records.sorftimeReviewAnalysis.length, 1);
 assert.equal(result.inventory.fallback.coverage[0].primary, "review");
 assert.equal(result.inventory.fallback.keywords.state, "missing");
 assert.notEqual(result.inventory.manual.fingerprint, result.inventory.fallback.fingerprint);
});
test("correct project with forged stage content hash is rejected", async () => {
 await assert.rejects(buildVocEvidenceInventory({ repository: fixture({ ...output, contentHash: "a".repeat(64) }) as never, project: project as never, baseSyncRunId: runId, selectedAsins: [asin], dataCutoffAt: now }));
});
test("out of project ASIN is rejected", async () => {
 await assert.rejects(buildVocEvidenceInventory({ repository: fixture() as never, project: project as never, baseSyncRunId: runId, selectedAsins: ["B07498JDX4"], dataCutoffAt: now }));
});

for (const [status, expected] of [["error", "failed"], ["empty", "empty"]] as const) test(`keyword record ${status} remains ${expected}`, async () => {
 const repo=fixture(); const keywordData={analysisByAsin:{[asin]:{asin,marketplace:"US",status,fetchedAt:"2026-09-09",keywords:[]}},enrichmentByKeyword:{}};
 const keywordOutput={...output,stage:"keywords",data:keywordData,contentHash:canonicalJsonSha256({stage:"keywords",data:keywordData})};
 repo.syncJobs.readStageOutput=async ({stage})=>(stage==="keywords"?keywordOutput:output) as never;
 const result=await buildVocEvidenceInventory({repository:repo as never,project:project as never,baseSyncRunId:runId,selectedAsins:[asin],dataCutoffAt:now});
 assert.equal(result.inventory.manual.keywords.state,expected);
});

test("one of three manual ASINs remains primary; overlap preserves independent evidence and gaps", async () => {
 const asins=[asin,"B07498JDX4","B0829MZFDP"];
 const normalizedRecord={asin,captureStatus:"dialog",alexaReport:{asin,title:"Fixture",rating:4,reviewCount:99,prompt:"Fixture",overallConclusion:"Fixture"},attention:[],positives:["手工：适合阅读"],negatives:[],unmet:[],audiences:[],scenarios:[],motives:[]};
 const repo=fixture();repo.syncJobs.findById=async()=>({jobId:"job",organizationId:org,projectId,runId,marketplace:"US",asins});
 repo.manualAlexaVoc.listAtCutoff=async()=>[{organizationId:org,marketplace:"US",asin,revision:"1",contentHash:canonicalJsonSha256(normalizedRecord),capturedAt:"2026-09-09T00:00:00.000Z",normalizedSchemaVersion:"alexa-voc-record/v2",parserVersion:"deterministic-alexa-parser/v3",normalizedRecord}] as never;
 const result=await buildVocEvidenceInventory({repository:repo as never,project:{...project,asins} as never,baseSyncRunId:runId,selectedAsins:asins,dataCutoffAt:now});
 assert.deepEqual(result.inventory.manual.coverage.map(c=>c.primary),["missing","missing","manual"]);
 const row=result.inventory.fallback.coverage.find(c=>c.asin===asin)!;assert.equal(row.primary,"manual");assert.deepEqual(row.conflictDimensions,["positives"]);
 const {preprocessVocSnapshot}=await import("../../server/domain/voc/preprocess-voc-snapshot");
 const candidate=result.fallbackCandidate!;const facts=preprocessVocSnapshot({...candidate,id:projectId,runId,createdAt:now});
 assert.equal(facts.availability.find(a=>a.sourceId==="alexa-voc")?.targetCount,3);
 assert.equal(facts.availability.find(a=>a.sourceId==="alexa-voc")?.denominators[0].sampleCount,99);
 assert.equal(facts.availability.find(a=>a.sourceId==="sorftime-review-analysis")?.denominators[0].sampleCount,2);
 assert.ok(facts.evidenceIndex.some(e=>e.rawLabel.includes("手工")));assert.ok(facts.evidenceIndex.some(e=>e.rawLabel==="明亮"));
 assert.equal(facts.evidenceSelection?.coverage.find(c=>c.asin===asin)?.primary,"manual");
});
for (const patch of [{projectId:"99999999-9999-4999-8999-999999999999"},{outputVersion:2},{updatedAt:"2026-09-11T00:00:00.000Z"}]) test(`invalid stage provenance ${JSON.stringify(patch)}`,async()=>{
 await assert.rejects(buildVocEvidenceInventory({repository:fixture({...output,...patch}) as never,project:project as never,baseSyncRunId:runId,selectedAsins:[asin],dataCutoffAt:now}));
});

test("snapshot rejects a changed manifest fingerprint even with valid source records",async()=>{
 const result=await buildVocEvidenceInventory({repository:fixture() as never,project:project as never,baseSyncRunId:runId,selectedAsins:[asin],dataCutoffAt:now});
 const {VocSnapshotPayloadSchema}=await import("../../server/data/voc-data-snapshot");
 const payload=structuredClone(result.fallbackCandidate!.payload);payload.evidenceSelection!.fingerprint="a".repeat(64);
 assert.equal(VocSnapshotPayloadSchema.safeParse(payload).success,false);
});
