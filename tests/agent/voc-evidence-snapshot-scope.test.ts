import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSnapshotSubjectInput } from "../../server/db/postgres/snapshot-subject";
const input = { actorId: "11111111-1111-4111-8111-111111111111", actorOrganizationId: "22222222-2222-4222-8222-222222222222", runId: "33333333-3333-4333-8333-333333333333", expectedProjectId: "44444444-4444-4444-8444-444444444444", expectedMarketplace: "US", expectedAsins: ["B08L7DD8L9"], expectedRunCutoffAt: "2026-09-10T00:00:00.000Z", allowAsinSubset: true };
test("explicit evidence snapshot scope permits one selected ASIN", () => { assert.doesNotThrow(() => validateSnapshotSubjectInput(input)); });
test("legacy full-project snapshot validation is preserved", () => { assert.throws(() => validateSnapshotSubjectInput({ ...input, allowAsinSubset: false })); });
