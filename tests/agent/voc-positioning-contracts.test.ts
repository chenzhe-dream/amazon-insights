import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVocPositioningInput,
  canonicalizeVocPositioningOutput,
  createVocPositioningOutputSchema,
  createVocPositioningOutputSchemaFromSkillInput,
  type VocPositioningOutput,
} from "../../server/domain/voc/voc-positioning-contracts";
import {
  LIGHTING_ASINS,
  SCOOTER_ASINS,
  realVocFacts,
  validVocPositioningOutput,
} from "./helpers/voc-positioning-fixture";

const scooterFacts = realVocFacts(
  SCOOTER_ASINS,
  "11111111-1111-4111-8111-111111111111",
);
const lightingFacts = realVocFacts(
  LIGHTING_ASINS,
  "22222222-2222-4222-8222-222222222222",
);

test("full scooter and partial lighting facts build a minimal closed Skill input", () => {
  for (const facts of [scooterFacts, lightingFacts]) {
    const input = buildVocPositioningInput(facts);
    assert.deepEqual(Object.keys(input), [
      "schemaVersion",
      "kind",
      "snapshot",
      "factsDigest",
      "coverage",
      "dimensions",
      "evidenceIndex",
    ]);
    assert.equal(JSON.stringify(input).includes(facts.snapshot.runId), false);
    assert.equal(JSON.stringify(input).includes("organizationId"), false);
    assert.equal(JSON.stringify(input).includes("cookie"), false);
    assert.equal(Object.isFrozen(input), true);
  }
});

test("valid full and partial fake-model results pass the closed output contract", () => {
  for (const facts of [scooterFacts, lightingFacts]) {
    const parsed = createVocPositioningOutputSchema(facts).parse(validVocPositioningOutput(facts));
    assert.equal(parsed.identity.factsDigest, facts.factsDigest);
    assert.equal(parsed.status, facts === scooterFacts ? "complete" : "partial");
  }
});

test("canonicalize fact-bound echoes without inventing a model judgment", () => {
  const schema = createVocPositioningOutputSchema(scooterFacts);
  const themes = scooterFacts.dimensions.flatMap((dimension) =>
    dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
  );
  const safety = themes.find(
    ({ theme }) =>
      theme.priority.safetyRule !== null || theme.priority.level === "P0",
  );
  const ordinary = themes.find(
    ({ theme }) =>
      theme.priority.safetyRule === null && theme.priority.level !== "P0",
  );
  assert.ok(safety);
  assert.ok(ordinary);
  const unrelated = themes.find(
    ({ dimension, theme }) =>
      dimension !== safety.dimension || theme.key !== safety.theme.key,
  );
  assert.ok(unrelated);
  const unrelatedEvidence = unrelated.theme.evidenceIds[0];
  assert.ok(unrelatedEvidence);

  const candidate = structuredClone(validVocPositioningOutput(scooterFacts));
  candidate.coreConclusion.themeRefs = [{
    dimension: safety.dimension,
    themeKey: safety.theme.key,
  }];
  candidate.coreConclusion.evidenceIds = [unrelatedEvidence];

  const protectedPositioning = candidate.positioning[0]!;
  protectedPositioning.themeRefs = [{
    dimension: safety.dimension,
    themeKey: safety.theme.key,
  }];
  protectedPositioning.evidenceIds = [unrelatedEvidence];
  protectedPositioning.stance = "requires-validation";
  protectedPositioning.strategy = "differentiate";
  protectedPositioning.priority = "P3";

  const notAssessed = candidate.positioning[1]!;
  notAssessed.themeRefs = [{
    dimension: ordinary.dimension,
    themeKey: ordinary.theme.key,
  }];
  notAssessed.evidenceIds = [...ordinary.theme.evidenceIds];
  notAssessed.stance = "not-assessed";
  notAssessed.strategy = "retain";

  const priceTier = candidate.positioning.find(
    ({ dimension }) => dimension === "price-tier",
  );
  assert.ok(priceTier);
  priceTier.stance = "supported-by-voc";
  priceTier.strategy = "retain";

  const judgment = candidate.themeJudgments.find(
    ({ dimension, themeKey }) =>
      dimension === safety.dimension && themeKey === safety.theme.key,
  );
  assert.ok(judgment);
  judgment.label = "forged-but-shape-valid";
  judgment.priority = "P3";
  judgment.role = "observe-or-pseudo-demand";
  judgment.metrics = [{
    ...judgment.metrics[0]!,
    mentionPct: 99,
  }];
  judgment.evidenceIds = [unrelatedEvidence];

  const before = structuredClone(candidate);
  const normalized = canonicalizeVocPositioningOutput(
    candidate,
    scooterFacts,
  ) as VocPositioningOutput;

  assert.deepEqual(candidate, before);
  assert.equal(normalized.actions.length, candidate.actions.length);
  assert.deepEqual(normalized.checklists, candidate.checklists);
  assert.deepEqual(normalized.nextValidations, candidate.nextValidations);
  assert.deepEqual(normalized.coreConclusion.evidenceIds, [
    ...safety.theme.evidenceIds,
  ]);
  assert.deepEqual(protectedPositioning.evidenceIds, [unrelatedEvidence]);
  assert.deepEqual(normalized.positioning[0]!.evidenceIds, [
    ...safety.theme.evidenceIds,
  ]);
  assert.equal(normalized.positioning[0]!.strategy, "validate");
  assert.equal(normalized.positioning[0]!.priority, "P0");
  assert.equal(normalized.positioning[1]!.strategy, "validate");
  assert.equal(priceTier.stance, "supported-by-voc");
  assert.equal(normalized.positioning.find(
    ({ dimension }) => dimension === "price-tier",
  )!.stance, "requires-validation");
  assert.equal(normalized.positioning.find(
    ({ dimension }) => dimension === "price-tier",
  )!.strategy, "validate");
  assert.equal(normalized.themeJudgments.find(
    ({ dimension, themeKey }) =>
      dimension === safety.dimension && themeKey === safety.theme.key,
  )!.role, "new-product-avoidance");
  assert.equal(schema.safeParse(normalized).success, true);
});

