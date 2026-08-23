import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  failedStageRepairMessage,
  hasResumableFailedStages,
  type SyncJob,
} from "../../app/asin-sync-funnel";

test("repair availability requires a gap terminal with an unfinished automatic stage", () => {
  const terminal = job("completed-with-gaps", "partial");
  assert.equal(hasResumableFailedStages(terminal), true);
  assert.equal(hasResumableFailedStages(job("failed", "failed")), true);
  assert.equal(hasResumableFailedStages(job("completed", "partial")), true);
  assert.equal(hasResumableFailedStages(settledCompletedJob()), false);
  assert.equal(hasResumableFailedStages(job("completed-with-gaps", "done")), false);
  assert.equal(hasResumableFailedStages(job("completed-with-gaps", "failed", "queue")), false);
  assert.equal(hasResumableFailedStages({
    ...settledCompletedJob(),
    resumableStages: ["traffic"],
  }), true);
});

test("repair result copy distinguishes a new resume from a deduplicated active worker", () => {
  assert.equal(failedStageRepairMessage(false), "失败阶段已提交续跑");
  assert.equal(failedStageRepairMessage(true), "已复用正在续跑的原任务");
});

test("the production page grants repair UI only through the primary-admin predicate", () => {
  const source = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /canResumeFailedStages:\s*isPrimaryAdministrator\(authSession\.user\)/);
});

function job(status: string, stageStatus: string, stageId = "keywords"): SyncJob {
  return {
    jobId: "job-1",
    status,
    message: status,
    currentStageId: "keywords",
    stages: [{
      id: stageId,
      label: stageId === "queue" ? "Queue" : "Keywords",
      kind: "auto",
      status: stageStatus,
      estimatedSeconds: 1,
    }],
    asinProgress: {},
  };
}

function settledCompletedJob(): SyncJob {
  const completed = job("completed", "done");
  completed.stages.push(
    { id: "reviews", label: "Reviews", kind: "auto", status: "skipped", estimatedSeconds: 1 },
    { id: "alexa_voc", label: "Alexa VOC", kind: "manual", status: "manual", estimatedSeconds: 1 },
  );
  return completed;
}
