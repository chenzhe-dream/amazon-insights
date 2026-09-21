import assert from "node:assert/strict";
import test from "node:test";
import { SyncJobService } from "../../server/services/sync-job-service";
import type { SyncJobRepository, SyncJobRecord } from "../../server/db/sync-job-repository";
import { LocalDataSyncStartRequestSchema, LocalDataSyncStartResponseSchema } from "../../shared/agent-contracts";

const asins = ["B000000001", "B000000002"];
const input = { organizationId: "org", projectId: "project", actorId: "actor", marketplace: "US", asins, mode: "repair-incomplete" as const, parentJobId: "parent" };
function fixture(missing = true, parentPatch = {}, xydcAsins: string[] = [], activeJob?: SyncJobRecord) {
  const parent = { jobId: "parent", organizationId: "org", projectId: "project", runId: "old-run", marketplace: "US", asins, status: "failed", stages: [], asinProgress: {}, ...parentPatch } as unknown as SyncJobRecord;
  const admissions: any[] = [];
  const statuses = asins.map((asin, index) => ({ asin, inCatalog: true, keywords: missing && index === 0 ? "missing" : "ready", reviews: "ready", sales: "ready", childSales: "ready", priceStrategy: "ready", fba: "ready", listing: "ready", imageRemarks: "ready", category: "ready", traffic: "ready", voc: "missing" })) as any;
  const repository = { findById: async () => parent, admit: async (data: any) => { admissions.push(data); return { disposition: activeJob || admissions.length > 1 ? "deduplicated" : "created", job: activeJob ?? { ...data, status: "queued", updatedAt: data.createdAt, asinProgress: {} } }; } } as unknown as SyncJobRepository;
  const service = new SyncJobService(repository, { findXydcRepairAsins: async () => xydcAsins, bypassProviderReadiness: true, loadStatusModule: async () => ({ getAsinDataStatus: () => statuses, asinsNeedingMcpSync: () => statuses.filter((s: any) => s.keywords === "missing"), asinsNeedingCatalogSync: () => [], asinsNeedingListingSync: () => [], asinsNeedingTrafficSync: () => [], asinsNeedingImageRemarksSync: () => [], countPendingImageRemarks: () => 0, estimateAutoSyncSeconds: () => 10, estimateAlexaVocSeconds: () => 20 }) });
  return { service, admissions };
}
test("repair only targets current incomplete cells and creates a fresh canonical run", async () => {
  const { service, admissions } = fixture();
  await service.start(input);
  const admitted = admissions[0];
  assert.notEqual(admitted.runId, "old-run");
  assert.ok(admitted.canonicalRun);
  assert.deepEqual(admitted.stages.find((s: any) => s.id === "keywords").repairAsins, [asins[0]]);
  for (const stage of admitted.stages.filter((s: any) => s.kind === "auto" && !["queue", "build"].includes(s.id))) {
    assert.equal(stage.repairParentJobId, "parent");
    if (stage.id !== "keywords") assert.deepEqual(stage.repairAsins, []);
  }
  assert.equal(admitted.stages.find((s: any) => s.id === "alexa_voc").repairAsins, undefined);
});
test("manual VOC alone returns no work without admission", async () => {
  const { service, admissions } = fixture(false);
  assert.deepEqual(await service.start(input), { noWork: true, message: "暂无待补抓数据" });
  assert.equal(admissions.length, 0);
});
test("missing Xiyou order months alone admit only the order repair target", async () => {
  const { service, admissions } = fixture(false, {}, [asins[1]]);
  await service.start(input);
  assert.deepEqual(admissions[0].stages.find((s: any) => s.id === "catalog").repairXydcAsins, [asins[1]]);
  assert.ok(admissions[0].stages.filter((s: any) => s.repairAsins).every((s: any) => s.repairAsins.length === 0));
});
test("repair preserves the normal fingerprint so active equivalent admission deduplicates", async () => {
  const { service, admissions } = fixture();
  await service.start({ ...input, mode: undefined, parentJobId: undefined });
  const result = await service.start({ ...input, asins: [...asins].reverse() });
  assert.equal(admissions[0].fingerprint, admissions[1].fingerprint);
  assert.ok("job" in result && result.reused);
});
test("repair rejects every parent scope mismatch before admission", async () => {
  for (const patch of [{ organizationId: "other" }, { projectId: "other" }, { marketplace: "UK" }, { asins: [asins[0]] }]) {
    const { service, admissions } = fixture(true, patch);
    await assert.rejects(service.start(input), /parent|scope/i);
    assert.equal(admissions.length, 0);
  }
});
test("active equivalent parent is reused without new admission", async () => {
  const { service, admissions } = fixture(true, { status: "running" });
  const result = await service.start(input);
  assert.ok("job" in result && result.reused && result.job.jobId === "parent");
  assert.equal(admissions.length, 0);
});
test("repair contract requires parent and project and rejects old run reuse", () => {
  const body = { asins, mode: "repair-incomplete", parentJobId: "parent", projectId: "10000000-0000-4000-8000-000000000001" };
  assert.equal(LocalDataSyncStartRequestSchema.safeParse(body).success, true);
  for (const bad of [{ ...body, parentJobId: undefined }, { ...body, projectId: undefined }, { ...body, runId: "old" }]) assert.equal(LocalDataSyncStartRequestSchema.safeParse(bad).success, false);
  assert.equal(LocalDataSyncStartResponseSchema.safeParse({ noWork: true, message: "暂无待补抓数据" }).success, true);
});

