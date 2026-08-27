import assert from "node:assert/strict";
import test from "node:test";

import type { AsinModuleResult } from "../../app/lib/sync-job-display";
import {
  presentSyncProgress,
  type SyncJob,
  type SyncStage,
} from "../../app/lib/sync-progress-presentation";

const NOW = "2026-08-27T00:02:00.000Z";
const ASINS = [
  "B000000001",
  "B000000002",
  "B000000003",
  "B000000004",
  "B000000005",
  "B000000006",
] as const;

function moduleResult(status: AsinModuleResult["status"]): AsinModuleResult {
  return { status, reason: status === "ready" || status === "pending" ? null : status, updatedAt: NOW };
}

function stage(id: string, status: string, detail?: string): SyncStage {
  return {
    id,
    label: id,
    kind: "auto",
    status,
    estimatedSeconds: 120,
    startedAt: status === "active" ? "2026-08-27T00:00:00.000Z" : null,
    completedAt: status === "done" ? NOW : null,
    ...(detail ? { detail } : {}),
  };
}

function job(input: {
  stageId?: string;
  stageStatus: string;
  moduleStatuses: readonly AsinModuleResult["status"][];
  jobStatus?: string;
  detail?: string;
}): SyncJob {
  const stageId = input.stageId ?? "keywords";
  return {
    jobId: "progress-job",
    asins: [...ASINS],
    marketplace: "US",
    status: input.jobStatus ?? "running",
    message: "同步进行中",
    currentStageId: stageId,
    stages: [stage(stageId, input.stageStatus, input.detail)],
    asinProgress: Object.fromEntries(ASINS.map((asin, index) => [
      asin,
      { [stageId]: moduleResult(input.moduleStatuses[index] ?? "pending") },
    ])),
  };
}

test("six-ASIN progress advances from queue through authoritative active outcomes to terminal", () => {
  const queued = presentSyncProgress(job({
    stageStatus: "pending",
    moduleStatuses: ASINS.map(() => "pending"),
  }), Date.parse(NOW));
  const active = presentSyncProgress(job({
    stageStatus: "active",
    moduleStatuses: ["ready", "timeout", "pending", "pending", "pending", "pending"],
  }), Date.parse(NOW));
  const terminal = presentSyncProgress(job({
    stageStatus: "done",
    jobStatus: "completed-with-gaps",
    moduleStatuses: ["ready", "timeout", "ready", "ready", "ready", "ready"],
  }), Date.parse(NOW));

  assert.deepEqual(
    [queued.executionPercent, active.executionPercent, terminal.executionPercent],
    [0, 33, 100],
  );
  assert.deepEqual(
    [queued.rows[0]?.executionPercent, active.rows[0]?.executionPercent, terminal.rows[0]?.executionPercent],
    [0, 33, 100],
  );
  assert.equal(queued.rows[0]?.statusCopy, "排队中");
  assert.equal(active.rows[0]?.statusCopy, "处理中 · 2/6 个 ASIN");
  assert.equal(terminal.rows[0]?.statusCopy, "已完成");
});

test("active progress is monotonic from persisted outcomes, refresh-stable, and capped below 100", () => {
  const snapshots = [1, 3, 6].map((terminalCount) => job({
    stageStatus: "active",
    moduleStatuses: ASINS.map((_, index) => index < terminalCount ? "ready" : "pending"),
  }));
  const percentages = snapshots.map((snapshot) =>
    presentSyncProgress(snapshot, Date.parse(NOW)).executionPercent
  );

  assert.deepEqual(percentages, [16, 50, 99]);
  const restoredEarly = presentSyncProgress(snapshots[1]!, Date.parse("2026-08-27T00:02:00.000Z"));
  const restoredLate = presentSyncProgress(structuredClone(snapshots[1]!), Date.parse("2026-08-27T00:20:00.000Z"));
  assert.equal(restoredEarly.executionPercent, restoredLate.executionPercent);
  assert.equal(restoredEarly.rows[0]?.executionPercent, restoredLate.rows[0]?.executionPercent);
  assert.equal(restoredLate.rows[0]?.statusCopy, "处理中 · 3/6 个 ASIN");
});

test("image progress uses the persisted completed-total detail and never reports active 100", () => {
  const partial = presentSyncProgress(job({
    stageId: "image_remarks",
    stageStatus: "active",
    moduleStatuses: ASINS.map(() => "pending"),
    detail: "图片 AI 备注：已完成 3/20 张 · 就绪 3 · 上游无结果 0 · 超时 0 · 连接失败 0",
  }), Date.parse(NOW));
  const awaitingStageCommit = presentSyncProgress(job({
    stageId: "image_remarks",
    stageStatus: "active",
    moduleStatuses: ASINS.map(() => "pending"),
    detail: "图片 AI 备注：已完成 20/20 张 · 就绪 20 · 上游无结果 0 · 超时 0 · 连接失败 0",
  }), Date.parse(NOW));

  assert.equal(partial.executionPercent, 15);
  assert.equal(partial.rows[0]?.executionPercent, 15);
  assert.equal(partial.rows[0]?.statusCopy, "处理中 · 3/20 张");
  assert.equal(awaitingStageCommit.executionPercent, 99);
  assert.equal(awaitingStageCommit.rows[0]?.executionPercent, 99);
});

test("terminal failure outcomes count as executed work without inflating data completeness", () => {
  const active = presentSyncProgress(job({
    stageStatus: "active",
    moduleStatuses: ["ready", "upstream-empty", "timeout", "connector-failed", "manual", "pending"],
  }), Date.parse(NOW), ["keywords"]);
  const failed = presentSyncProgress(job({
    stageStatus: "failed",
    jobStatus: "failed",
    moduleStatuses: ["ready", "upstream-empty", "timeout", "connector-failed", "manual", "pending"],
  }), Date.parse(NOW), ["keywords"]);

  assert.equal(active.executionPercent, 83);
  assert.equal(active.completenessPercent, 17);
  assert.equal(active.rows[0]?.statusCopy, "处理中 · 5/6 个 ASIN");
  assert.equal(failed.executionPercent, 100);
  assert.equal(failed.rows[0]?.executionPercent, 100);
  assert.equal(failed.rows[0]?.statusCopy, "失败");
  assert.equal(failed.completenessPercent, 17);
});