test("canonicalization leaves ambiguous and structurally unsafe model choices failing", () => {
  const schema = createVocPositioningOutputSchema(scooterFacts);
  const themes = scooterFacts.dimensions.flatMap((dimension) =>
    dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
  );
  const safety = themes.find(
    ({ theme }) =>
      theme.priority.safetyRule !== null || theme.priority.level === "P0",
  );
  const ordinary = themes.find(
    ({ theme }) =>
      theme.priority.safetyRule === null && theme.priority.level !== "P0",
  );
  assert.ok(safety);
  assert.ok(ordinary);

  const supportedProtected = structuredClone(validVocPositioningOutput(scooterFacts));
  Object.assign(supportedProtected.positioning[0]!, {
    themeRefs: [{ dimension: safety.dimension, themeKey: safety.theme.key }],
    evidenceIds: [...safety.theme.evidenceIds],
    stance: "supported-by-voc",
    strategy: "retain",
  });
  const supportedNormalized = canonicalizeVocPositioningOutput(
    supportedProtected,
    scooterFacts,
  ) as VocPositioningOutput;
  assert.equal(supportedNormalized.positioning[0]!.strategy, "retain");
  assert.equal(schema.safeParse(supportedNormalized).success, false);

  const genericRequiresValidation = structuredClone(
    validVocPositioningOutput(scooterFacts),
  );
  Object.assign(genericRequiresValidation.positioning[1]!, {
    themeRefs: [{ dimension: ordinary.dimension, themeKey: ordinary.theme.key }],
    evidenceIds: [...ordinary.theme.evidenceIds],
    stance: "requires-validation",
    strategy: "retain",
  });
  assert.equal(schema.safeParse(canonicalizeVocPositioningOutput(
    genericRequiresValidation,
    scooterFacts,
  )).success, false);

  const unknownPriceTier = structuredClone(validVocPositioningOutput(scooterFacts));
  const unknownPrice = unknownPriceTier.positioning.find(
    ({ dimension }) => dimension === "price-tier",
  );
  assert.ok(unknownPrice);
  unknownPrice.themeRefs = [{ dimension: safety.dimension, themeKey: "unknown-theme" }];
  unknownPrice.stance = "supported-by-voc";
  unknownPrice.strategy = "retain";
  const unknownPriceNormalized = canonicalizeVocPositioningOutput(
    unknownPriceTier,
    scooterFacts,
  ) as VocPositioningOutput;
  const normalizedPrice = unknownPriceNormalized.positioning.find(
    ({ dimension }) => dimension === "price-tier",
  );
  assert.ok(normalizedPrice);
  assert.equal(normalizedPrice.stance, "supported-by-voc");
  assert.equal(normalizedPrice.strategy, "retain");
  assert.equal(schema.safeParse(unknownPriceNormalized).success, false);

  const unknownAndDuplicate = structuredClone(validVocPositioningOutput(scooterFacts));
  unknownAndDuplicate.coreConclusion.themeRefs = [
    { dimension: safety.dimension, themeKey: "unknown-theme" },
    { dimension: safety.dimension, themeKey: "unknown-theme" },
  ];
  const duplicateJudgment = structuredClone(unknownAndDuplicate.themeJudgments[0]!);
  unknownAndDuplicate.themeJudgments.push(duplicateJudgment);
  const normalized = canonicalizeVocPositioningOutput(
    unknownAndDuplicate,
    scooterFacts,
  ) as VocPositioningOutput;
  assert.deepEqual(normalized.coreConclusion.themeRefs, unknownAndDuplicate.coreConclusion.themeRefs);
  assert.equal(normalized.themeJudgments.length, unknownAndDuplicate.themeJudgments.length);
  assert.deepEqual(normalized.themeJudgments.at(-1), duplicateJudgment);
  assert.equal(schema.safeParse(normalized).success, false);
});

