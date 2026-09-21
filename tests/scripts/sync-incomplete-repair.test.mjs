import test from "node:test";
import assert from "node:assert/strict";
import {
  asinsForSyncStage, repairProviderEnvironment, finalizeRepairCachedStages,
  runCatalogPhase, runOptionalXydcVariantEnrichment, imageRemarkRunAsins,
} from "../../scripts/run-asin-sync-job.mjs";

const asins = ["B000000001", "B000000002", "B000000003"];
const stages = [
  { id: "keywords", repairAsins: [asins[2]], repairParentJobId: "parent" },
  { id: "reviews", repairAsins: [], repairParentJobId: "parent" },
  { id: "catalog", repairAsins: [], repairXydcAsins: [], repairParentJobId: "parent" },
];

test("repair invokes only the persisted stage targets, including upstream empty retries", () => {
  const job = { stages };
  assert.deepEqual(asinsForSyncStage(job, "keywords", asins, asins), [asins[2]]);
  assert.deepEqual(asinsForSyncStage(job, "keywords", [], asins), [asins[2]]);
  assert.deepEqual(asinsForSyncStage(job, "reviews", asins, asins), []);
  assert.deepEqual(asinsForSyncStage(job, "keywords", asins, asins.slice(0, 2)), []);
});

test("repair provider policy bypasses incomplete records without global force", () => {
  assert.deepEqual(repairProviderEnvironment({ stages }, "keywords", { FORCE_REFRESH: "1", SIF_ASINS: asins[2] }), {
    FORCE_REFRESH: "0", SIF_ASINS: asins[2], AGENT_SYNC_REPAIR_INCOMPLETE: "1",
  });
  assert.deepEqual(repairProviderEnvironment({}, "keywords", { SIF_ASINS: asins[2] }), { SIF_ASINS: asins[2] });
  assert.deepEqual(repairProviderEnvironment({ stages: [{ id: "image_remarks", repairAsins: [asins[2]] }] }, "image_remarks", { FORCE_REFRESH: "1" }), {
    FORCE_REFRESH: "0", AGENT_SYNC_REPAIR_INCOMPLETE: "1",
  });
});

test("cached stages are projected into the new run without provider calls", () => {
  const projected = [];
  finalizeRepairCachedStages("new", { stages, asins }, (id, stage, cohort) => projected.push([id, stage, cohort]));
  assert.deepEqual(projected, [["new", "reviews", asins], ["new", "catalog", asins]]);
});

test("image repair selects missing slots only in planned ASINs despite new pending module rows", () => {
  const job = { stages: [{ id: "image_remarks", repairAsins: [asins[2]] }],
    asinProgress: Object.fromEntries(asins.map(asin => [asin, { image_remarks: { status: "pending" } }])) };
  assert.deepEqual(imageRemarkRunAsins(job, asins), [asins[2]]);
});

test("keyword-only repair does not invoke unrelated Xiyou collection", async () => {
  let calls = 0;
  await runCatalogPhase({ jobId: "new", job: { stages }, asins, marketplace: "US", catalogPending: [],
    shouldRun: () => true, finalizeCached: () => {}, runXydc: () => { calls++; },
  });
  assert.equal(calls, 0);
});

test("Xiyou repair retains full job authority while collecting only the missing family", async () => {
  let invocation;
  await runCatalogPhase({ jobId: "new", job: { stages: [{ ...stages[2], repairXydcAsins: [asins[2]] }] }, asins,
    marketplace: "US", catalogPending: [], shouldRun: () => true, finalizeCached: () => {},
    runXydc: input => { invocation = input; },
  });
  assert.deepEqual(invocation, { asins: [asins[2]], marketplace: "US", scopeAsins: asins });
  const preload = `process.stderr.write('[xydc-repair] ${asins[2]} ready\\n[xydc-repair] ${asins[0]} ready\\n'); process.exit(0);`;
  const result = await runOptionalXydcVariantEnrichment({ ...invocation,
    env: { ...process.env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}` },
  });
  assert.deepEqual(result, { succeeded: true, repairStatuses: { [asins[2]]: "ready" } });
});

test("explicit image actions preserve repair scope and distinguish gallery refresh from analysis",()=>{
  const refresh={stages:[{id:"listing",repairAsins:[asins[0]],imageAction:"refresh"},{id:"image_remarks",repairAsins:[asins[0]],imageAction:"refresh"}]};
  assert.equal(repairProviderEnvironment(refresh,"listing").AGENT_SYNC_IMAGE_ACTION,"refresh");
  assert.equal(repairProviderEnvironment(refresh,"image_remarks").AGENT_SYNC_IMAGE_ACTION,"refresh");
  assert.equal(repairProviderEnvironment(refresh,"listing").AGENT_SYNC_REPAIR_INCOMPLETE,"1");
  assert.deepEqual(imageRemarkRunAsins({...refresh,asinProgress:{[asins[0]]:{image_remarks:{status:"ready"},listing:{status:"ready"}}}},asins),[asins[0]]);
});

test("refresh must finish fetching before any AI reanalysis, while analyze uses current images",()=>{
  for(const status of ["pending","connector-failed","upstream-empty"]){
    const job={stages:[{id:"image_remarks",repairAsins:[asins[0]],imageAction:"refresh"}],asinProgress:{[asins[0]]:{listing:{status},image_remarks:{status:"pending"}}}};
    assert.deepEqual(imageRemarkRunAsins(job,asins),[]);
    job.stages[0].imageAction="analyze";
    assert.deepEqual(imageRemarkRunAsins(job,asins),[asins[0]]);
  }
});
