import assert from "node:assert/strict";
import test from "node:test";
import { applyPersistedStagePostcondition } from "../../scripts/run-asin-sync-job.mjs";
import { projectStageOutput } from "../../scripts/lib/sync-stage-output.mjs";

const asins = ["B09NNDX731", "B0BHHP21DP", "B0CZRBL776"];

function fixture() {
  const job = {
    jobId: "cohort-recovery-fixture", asins,
    stages: [{ id: "traffic", status: "partial" }],
    asinProgress: Object.fromEntries(asins.map(asin => [asin, { traffic: { status: "upstream-empty" } }])),
    outputs: [], diagnostics: [],
  };
  const records = {};
  function complete(index, outcome, options = {}) {
    const asin = asins[index];
    const ready = outcome === "ready";
    const failed = ["connector-failed", "timeout"].includes(outcome);
    if (ready) records[asin] = { overview: { total: { score: index + 1 }, nf: { score: index + 1 }, ad: { score: 0 } } };
    else delete records[asin];
    const diagnostics = failed ? [{
      asin, stage: "traffic", connector: "sif",
      failureKind: outcome === "timeout" ? "timeout" : "schema",
      causeCode: outcome === "timeout" ? "CONNECT_TIMEOUT" : "MCP_SCHEMA",
    }] : [];
    job.diagnostics.push(...diagnostics);
    applyPersistedStagePostcondition(job.jobId, "traffic", [asin], {
      commandSucceeded: !failed,
      resultStatusesByAsin: { [asin]: outcome }, diagnostics,
      readJob: () => job,
      readReadiness: () => ({ items: [{ asin, traffic: ready ? "ready" : "missing" }], missingAsins: ready ? [] : [asin] }),
      markModule: (_id, candidate, stage, patch) => { job.asinProgress[candidate][stage] = patch; },
      commitStage: (_id, { stageId, stagePatch, output }) => {
        job.stages = [{ id: stageId, ...stagePatch }];
        job.outputs = [output];
      },
      projectOutput: (stage, candidates, projectionOptions) => projectStageOutput(stage, candidates, {
        ...projectionOptions,
        readExport: (_file, name) => name === "sifListingTrafficRawByAsin" ? records : {},
      }),
      ...options,
    });
    return job.outputs[0];
  }
  return { job, complete };
}

test("stage detail counts the entire current job across success, empty and failure", () => {
  const { job, complete } = fixture();
  complete(0, "ready");
  complete(1, "connector-failed");
  const output = complete(2, "upstream-empty");
  assert.equal(job.stages[0].detail, "1/3 个 ASIN 的 traffic 已就绪 · 上游无结果 1 · 失败 1 · 待处理 0");
  assert.equal(output.stageStatus, "partial");
  assert.equal(output.gap.items.length, 2);
});

for (const discardProjection of [false, true]) {
  test(`schema failure repaired then timed out retains only the current timeout (${discardProjection ? "no projection" : "projected"})`, () => {
    const { job, complete } = fixture();
    complete(0, "connector-failed");
    complete(0, "ready");
    complete(0, "timeout");
    if (discardProjection) job.outputs = [];
    complete(1, "ready");
    const output = complete(2, "upstream-empty");
    assert.deepEqual(output.gap.items, [
      { asin: asins[0], causeCode: "CONNECT_TIMEOUT" },
      { asin: asins[2], causeCode: "UPSTREAM_EMPTY" },
    ]);
    assert.equal(output.gap.reasonCode, "CONNECT_TIMEOUT");
    assert.deepEqual(Object.keys(output.data.listingByAsin), [asins[1]]);
  });
}

test("without a current projection a connector failure does not inherit an earlier schema cause", () => {
  const { job, complete } = fixture();
  complete(0, "connector-failed");
  complete(0, "ready");
  complete(0, "connector-failed", { diagnostics: [] });
  job.outputs = [];
  const output = complete(1, "ready");
  assert.deepEqual(output.gap.items.find(item => item.asin === asins[0]), {
    asin: asins[0], causeCode: "CONNECTOR_FAILED",
  });
  assert.equal(output.gap.reasonCode, "CONNECTOR_FAILED");
});