test("full and partial price-tier positioning cannot contradict its validation boundary", () => {
  for (const facts of [scooterFacts, lightingFacts]) {
    const output = structuredClone(validVocPositioningOutput(facts));
    const priceTier = output.positioning.find(
      ({ dimension }) => dimension === "price-tier",
    );
    assert.ok(priceTier);
    priceTier.stance = "supported-by-voc";

    assert.equal(createVocPositioningOutputSchema(facts).safeParse(output).success, false);
  }
});

test("validation-only positioning dimensions and stance strategies form a closed matrix", () => {
  const schema = createVocPositioningOutputSchema(scooterFacts);
  const ordinaryTheme = scooterFacts.dimensions
    .flatMap((dimension) =>
      dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
    )
    .find(({ theme }) => theme.priority.safetyRule === null);
  assert.ok(ordinaryTheme);
  for (const dimension of [
    "differentiator",
    "core-scenario",
    "material-structure",
  ] as const) {
    const output = structuredClone(validVocPositioningOutput(scooterFacts));
    const positioning = output.positioning.find(
      (candidate) => candidate.dimension === dimension,
    );
    assert.ok(positioning);
    positioning.stance = "supported-by-voc";
    positioning.strategy = "differentiate";
    positioning.priority = ordinaryTheme.theme.priority.level;
    positioning.themeRefs = [{
      dimension: ordinaryTheme.dimension,
      themeKey: ordinaryTheme.theme.key,
    }];
    positioning.evidenceIds = [...ordinaryTheme.theme.evidenceIds];
    assert.equal(schema.safeParse(output).success, false);
  }

  const contradictory = structuredClone(validVocPositioningOutput(scooterFacts));
  const priceTier = contradictory.positioning.find(
    ({ dimension }) => dimension === "price-tier",
  );
  assert.ok(priceTier);
  priceTier.strategy = "retain";
  assert.equal(schema.safeParse(contradictory).success, false);

  const imitation = structuredClone(validVocPositioningOutput(scooterFacts));
  Object.assign(imitation.positioning[0]!, { strategy: "imitate-competitor" });
  assert.equal(schema.safeParse(imitation).success, false);
});

test("malformed and open model output is rejected", () => {
  const schema = createVocPositioningOutputSchema(scooterFacts);
  assert.equal(schema.safeParse("not-json").success, false);
  assert.equal(
    schema.safeParse({ ...validVocPositioningOutput(scooterFacts), hidden: "forged" }).success,
    false,
  );
});

