import assert from "node:assert/strict";
import test from "node:test";

import { preprocessVocSnapshot } from "../../server/domain/voc/preprocess-voc-snapshot";
import { createVocPositioningOutputSchema } from "../../server/domain/voc/voc-positioning-contracts";
import { createVocPositioningRepairPatchContract } from "../../server/services/voc-positioning-repair-patch";
import type { SafeValidationIssue } from "../../server/runtime/safe-validation-issues";
import {
  SCOOTER_ASINS,
  realVocSnapshot,
  validVocPositioningOutput,
} from "./helpers/voc-positioning-fixture";

function fixture() {
  const facts = preprocessVocSnapshot(realVocSnapshot(
    SCOOTER_ASINS,
    "9a000000-0000-4000-8000-000000000001",
    "9a000000-0000-4000-8000-000000000002",
  ));
  return { facts, output: validVocPositioningOutput(facts) };
}

test("VOC repair patch applies only an issue-authorized nextValidation replacement", () => {
  const { facts, output } = fixture();
  const invalid = structuredClone(output);
  const unrelated = facts.evidenceIndex.find((evidence) =>
    evidence.dimension !== invalid.nextValidations[0]!.themeRefs[0]!.dimension ||
    evidence.themeKey !== invalid.nextValidations[0]!.themeRefs[0]!.themeKey
  );
  assert.ok(unrelated);
  invalid.nextValidations[0]!.evidenceIds = [unrelated.id];
  const issues: SafeValidationIssue[] = [
    { path: ["nextValidations", 0, "evidenceIds"], code: "custom", ruleId: "voc-evidence-crosses-theme-boundary" },
    { path: ["nextValidations", 0, "evidenceIds"], code: "custom", ruleId: "voc-evidence-missing-for-reference" },
  ];
  const contract = createVocPositioningRepairPatchContract(facts);
  assert.equal(contract.canHandle(invalid, issues), true);
  const repaired = contract.apply(invalid, {
    schemaVersion: "1.0.0",
    kind: "voc-positioning-repair-patch",
    operations: [{
      op: "replace-references",
      target: "nextValidations",
      index: 0,
      themeRefs: output.nextValidations[0]!.themeRefs,
      evidenceIds: output.nextValidations[0]!.evidenceIds,
    }],
  }, issues);
  assert.equal(createVocPositioningOutputSchema(facts).safeParse(repaired).success, true);
});

test("VOC repair patch rejects prototype-like keys, extra fields, and unbounded operations", () => {
  const { facts } = fixture();
  const contract = createVocPositioningRepairPatchContract(facts);
  assert.equal(contract.schema.safeParse({
    schemaVersion: "1.0.0",
    kind: "voc-positioning-repair-patch",
    operations: [{ op: "replace-references", target: "__proto__", index: 0, themeRefs: [], evidenceIds: [] }],
  }).success, false);
  assert.equal(contract.schema.safeParse({
    schemaVersion: "1.0.0",
    kind: "voc-positioning-repair-patch",
    operations: [],
    arbitraryJsonPointer: "/actions/0",
  }).success, false);
  assert.equal(contract.schema.safeParse({
    schemaVersion: "1.0.0",
    kind: "voc-positioning-repair-patch",
    operations: Array.from({ length: 11 }, () => ({
      op: "replace-positioning-strategy",
      index: 0,
      strategy: "validate",
    })),
  }).success, false);
});
