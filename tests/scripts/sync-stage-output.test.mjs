import assert from "node:assert/strict";
import { test } from "node:test";

import { projectStageOutput } from "../../scripts/lib/sync-stage-output.mjs";

test("projectStageOutput hashes only the fixed sales projection", () => {
  const draft = projectStageOutput("sales_trend", ["B0TEST0001"], {
    readExport: (_file, name) => name === "sorftimeSalesTrendData"
      ? {
        B0TEST0001: { status: "ready", volume: [] },
        B0OTHER001: { status: "ready" },
      }
      : {},
    now: () => "2026-08-25T09:00:00.000Z",
  });

  assert.deepEqual(Object.keys(draft.data.trendByAsin), ["B0TEST0001"]);
  assert.match(draft.contentHash, /^[a-f0-9]{64}$/);
});

test("projectStageOutput uses canonical object keys and a fixed terminal gap", () => {
  const options = {
    stageStatus: "partial",
    gapReasonCode: "CONNECT_TIMEOUT",
    now: () => "2026-08-25T09:00:00.000Z",
    readExport: () => ({
      B0TEST0002: { nested: { z: 1, a: 2 }, status: "ready" },
      B0OTHER002: { status: "ready" },
    }),
  };
  const first = projectStageOutput("sales_trend", ["B0TEST0002"], options);
  const second = projectStageOutput("sales_trend", ["B0TEST0002"], {
    ...options,
    readExport: () => ({
      B0OTHER002: { status: "ready" },
      B0TEST0002: { status: "ready", nested: { a: 2, z: 1 } },
    }),
  });

  assert.equal(first.contentHash, second.contentHash);
  assert.deepEqual(first.gap, { state: "partial", reasonCode: "CONNECT_TIMEOUT" });
  assert.equal(first.data, undefined);
});