test("deterministic metric changes and forged facts are rejected independently", () => {
  const schema = createVocPositioningOutputSchema(scooterFacts);
  const changedMetric = structuredClone(validVocPositioningOutput(scooterFacts));
  assert.ok(changedMetric.themeJudgments[0]?.metrics[0]);
  changedMetric.themeJudgments[0].metrics[0].mentionPct = 99;
  assert.equal(schema.safeParse(changedMetric).success, false);

  const changedAsin = structuredClone(validVocPositioningOutput(scooterFacts));
  assert.ok(changedAsin.themeJudgments[0]?.metrics[0]);
  changedAsin.themeJudgments[0].metrics[0].asin = SCOOTER_ASINS.find(
    (asin) => asin !== changedAsin.themeJudgments[0]!.metrics[0]!.asin,
  )!;
  assert.equal(schema.safeParse(changedAsin).success, false);

  const changedSource = structuredClone(validVocPositioningOutput(scooterFacts));
  assert.ok(changedSource.themeJudgments[0]?.metrics[0]);
  changedSource.themeJudgments[0].metrics[0].sourceId =
    changedSource.themeJudgments[0].metrics[0].sourceId === "alexa-voc"
      ? "sorftime-review-analysis"
      : "alexa-voc";
  assert.equal(schema.safeParse(changedSource).success, false);

  const forged = structuredClone(validVocPositioningOutput(scooterFacts));
  assert.ok(forged.themeJudgments[0]);
  forged.themeJudgments[0].themeKey = "forged-theme";
  assert.equal(schema.safeParse(forged).success, false);
});

test("dangling, cross-ASIN, cross-source, and duplicate evidence is rejected", () => {
  const schema = createVocPositioningOutputSchema(scooterFacts);

  const dangling = structuredClone(validVocPositioningOutput(scooterFacts));
  dangling.coreConclusion.evidenceIds = ["f".repeat(64)];
  assert.equal(schema.safeParse(dangling).success, false);

  const judgment = validVocPositioningOutput(scooterFacts).themeJudgments[0];
  assert.ok(judgment?.metrics[0]);
  const evidence = scooterFacts.evidenceIndex.find(
    (candidate) =>
      candidate.themeKey !== judgment.themeKey &&
      (candidate.asin !== judgment.metrics[0]!.asin ||
        candidate.sourceId !== judgment.metrics[0]!.sourceId),
  );
  assert.ok(evidence);
  const crossed = structuredClone(validVocPositioningOutput(scooterFacts));
  crossed.themeJudgments[0]!.evidenceIds = [evidence.id];
  assert.equal(schema.safeParse(crossed).success, false);

  const duplicateKeyPair = scooterFacts.dimensions
    .flatMap((dimension) =>
      dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
    )
    .flatMap((first, index, all) =>
      all.slice(index + 1).map((second) => ({ first, second })),
    )
    .find(
      ({ first, second }) =>
        first.theme.key === second.theme.key &&
        first.dimension !== second.dimension,
    );
  assert.ok(duplicateKeyPair);
  const wrongDimensionEvidence = scooterFacts.evidenceIndex.find(
    (candidate) =>
      candidate.dimension === duplicateKeyPair.second.dimension &&
      candidate.themeKey === duplicateKeyPair.second.theme.key,
  );
  assert.ok(wrongDimensionEvidence);
  const crossedDimension = structuredClone(validVocPositioningOutput(scooterFacts));
  crossedDimension.positioning[0]!.themeRefs = [
    {
      dimension: duplicateKeyPair.first.dimension,
      themeKey: duplicateKeyPair.first.theme.key,
    },
  ];
  crossedDimension.positioning[0]!.evidenceIds = [wrongDimensionEvidence.id];
  assert.equal(schema.safeParse(crossedDimension).success, false);

  const duplicate = structuredClone(validVocPositioningOutput(scooterFacts));
  const first = duplicate.coreConclusion.evidenceIds[0]!;
  duplicate.coreConclusion.evidenceIds = [first, first];
  assert.equal(schema.safeParse(duplicate).success, false);

  const duplicateAction = structuredClone(validVocPositioningOutput(scooterFacts));
  assert.ok(duplicateAction.actions[0]?.id);
  assert.ok(duplicateAction.actions[1]);
  duplicateAction.actions[1].id = duplicateAction.actions[0].id;
  assert.equal(schema.safeParse(duplicateAction).success, false);
});