test("image refresh targets one ASIN even when ready and excludes unrelated gaps", async () => {
  const { service, admissions } = fixture(true);
  await service.start({ ...input, imageAction: { asin: asins[1], action: "refresh" } } as any);
  const stages=admissions[0].stages;
  for(const stage of stages.filter((s:any)=>Array.isArray(s.repairAsins))) {
    assert.deepEqual(stage.repairAsins, ["listing","image_remarks"].includes(stage.id)?[asins[1]]:[]);
  }
  assert.equal(stages.find((s:any)=>s.id==="listing").imageAction,"refresh");
  assert.deepEqual(stages.find((s:any)=>s.id==="catalog").repairXydcAsins,[]);
});
test("image analysis retry does not request the gallery and rejects alien targets",async()=>{
  const {service,admissions}=fixture(false);
  await service.start({...input,imageAction:{asin:asins[0],action:"analyze"}} as any);
  assert.deepEqual(admissions[0].stages.find((s:any)=>s.id==="listing").repairAsins,[]);
  assert.deepEqual(admissions[0].stages.find((s:any)=>s.id==="image_remarks").repairAsins,[asins[0]]);
  await assert.rejects(service.start({...input,imageAction:{asin:"B999999999",action:"refresh"}} as any),/target|scope/i);
});
test("image action contract requires repair mode and an in-scope single ASIN",()=>{
  const body={asins,projectId:"10000000-0000-4000-8000-000000000001",parentJobId:"parent",mode:"repair-incomplete",imageAction:{asin:asins[0],action:"refresh"}};
  assert.equal(LocalDataSyncStartRequestSchema.safeParse(body).success,true);
  for(const bad of [{...body,mode:undefined},{...body,imageAction:{asin:"B999999999",action:"refresh"}},{...body,imageAction:{asin:asins[0],action:"all"}}])assert.equal(LocalDataSyncStartRequestSchema.safeParse(bad).success,false);
});

function imageJob(action: "refresh" | "analyze", asin: string): SyncJobRecord {
  return {jobId:"active",organizationId:"org",projectId:"project",marketplace:"US",asins,status:"running",stages:[{id:"image_remarks",imageAction:action,repairAsins:[asin]}],asinProgress:{}} as unknown as SyncJobRecord;
}
test("different image targets or actions cannot silently reuse an active project job",async()=>{
  const active=imageJob("refresh",asins[0]);
  for(const imageAction of [{asin:asins[1],action:"refresh"},{asin:asins[0],action:"analyze"}]){
    const {service}=fixture(false,{},[],active);
    await assert.rejects(service.start({...input,imageAction} as any),/正在执行/);
  }
  const {service}=fixture(false,{},[],active);
  const result=await service.start({...input,imageAction:{asin:asins[0],action:"refresh"}});
  assert.ok("job" in result && result.reused && result.job.jobId==="active");
});
test("active parent also rejects a different image action",async()=>{
  const {service}=fixture(false,imageJob("refresh",asins[0]));
  await assert.rejects(service.start({...input,imageAction:{asin:asins[1],action:"analyze"}}),/正在执行/);
});
