import assert from "node:assert/strict";
import test from "node:test";

import { preprocessVocSnapshot } from "../../server/domain/voc/preprocess-voc-snapshot";
import { createVocPositioningRepairGuidance } from "../../server/services/voc-positioning-repair-guidance";
import type { SafeValidationIssue } from "../../server/runtime/safe-validation-issues";
import {
  SCOOTER_ASINS,
  realVocSnapshot,
} from "./helpers/voc-positioning-fixture";

function scooterFacts() {
  return preprocessVocSnapshot(realVocSnapshot(
    SCOOTER_ASINS,
    "98000000-0000-4000-8000-000000000001",
    "98000000-0000-4000-8000-000000000002",
  ));
}

type RepairTheme = Readonly<{
  identity: Readonly<{ dimension: string; themeKey: string }>;
  judgmentEcho: Readonly<{
    role: string;
    evidenceIds: readonly string[];
  }>;
  action: Readonly<{
    requiredActionTypes?: readonly string[];
    requiredValidationDomains?: readonly string[];
  }>;
  allowedEvidenceIds: readonly string[];
}>;

type RepairPayload = Readonly<{
  allowedThemeReferenceDimensions: readonly string[];
  R: readonly RepairTheme[];
  positioningStrategyByStance: Readonly<Record<string, readonly string[]>>;
  requirements: Readonly<Record<string, unknown>>;
  failureFocus: readonly SafeValidationIssue[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePayload(issues: readonly SafeValidationIssue[]) {
  const guidance = createVocPositioningRepairGuidance(scooterFacts(), issues);
  assert.ok(guidance);
  assert.equal(guidance[0], "VOC_REPAIR_GUIDANCE_V1");
  assert.ok(guidance[1]);
  const payload: unknown = JSON.parse(guidance[1]);
  assert.ok(isRecord(payload));
  assert.ok(Array.isArray(payload.R));
  return payload as RepairPayload;
}

test("empty parse diagnostics produce a bounded exact VOC repair baseline", () => {
  const facts = scooterFacts();
  const payload = parsePayload([]);
  assert.deepEqual(payload.allowedThemeReferenceDimensions, [
    "attention",
    "positives",
    "negatives",
    "unmet",
    "audiences",
    "scenarios",
    "motives",
  ]);
  const expectedProtected = facts.dimensions.flatMap((dimension) =>
    dimension.themes
      .filter((theme) => theme.priority.level === "P0" || theme.priority.level === "P1")
      .map((theme) => ({ dimension: dimension.key, themeKey: theme.key })),
  );
  assert.deepEqual(
    payload.R.map((entry) => entry.identity),
    expectedProtected,
  );
  const structural = payload.R.find(
    (entry) => entry.identity.dimension === "attention" &&
      entry.identity.themeKey === "耐用性/结构强度",
  );
  assert.ok(structural);
  assert.equal(structural.judgmentEcho.role, "new-product-avoidance");
  assert.deepEqual(structural.action.requiredActionTypes, ["avoid", "redesign"]);
  assert.deepEqual(structural.action.requiredValidationDomains, ["compliance"]);
  assert.deepEqual(
    structural.judgmentEcho.evidenceIds,
    facts.dimensions[0]!.themes[0]!.evidenceIds,
  );
  assert.equal(payload.requirements.judgmentIdentities, "exactly-R");
  assert.equal(payload.requirements.actionThemeRefUnion, "superset-of-R");
  assert.equal(JSON.stringify(payload).length <= 24_000, true);
});

test("known real-relay semantic issues retain exact paths and closed repair facts", () => {
  const issues: SafeValidationIssue[] = [
    { path: ["positioning", 5, "strategy"], code: "custom", ruleId: "voc-positioning-strategy-stance-mismatch" },
    { path: ["positioning", 9, "strategy"], code: "custom", ruleId: "voc-protected-positioning-strategy-downgrade" },
    { path: ["checklists", "differentiationOpportunities", 2, "themeRefs"], code: "custom", ruleId: "voc-forged-theme-reference" },
    { path: ["themeJudgments"], code: "custom", ruleId: "voc-protected-theme-judgment-missing" },
    { path: ["actions", 1, "actionType"], code: "custom", ruleId: "voc-protected-action-downgrade" },
    { path: ["actions"], code: "custom", ruleId: "voc-protected-theme-action-missing" },
    { path: ["nextValidations", 0, "evidenceIds"], code: "custom", ruleId: "voc-evidence-crosses-theme-boundary" },
    { path: ["nextValidations", 0, "evidenceIds"], code: "custom", ruleId: "voc-evidence-missing-for-reference" },
  ];
  const payload = parsePayload(issues);
  assert.deepEqual(payload.failureFocus, issues);
  assert.deepEqual(payload.positioningStrategyByStance, {
    "supported-by-voc": ["retain", "redesign", "avoid"],
    "requires-validation": ["differentiate", "validate"],
    "not-assessed": ["validate"],
  });
  assert.equal(payload.requirements.repairReferencedStructuresUsingOnlyR, true);
  for (const protectedTheme of payload.R) {
    assert.ok(protectedTheme.allowedEvidenceIds.length > 0);
    assert.deepEqual(
      protectedTheme.allowedEvidenceIds,
      protectedTheme.judgmentEcho.evidenceIds,
    );
  }
});

test("unknown or unsafe diagnostics fail closed to generic repair", () => {
  assert.equal(createVocPositioningRepairGuidance(scooterFacts(), [
    { path: ["nextValidations", 0, "themeRefs", 0, "dimension"], code: "invalid_value" },
  ]), null);
  assert.equal(createVocPositioningRepairGuidance(scooterFacts(), [
    { path: ["<field>"], code: "custom" },
  ]), null);
});

test("an unbounded protected theme set fails closed instead of repeating all facts", () => {
  const oversized = structuredClone(scooterFacts());
  for (const dimension of oversized.dimensions) {
    for (const theme of dimension.themes) theme.priority.level = "P1";
  }
  assert.equal(createVocPositioningRepairGuidance(oversized, []), null);
});