test("P0/P1 and safety priorities cannot be downgraded or omitted", () => {
  const schema = createVocPositioningOutputSchema(scooterFacts);
  const downgraded = structuredClone(validVocPositioningOutput(scooterFacts));
  const protectedIndex = downgraded.themeJudgments.findIndex(
    (judgment) => judgment.priority === "P0" || judgment.priority === "P1",
  );
  assert.notEqual(protectedIndex, -1);
  downgraded.themeJudgments[protectedIndex]!.priority = "P3";
  assert.equal(schema.safeParse(downgraded).success, false);

  const safetyItem = scooterFacts.dimensions
    .flatMap((dimension) =>
      dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
    )
    .find(({ theme }) => theme.priority.safetyRule !== null);
  assert.ok(safetyItem);
  const safetyTheme = safetyItem.theme;
  const downgradedAction = structuredClone(validVocPositioningOutput(scooterFacts));
  const safetyAction = downgradedAction.actions.find((action) =>
    action.themeRefs.some(
      (reference) =>
        reference.dimension === safetyItem.dimension &&
        reference.themeKey === safetyTheme.key,
    ),
  );
  assert.ok(safetyAction);
  safetyAction.priority = "P3";
  assert.equal(schema.safeParse(downgradedAction).success, false);

  const downgradedSafetyAction = structuredClone(
    validVocPositioningOutput(scooterFacts),
  );
  const semanticSafetyAction = downgradedSafetyAction.actions.find((action) =>
    action.themeRefs.some(
      (reference) =>
        reference.dimension === safetyItem.dimension &&
        reference.themeKey === safetyTheme.key,
    ),
  );
  assert.ok(semanticSafetyAction);
  semanticSafetyAction.actionType = "retain";
  assert.equal(schema.safeParse(downgradedSafetyAction).success, false);

  const downgradedPositioning = structuredClone(
    validVocPositioningOutput(scooterFacts),
  );
  downgradedPositioning.positioning[0]!.themeRefs = [
    { dimension: safetyItem.dimension, themeKey: safetyTheme.key },
  ];
  downgradedPositioning.positioning[0]!.evidenceIds = [
    ...safetyTheme.evidenceIds,
  ];
  downgradedPositioning.positioning[0]!.priority = "P3";
  assert.equal(schema.safeParse(downgradedPositioning).success, false);

  const omitted = structuredClone(validVocPositioningOutput(scooterFacts));
  omitted.themeJudgments.splice(protectedIndex, 1);
  assert.equal(schema.safeParse(omitted).success, false);
});

test("published conclusions reject model-authored approval, profitability, arithmetic, and validation bypass narratives", () => {
  const schema = createVocPositioningOutputSchema(scooterFacts);
  const unsafe = structuredClone(validVocPositioningOutput(scooterFacts));
  Object.assign(unsafe.coreConclusion, {
    statement: "公司已批准立项，预计利润率80%，SellerSprite 60% + Sorftime 50%=110%",
  });
  Object.assign(unsafe.positioning[0]!, {
    conclusion: "无需成本、专利或合规验证即可量产",
  });
  assert.equal(schema.safeParse(unsafe).success, false);

  for (const bypass of [
    "预计利润率８０％，已经通过项目审批",
    "forecast margin eighty percent; greenlit for production",
    "可跳过成本／专利／合规核验直接投产",
  ]) {
    const variant = structuredClone(validVocPositioningOutput(scooterFacts));
    Object.assign(variant.coreConclusion, { statement: bypass });
    assert.equal(schema.safeParse(variant).success, false);
  }
});

test("protected safety themes have a deterministic non-downgradable role", () => {
  const schema = createVocPositioningOutputSchema(scooterFacts);
  const changed = structuredClone(validVocPositioningOutput(scooterFacts));
  const safety = scooterFacts.dimensions
    .flatMap((dimension) =>
      dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
    )
    .find(({ theme }) => theme.priority.safetyRule !== null);
  assert.ok(safety);
  const judgment = changed.themeJudgments.find(
    (candidate) =>
      candidate.dimension === safety.dimension &&
      candidate.themeKey === safety.theme.key,
  );
  assert.ok(judgment);
  judgment.role = "observe-or-pseudo-demand";
  assert.equal(schema.safeParse(changed).success, false);
});