test("single-ASIN repair clears its old gap and schema reason while updating full-cohort counts", () => {
  const { job, complete } = fixture();
  complete(0, "connector-failed");
  complete(1, "ready");
  complete(2, "upstream-empty");
  const repaired = complete(0, "ready");
  assert.equal(job.stages[0].detail, "2/3 个 ASIN 的 traffic 已就绪 · 上游无结果 1 · 失败 0 · 待处理 0");
  assert.deepEqual(repaired.gap.items, [{ asin: asins[2], causeCode: "UPSTREAM_EMPTY" }]);
  assert.equal(repaired.gap.reasonCode, "UPSTREAM_EMPTY");
  // A later sibling completion must not resurrect the retained historical diagnostic.
  const later = complete(2, "upstream-empty");
  assert.deepEqual(later.gap, repaired.gap);
  assert.deepEqual(Object.keys(later.data.listingByAsin).sort(), asins.slice(0, 2).sort());
  const done = complete(2, "ready");
  assert.equal(done.stageStatus, "done");
  assert.equal(done.gap, undefined);
  assert.equal(job.stages[0].detail, "3/3 个 ASIN 的 traffic 已就绪 · 上游无结果 0 · 失败 0 · 待处理 0");
});

for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
  test(`out-of-order completion ${order.join(",")} retains ready siblings and accurate gap causes`, () => {
    const { job, complete } = fixture();
    const outcomes = ["ready", "timeout", "upstream-empty"];
    for (const index of order) complete(index, outcomes[index]);
    const output = job.outputs[0];
    assert.deepEqual(output.data.listingByAsin, { [asins[0]]: { total: 1, natural: 1, advertising: 0 } });
    assert.deepEqual(output.gap.items, [
      { asin: asins[1], causeCode: "CONNECT_TIMEOUT" },
      { asin: asins[2], causeCode: "UPSTREAM_EMPTY" },
    ]);
    assert.equal(job.stages[0].detail, "1/3 个 ASIN 的 traffic 已就绪 · 上游无结果 1 · 失败 1 · 待处理 0");
  });
}

for (const [outcomes, counts] of [
  [["ready", "ready", "upstream-empty"], [2, 1, 0]],
  [["connector-failed", "timeout", "upstream-empty"], [0, 1, 2]],
  [["upstream-empty", "upstream-empty", "upstream-empty"], [0, 3, 0]],
  [["ready", "ready", "ready"], [3, 0, 0]],
]) {
  test(`cohort summary preserves completion semantics for ${outcomes.join(",")}`, () => {
    const { job, complete } = fixture();
    outcomes.forEach((outcome, index) => complete(index, outcome));
    const [ready, empty, failed] = counts;
    assert.equal(job.stages[0].detail, `${ready}/3 个 ASIN 的 traffic 已就绪 · 上游无结果 ${empty} · 失败 ${failed} · 待处理 0`);
    assert.equal(job.stages[0].status, ready === 3 ? "done" : "partial");
    assert.equal(job.outputs[0].gap?.items.length ?? 0, 3 - ready);
  });
}

test("a previously ready ASIN becoming failed then empty does not remove another ready sibling", () => {
  const { job, complete } = fixture();
  complete(0, "ready");
  complete(1, "ready");
  const failed = complete(0, "connector-failed");
  assert.deepEqual(Object.keys(failed.data.listingByAsin), [asins[1]]);
  const empty = complete(0, "upstream-empty");
  assert.deepEqual(Object.keys(empty.data.listingByAsin), [asins[1]]);
  assert.equal(empty.gap.reasonCode, "UPSTREAM_EMPTY");
  assert.equal(job.stages[0].detail, "1/3 个 ASIN 的 traffic 已就绪 · 上游无结果 2 · 失败 0 · 待处理 0");
  const later = complete(2, "upstream-empty");
  assert.deepEqual(later.gap, empty.gap);
});

test("pending siblings count as pending and explicit stage detail remains authoritative", () => {
  const { job, complete } = fixture();
  job.asinProgress[asins[1]].traffic.status = "pending";
  const updateStage = (_id, stage, patch) => { job.stages = [{ id: stage, ...patch }]; };
  complete(0, "ready", { updateStage });
  assert.equal(job.stages[0].status, "active");
  assert.equal(job.stages[0].detail, "1/3 个 ASIN 的 traffic 已就绪 · 上游无结果 1 · 失败 0 · 待处理 1");
  complete(0, "ready", { updateStage, stageDetail: "explicit stage explanation" });
  assert.equal(job.stages[0].detail, "explicit stage explanation");
});
