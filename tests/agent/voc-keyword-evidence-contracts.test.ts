import assert from "node:assert/strict";
import { test } from "node:test";
import { CreateRunRequestSchema } from "../../shared/agent-contracts";
test("explicit scoped fallback request is accepted", () => {
 assert.equal(CreateRunRequestSchema.safeParse({ mode: "existing-data", idempotencyKey: "test", evidenceSelection: { sourcePolicy: "manual-with-review-fallback", baseSyncRunId: "11111111-1111-4111-8111-111111111111", selectedAsins: ["B08L7DD8L9"], expectedInputFingerprint: "a".repeat(64) } }).success, true);
});
test("client supplied source bodies cannot establish evidence", () => {
 assert.equal(CreateRunRequestSchema.safeParse({ mode: "existing-data", idempotencyKey: "test", evidenceSelection: { sourcePolicy: "manual-with-review-fallback", source: { blocks: [] } } }).success, false);
});
