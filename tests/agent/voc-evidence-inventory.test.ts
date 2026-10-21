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
 assert.equal(result.inventory.fallback.coverage[0].review?.id, `repository://sync/${runId}/reviews/job`);
 assert.equal(result.inventory.fallback.keywords.state, "missing");
 assert.notEqual(result.inventory.manual.fingerprint, result.inventory.fallback.fingerprint);
});
test("UK SellerSprite review fallback freezes its own source and coverage provenance", async () => {
 const marketData = structuredClone(data);
 marketData.analysisByAsin[asin].marketplace = "UK";
 (marketData.analysisByAsin[asin] as Record<string, unknown>).sourceProvider = "sellerSprite";
 const projection = { ...output, data: marketData, contentHash: canonicalJsonSha256({stage:"reviews", data:marketData}) };
 const repo = fixture(projection);repo.syncJobs.findById=async()=>({jobId:"job",organizationId:org,projectId,runId,marketplace:"UK",asins:[asin]});
 const result = await buildVocEvidenceInventory({repository:repo as never,project:{...project,marketplace:"UK"} as never,baseSyncRunId:runId,selectedAsins:[asin],dataCutoffAt:now});
 assert.equal(result.fallbackCandidate?.payload.records.sorftimeReviewAnalysis.length,0);
 assert.equal(result.fallbackCandidate?.payload.records.sellerSpriteReviewAnalysis.length,1);
 assert.match(result.inventory.fallback.coverage[0].review?.id ?? "",/sellerSprite/);
});
test("historical keyword schema failure is failed in frozen inventory despite current valid empty", async () => {
 const window = { time_type: "lately", time_value: "30", listingSearch: true };
 const keywordData = { analysisByAsin: { [asin]: { asin, marketplace: "UK", fetchedAt: "2026-09-09", status: "empty", terminalReason: "valid-empty", queryWindow: window, keywords: [],
  historicalAttempt: { queryWindow: { time_type: "month", time_value: "2026-08-01", listingSearch: true }, outcome: "schema-error", errorCode: "SIF_KEYWORD_SCHEMA_INVALID" } } }, enrichmentByKeyword: {} };
 const keywordOutput = { ...output, stage: "keywords", data: keywordData, contentHash: canonicalJsonSha256({ stage: "keywords", data: keywordData }) };
 const repo=fixture();repo.syncJobs.findById=async()=>({jobId:"job",organizationId:org,projectId,runId,marketplace:"UK",asins:[asin]});
 repo.syncJobs.readStageOutput=async({stage})=>stage==="keywords"?keywordOutput as never:null;
 const result=await buildVocEvidenceInventory({repository:repo as never,project:{...project,marketplace:"UK"} as never,baseSyncRunId:runId,selectedAsins:[asin],dataCutoffAt:now});
 assert.equal(result.inventory.fallback.keywords.state,"failed");
 assert.equal(result.keywordCandidate,null);
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

test("UK historical keyword snapshot freezes period, current empty and seven-ASIN partial coverage", async () => {
 const asins=["B0FJ4T6V2C","B0F5NRLWB6","B0C6FP6LMY","B0FPXDD2D4","B0DQCF6ZVZ","B0DLB22T15","B0GHQW7GYY"];
 const currentWindow={time_type:"lately",time_value:"30",listingSearch:true};
 const historicalWindow={time_type:"month",time_value:"2026-09-01",listingSearch:true};
 const keywordData={analysisByAsin:Object.fromEntries(asins.map(item=>[item,{asin:item,marketplace:"UK",fetchedAt:"2026-10-21",
  status:item===asins[2]?"ready":"empty",...(item===asins[2]?{}:{terminalReason:"valid-empty"}),
  queryWindow:item===asins[2]?historicalWindow:currentWindow,
  ...(item===asins[2]?{currentEmpty:{queryWindow:currentWindow,observedAt:"2026-10-21",terminalReason:"valid-empty"}}:{}),
  keywords:item===asins[2]?[{keyword:"steel tip darts",searchVolume:120}]:[]}])) ,enrichmentByKeyword:{}};
 const stageTime="2026-10-21T08:00:00.000Z";
 const keywordOutput={...output,stage:"keywords",stageStatus:"partial",updatedAt:stageTime,data:keywordData,
  gap:{state:"partial",reasonCode:"UPSTREAM_EMPTY",items:asins.filter(item=>item!==asins[2]).map(asin=>({asin,causeCode:"UPSTREAM_EMPTY"}))},
  contentHash:canonicalJsonSha256({stage:"keywords",data:keywordData,gap:{state:"partial",reasonCode:"UPSTREAM_EMPTY",items:asins.filter(item=>item!==asins[2]).map(asin=>({asin,causeCode:"UPSTREAM_EMPTY"}))}})};
 const repo=fixture();repo.syncJobs.findById=async()=>({jobId:"job",organizationId:org,projectId,runId,marketplace:"UK",asins});
 repo.syncJobs.readStageOutput=async({stage})=>stage==="keywords"?keywordOutput as never:null;
 const result=await buildVocEvidenceInventory({repository:repo as never,project:{...project,marketplace:"UK",asins} as never,
  baseSyncRunId:runId,selectedAsins:asins,dataCutoffAt:"2026-10-21T09:00:00.000Z"});
 assert.equal(result.inventory.fallback.keywords.state,"ready");
 assert.deepEqual(result.keywordCandidate?.asins,[...asins].sort());
 assert.equal(result.keywordCandidate?.payload.coverage?.length,7);
 assert.equal(result.keywordCandidate?.payload.coverage?.filter(row=>row.status==="empty").length,6);
 assert.deepEqual(result.keywordCandidate?.payload.evidence[0].queryWindow,historicalWindow);
 assert.deepEqual(result.keywordCandidate?.payload.evidence[0].currentEmpty?.queryWindow,currentWindow);
 assert.equal(result.keywordCandidate?.payload.evidence[0].searchVolume,120);
 const stale=structuredClone(keywordData);stale.analysisByAsin[asins[2]].queryWindow.time_value="2026-08-01";
 const staleOutput={...keywordOutput,data:stale,contentHash:canonicalJsonSha256({stage:"keywords",data:stale,gap:keywordOutput.gap})};
 repo.syncJobs.readStageOutput=async({stage})=>stage==="keywords"?staleOutput as never:null;
 const rejected=await buildVocEvidenceInventory({repository:repo as never,project:{...project,marketplace:"UK",asins} as never,
  baseSyncRunId:runId,selectedAsins:asins,dataCutoffAt:"2026-10-21T09:00:00.000Z"});
 assert.equal(rejected.inventory.fallback.keywords.state,"failed");
 assert.equal(rejected.keywordCandidate,null);
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
for (const marketplace of ["UK", "DE", "CA"] as const) test(`${marketplace} fallback freezes same-site evidence without manual vault access`, async () => {
 const marketData = structuredClone(data); marketData.analysisByAsin[asin].marketplace = marketplace;
 const projection = {...output, data: marketData, contentHash: canonicalJsonSha256({stage:"reviews", data:marketData})};
 const repo = fixture(projection);
 repo.syncJobs.findById = async () => ({jobId:"job",organizationId:org,projectId,runId,marketplace,asins:[asin]});
 repo.manualAlexaVoc.listAtCutoff = async () => { throw Error("non-US manual access"); };
 const result = await buildVocEvidenceInventory({repository:repo as never,project:{...project,marketplace} as never,baseSyncRunId:runId,selectedAsins:[asin],dataCutoffAt:now});
 assert.equal(result.manualCandidate,null);
 assert.equal(result.fallbackCandidate?.marketplace,marketplace);
 assert.equal(result.inventory.fallback.sourceMode,"review-fallback");
 assert.equal(result.inventory.fallback.coverage[0].manual,null);
 assert.equal(result.inventory.fallback.coverage[0].review?.contentHash,projection.contentHash);
 assert.equal(result.fallbackCandidate?.payload.records.sorftimeReviewAnalysis[0].marketplace,marketplace);
});
for (const marketplace of ["UK", "DE", "CA"] as const) test(`${marketplace} rejects US review cache as available evidence`, async () => {
 const repo=fixture(); repo.syncJobs.findById=async()=>({jobId:"job",organizationId:org,projectId,runId,marketplace,asins:[asin]});
 const result=await buildVocEvidenceInventory({repository:repo as never,project:{...project,marketplace} as never,baseSyncRunId:runId,selectedAsins:[asin],dataCutoffAt:now});
 assert.equal(result.fallbackCandidate,null);
 assert.equal(result.inventory.fallback.coverage[0].primary,"missing");
});
test("same-day persisted Customers Say evidence uses verified publication time, preserving missing cohort", async () => {
 const stageTime="2026-10-21T03:00:00.000Z", cutoff="2026-10-21T04:00:00.000Z";
 const missingAsin="B07498JDX4";
 const reviewData={analysisByAsin:{[asin]:{asin,marketplace:"DE",sampledReviews:0,mentionTopics:2,fetchedAt:"2026-10-21",status:"ready",family:"generic",blocks:[{key:"positives",label:"好评点",rows:[{label:"Qualität",sharePct:58.33,metricKind:"customers_say_topic_share",numerator:7,denominator:12,reason:""},{label:"Aufbau",sharePct:41.67,metricKind:"customers_say_topic_share",numerator:5,denominator:12,reason:""}]}]}},ratingByAsin:{}};
 const projection={...output,updatedAt:stageTime,data:reviewData,contentHash:canonicalJsonSha256({stage:"reviews",data:reviewData})};
 const repo=fixture(projection);repo.syncJobs.findById=async()=>({jobId:"job",organizationId:org,projectId,runId,marketplace:"DE",asins:[asin,missingAsin]});
 const result=await buildVocEvidenceInventory({repository:repo as never,project:{...project,marketplace:"DE",asins:[asin,missingAsin]} as never,baseSyncRunId:runId,selectedAsins:[asin,missingAsin],dataCutoffAt:cutoff});
 assert.equal(result.inventory.fallback.sourceMode,"review-fallback");
 assert.equal(result.fallbackCandidate?.sources[0].capturedAt,stageTime);
 assert.equal(result.inventory.fallback.coverage.find(row=>row.asin===missingAsin)?.primary,"missing");
 assert.equal(result.fallbackCandidate?.payload.records.sorftimeReviewAnalysis[0].sampledReviews,0);
 const {preprocessVocSnapshot}=await import("../../server/domain/voc/preprocess-voc-snapshot");
 const facts=preprocessVocSnapshot({...result.fallbackCandidate!,id:projectId,runId,createdAt:cutoff});
 assert.ok(facts.evidenceIndex.length>0);
 assert.ok(facts.evidenceIndex.every(row=>row.capturedAt===stageTime));
});
test("trusted publication preserves cached dates but never admits a future record or weakens static cutoff", async () => {
 const {RepositoryVocSourceReader}=await import("../../server/data/repository-voc-source");
 const stageTime="2026-10-21T03:00:00.000Z", cutoff="2026-10-21T04:00:00.000Z";
 const read=async(fetchedAt:string,publishedAt?:string)=>new RepositoryVocSourceReader({manualVoc:{listAtCutoff:async()=>[]},legacyFallbackEnabled:false,reviewSources:{sorftime:{meta:{marketplace:"DE"},...(publishedAt?{publishedAt}:{}),data:{[asin]:{...data.analysisByAsin[asin],marketplace:"DE",fetchedAt}}},sellerSprite:{meta:{marketplace:"DE"},data:{}}}}).read({organizationId:org,marketplace:"DE",asins:[asin],dataCutoffAt:cutoff,sourcePolicy:"manual-with-review-fallback"});
 assert.equal((await read("2026-10-21")).candidate,null);
 assert.equal((await read("2026-10-22",stageTime)).candidate,null);
 assert.equal((await read("2026-10-20","2026-10-21T05:00:00.000Z")).candidate,null);
 const cached=await read("2026-10-20",stageTime);
 assert.equal(cached.candidate?.payload.records.sorftimeReviewAnalysis[0].fetchedAt,"2026-10-20");
 assert.equal(cached.candidate?.sources[0].capturedAt,stageTime);
});