test("formal VOC semantic violations expose only closed rule identifiers", () => {
  const schema = createVocPositioningOutputSchema(scooterFacts);
  const identity = structuredClone(validVocPositioningOutput(scooterFacts));
  identity.identity.factsDigest = "f".repeat(64);
  const identityResult = schema.safeParse(identity);
  assert.equal(identityResult.success, false);
  if (identityResult.success) return;
  const identityIssue = identityResult.error.issues.find(
    (issue) => issue.code === "custom" && issue.path.join(".") === "identity",
  ) as { params?: { ruleId?: unknown } } | undefined;
  assert.equal(identityIssue?.params?.ruleId, "voc-identity-mismatch");

  const changed = structuredClone(validVocPositioningOutput(scooterFacts));
  const safety = scooterFacts.dimensions
    .flatMap((dimension) =>
      dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
    )
    .find(({ theme }) => theme.priority.safetyRule !== null);
  assert.ok(safety);
  const judgment = changed.themeJudgments.find(
    (candidate) =>
      candidate.dimension === safety.dimension &&
      candidate.themeKey === safety.theme.key,
  );
  assert.ok(judgment);
  judgment.role = "observe-or-pseudo-demand";
  const roleResult = schema.safeParse(changed);
  assert.equal(roleResult.success, false);
  if (roleResult.success) return;
  const roleIssue = roleResult.error.issues.find(
    (issue) =>
      issue.code === "custom" && issue.path.at(-1) === "role",
  ) as { params?: { ruleId?: unknown } } | undefined;
  assert.equal(roleIssue?.params?.ruleId, "voc-protected-role-downgrade");
});

test("Skill input output contract reuses the same semantic rules as deterministic facts", () => {
  const input = buildVocPositioningInput(scooterFacts);
  const factsSchema = createVocPositioningOutputSchema(scooterFacts);
  const skillInputSchema = createVocPositioningOutputSchemaFromSkillInput(input);

  const cases: ReadonlyArray<readonly [
    string,
    (value: VocPositioningOutput) => void,
  ]> = [
    ["valid", () => {}],
    ["metric-forged", (value) => {
      value.themeJudgments[0]!.metrics[0]!.mentionPct = 99;
    }],
    ["evidence-forged", (value) => {
      value.coreConclusion.evidenceIds = ["f".repeat(64)];
    }],
    ["boundary-broken", (value) => {
      value.decisionBoundaries.marketSize = "requires-validation" as never;
    }],
    ["safety-downgraded", (value) => {
      const safety = value.themeJudgments.find(
        (judgment) => judgment.priority === "P0",
      );
      assert.ok(safety);
      safety.priority = "P3";
    }],
  ];

  for (const [label, mutate] of cases) {
    const candidate = validVocPositioningOutput(scooterFacts);
    mutate(candidate);
    assert.equal(
      skillInputSchema.safeParse(candidate).success,
      factsSchema.safeParse(candidate).success,
      label,
    );
  }
});

test("each protected action theme requires its own exactly scoped evidence", () => {
  const schema = createVocPositioningOutputSchema(scooterFacts);
  const changed = structuredClone(validVocPositioningOutput(scooterFacts));
  const safety = scooterFacts.dimensions
    .flatMap((dimension) =>
      dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
    )
    .find(({ theme }) => theme.priority.safetyRule !== null);
  assert.ok(safety);
  const unrelated = scooterFacts.dimensions
    .flatMap((dimension) =>
      dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
    )
    .find(
      ({ dimension, theme }) =>
        dimension !== safety.dimension || theme.key !== safety.theme.key,
    );
  assert.ok(unrelated);
  const unrelatedEvidence = unrelated.theme.evidenceIds[0];
  assert.ok(unrelatedEvidence);
  const action = changed.actions.find((candidate) =>
    candidate.themeRefs.some(
      (reference) =>
        reference.dimension === safety.dimension &&
        reference.themeKey === safety.theme.key,
    ),
  );
  assert.ok(action);
  action.themeRefs.push({
    dimension: unrelated.dimension,
    themeKey: unrelated.theme.key,
  });
  action.evidenceIds = [unrelatedEvidence];
  assert.equal(schema.safeParse(changed).success, false);
});

test("coverage and partial status must exactly preserve missing ranges", () => {
  const schema = createVocPositioningOutputSchema(lightingFacts);
  const changedMissing = structuredClone(validVocPositioningOutput(lightingFacts));
  changedMissing.coverage[0]!.missingAsins = [];
  assert.equal(schema.safeParse(changedMissing).success, false);

  const falseComplete = structuredClone(validVocPositioningOutput(lightingFacts));
  falseComplete.status = "complete";
  assert.equal(schema.safeParse(falseComplete).success, false);
});
