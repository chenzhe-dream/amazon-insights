import assert from "node:assert/strict";
import test from "node:test";

import {
  createComparisonDraft,
  reduceComparisonDraft,
  validateComparisonDraft,
} from "../../app/lib/comparison-draft";

const asins = Array.from({ length: 11 }, (_, index) => `B${String(index).padStart(9, "0")}`);

test("comparison drafts accept zero through ten slots and reject an eleventh atomically", () => {
  let draft = createComparisonDraft();

  assert.deepEqual(draft.slots, []);
  for (const asin of asins.slice(0, 10)) {
    draft = reduceComparisonDraft(draft, { type: "add", value: asin.toLowerCase() });
  }

  assert.deepEqual(draft.slots, asins.slice(0, 10));
  assert.deepEqual(draft.normalizedAsins, asins.slice(0, 10));
  assert.equal(draft.revision, 10);

  const rejected = reduceComparisonDraft(draft, { type: "add", value: asins[10]! });
  assert.strictEqual(rejected.slots, draft.slots);
  assert.strictEqual(rejected.normalizedAsins, draft.normalizedAsins);
  assert.equal(rejected.revision, draft.revision);
  assert.deepEqual(rejected.issues, [{ code: "too-many", attemptedCount: 11 }]);
});

test("add, remove, replace, and clear normalize accepted slot edits", () => {
  let draft = createComparisonDraft();

  draft = reduceComparisonDraft(draft, { type: "add", value: "  b0aaaa0001  " });
  draft = reduceComparisonDraft(draft, { type: "add", value: "b0bbbb0002" });
  draft = reduceComparisonDraft(draft, { type: "replace", index: 1, value: " b0cccc0003 " });
  draft = reduceComparisonDraft(draft, { type: "remove", index: 0 });

  assert.deepEqual(draft.slots, ["B0CCCC0003"]);
  assert.deepEqual(draft.normalizedAsins, ["B0CCCC0003"]);
  assert.equal(draft.revision, 4);
  assert.equal(draft.source, "user");
  assert.equal(draft.dirty, true);

  draft = reduceComparisonDraft(draft, { type: "clear" });
  assert.deepEqual(draft.slots, []);
  assert.deepEqual(draft.normalizedAsins, []);
  assert.equal(draft.revision, 5);
});

test("invalid and duplicate slots remain visible with deterministic diagnostics", () => {
  const draft = createComparisonDraft({
    slots: [" b0aaaa0001 ", "bad", "B0AAAA0001"],
    source: "url",
  });

  assert.deepEqual(draft.slots, ["B0AAAA0001", "BAD", "B0AAAA0001"]);
  assert.deepEqual(draft.normalizedAsins, ["B0AAAA0001"]);
  assert.deepEqual(draft.issues, [
    { code: "invalid", slot: 1, value: "BAD" },
    { code: "duplicate", slot: 2, value: "B0AAAA0001" },
  ]);
});

test("zero, one, and two ASINs are legal editing states but not valid snapshots", () => {
  let draft = createComparisonDraft();

  for (let count = 0; count < 3; count += 1) {
    const result = validateComparisonDraft(draft);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(result.issues, [{ code: "too-few", attemptedCount: count }]);
    }
    if (count < 2) {
      draft = reduceComparisonDraft(draft, { type: "add", value: asins[count]! });
    }
  }
});

test("three through ten normalized ASINs produce immutable US snapshots", () => {
  for (let count = 3; count <= 10; count += 1) {
    const draft = createComparisonDraft({ slots: asins.slice(0, count) });
    const result = validateComparisonDraft(draft);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.snapshot, {
        marketplace: "US",
        asins: asins.slice(0, count),
        draftRevision: 0,
      });
      assert.equal(Object.isFrozen(result.snapshot), true);
      assert.equal(Object.isFrozen(result.snapshot.asins), true);
    }
  }
});

test("accepted reducer values and their nested collections are frozen", () => {
  const initial = createComparisonDraft({
    slots: asins.slice(0, 3),
    source: "project",
    basedOnProjectId: "project-1",
  });
  const next = reduceComparisonDraft(initial, { type: "replace", index: 0, value: "bad" });

  assert.equal(next.basedOnProjectId, "project-1");
  assert.equal(Object.isFrozen(next), true);
  assert.equal(Object.isFrozen(next.slots), true);
  assert.equal(Object.isFrozen(next.normalizedAsins), true);
  assert.equal(Object.isFrozen(next.issues), true);
  assert.equal(Object.isFrozen(next.issues[0]), true);
});
