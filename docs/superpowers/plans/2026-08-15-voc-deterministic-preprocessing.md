# VOC Deterministic Preprocessing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure, strict, deterministic VOC snapshot preprocessor that preserves source-level denominator facts, applies shared synonym and P0-P3 rules, emits stable evidence, and keeps the legacy page output unchanged.

**Architecture:** Shared pure modules under `server/domain/voc/` own normalization, priority and evidence behavior. The strict preprocessor accepts only an integrity-checked `VocDataSnapshotRecord@1.0.0` and emits a closed, deeply frozen fact result; thin app adapters reuse the shared kernels while retaining the characterized legacy projection.

**Tech Stack:** TypeScript, Node.js test runner through `tsx`, Zod, existing canonical SHA-256 helper, vinext/React compatibility build.

## Global Constraints

- Do not add dependencies or modify `package-lock.json` or `pnpm-lock.yaml`.
- Do not modify migrations `server/db/migrations/0001` through `0005`.
- Do not modify `app/rufus-voc-data.ts`, `app/sorftime-review-analysis-data.ts`, or `app/seller-sprite-mcp-review-analysis-data.ts`.
- Do not add Skill/model calls, prompts, UI, E2E, login, PostgreSQL, collection, database connections, network, clocks, randomness or logging.
- The strict preprocessor accepts only `VocDataSnapshotRecordSchema@1.0.0`; unknown/missing numeric values remain `null`, never zero.
- Never add percentages across source, marketplace, cutoff, ASIN or denominator boundaries.
- Preserve target ASIN order only where 8.1 defines it; canonical-sort unordered facts with code-point tie-breaks.
- Safety/compliance/unusable/structural-failure/severe-damage/return themes fail closed to P0.
- Preserve legacy scooter and lighting visible output, including the characterized legacy `>=10` display differences.
- OpenSpec 8.2 is checked only after every requested gate passes; 8.3 and later remain unchanged.

---

### Task 1: Lock legacy scooter and lighting behavior

**Files:**
- Create: `tests/agent/voc-legacy-characterization.test.ts`

**Interfaces:**
- Consumes: `refreshedCatalog`, `buildVocDevelopmentSummary`, `buildProductLaunchAnalysis`, `canonicalJsonSha256`.
- Produces: two stable characterization digests and readable assertions for theme order, mention percentages, visible priority strings, merged P0-P3 rows and opportunity tiers.

- [ ] **Step 1: Add the characterization projection helper and fixtures**

```ts
function legacyProjection(products: typeof refreshedCatalog) {
  const summary = buildVocDevelopmentSummary(
    products.map(({ asin, brand, productFamily }) => ({ asin, brand, productFamily })),
  );
  const launch = buildProductLaunchAnalysis(products);
  return {
    summary,
    negativePriorityRows: launch.negativePriorityRows,
    positivePriorityRows: launch.positivePriorityRows,
    opportunities: launch.opportunities.map(
      ({ id, name, tier, priority, priorityScore, demandEvidence, recommendation }) =>
        ({ id, name, tier, priority, priorityScore, demandEvidence, recommendation }),
    ),
    mergedThemes: launch.vocPositioning.mergedThemes,
  };
}

const EXPECTED = {
  scooter: "7d5a2eb92be3337da4c2f52afd0b0bd4ebeead900f20680fc37f50306412ea11",
  lighting: "eb627c95c086bb4f3c93ca950442d4313d5d3fd46ac531361a9615d6dad92095",
} as const;
```

Assert the known top scooter negative `耐用性 / 结构强度` at `54.30417869243319`, top lighting negative at `82.08041958041957`, current positive text `是 · P0 必须保留并强化`, current negative text `是 · 建议 P0/P1 解决`, merged priority rows and family opportunity tier order.

- [ ] **Step 2: Run the characterization test against the baseline**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-legacy-characterization.test.ts`

Expected: PASS, 2 tests, proving the digests describe the pre-refactor code.

- [ ] **Step 3: Commit the test-only characterization baseline**

```powershell
git add -- tests/agent/voc-legacy-characterization.test.ts
git diff --cached --check
git commit -m "test: characterize legacy VOC outputs"
```

### Task 2: Extract and reuse normalization, legacy summary and priority kernels

**Files:**
- Create: `server/domain/voc/theme-normalization.ts`
- Create: `server/domain/voc/priority-rules.ts`
- Create: `server/domain/voc/legacy-summary.ts`
- Create: `tests/agent/voc-domain-rules.test.ts`
- Modify: `app/voc-theme-merge.ts`
- Modify: `app/voc-development-summary.ts`
- Modify: `app/voc-positioning.ts`

**Interfaces:**
- Consumes: explicit product descriptors, Alexa/review record maps, and source labels supplied by the app adapter.
- Produces: `VOC_DIMENSIONS`, `canonicalTheme`, `parseAlexaThemeObservation`, `compareCodePoints`, `classifyVocPriority`, `priorityRank`, `buildLegacyVocDevelopmentSummary`, `hasLegacyVocDevelopmentData`.

- [ ] **Step 1: Write failing normalization and priority tests**

Cover current ordered synonym rules for scooter/lighting/generic, whitespace/case/Chinese/English, explicit percentage precedence, mention-count derivation, zero denominator returning `null`, exactly 5, exactly 10, greater than 10, all-low, unknown and low-frequency safety.

```ts
assert.deepEqual(canonicalTheme("  LEAN-to-steer  ", "negatives", "scooter"), {
  key: "lean-to-steer转向体验",
  label: "Lean-to-steer 转向体验",
});
assert.deepEqual(parseAlexaThemeObservation("【断裂】3 条", "negatives", 0), {
  rawLabel: "断裂",
  mentionCount: 3,
  sampleCount: 0,
  mentionPct: null,
  basis: "mention-count",
});
assert.equal(classifyVocPriority([{ dimension: "negatives", mentionPct: 10, label: "普通问题" }]).level, "P2");
assert.equal(classifyVocPriority([{ dimension: "negatives", mentionPct: 0.1, label: "刹车断裂" }]).level, "P0");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-domain-rules.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/domain/voc/theme-normalization`.

- [ ] **Step 3: Move the current normalization and legacy aggregation into shared pure modules**

`theme-normalization.ts` exports exact closed types:

```ts
export type VocDimension = "attention" | "positives" | "negatives" | "unmet" | "audiences" | "scenarios" | "motives";
export type VocProductFamily = "scooter" | "lighting" | "generic";
export type AlexaThemeObservation = Readonly<{
  rawLabel: string;
  mentionCount: number | null;
  sampleCount: number | null;
  mentionPct: number | null;
  basis: "explicit-percentage" | "mention-count" | "presence-only";
}>;
```

Move `MERGE_RULES` without changing rule order or content. Replace locale collation with `compareCodePoints` only in strict paths; `legacy-summary.ts` retains the current `localeCompare("zh-CN")` compatibility sort. Parameterize legacy data instead of importing generated files.

- [ ] **Step 4: Implement the strict shared priority classifier**

```ts
export type VocPriorityLevel = "P0" | "P1" | "P2" | "P3" | "unknown";
export type VocPriorityFact = Readonly<{
  dimension: VocDimension;
  mentionPct: number | null;
  label: string;
}>;
export type VocPriorityDecision = Readonly<{
  level: VocPriorityLevel;
  reasons: readonly string[];
  cannotDowngradeReason: string | null;
  safetyRule: "safety" | "compliance" | "unusable" | "structural-failure" | "severe-damage" | "concentrated-return" | null;
}>;
```

Safety matching uses a closed constant. Classification evaluates every independent fact, never sums percentages, treats exactly 10 as P2, and sorts reasons before returning a deeply frozen value.

- [ ] **Step 5: Convert app modules to thin adapters**

`app/voc-theme-merge.ts` re-exports the shared `canonicalTheme`. `app/voc-development-summary.ts` supplies `rufusVocData`, `rufusVocDimensions` and `sorftimeReviewAnalysisData` to `buildLegacyVocDevelopmentSummary`. `app/voc-positioning.ts` delegates threshold decisions and priority rank to `classifyVocPriority`, while mapping the strict result to the existing Chinese role/judgment strings so characterization output stays byte-stable.

- [ ] **Step 6: Verify GREEN and legacy equivalence**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-domain-rules.test.ts tests/agent/voc-legacy-characterization.test.ts`

Expected: PASS; both characterization digests remain unchanged.

- [ ] **Step 7: Commit the shared kernel extraction**

```powershell
git add -- server/domain/voc app/voc-theme-merge.ts app/voc-development-summary.ts app/voc-positioning.ts tests/agent/voc-domain-rules.test.ts
git diff --cached --check
git commit -m "refactor: share deterministic VOC rules"
```

### Task 3: Build the strict versioned snapshot preprocessor

**Files:**
- Create: `server/domain/voc/preprocess-voc-snapshot.ts`
- Create: `tests/agent/voc-deterministic-preprocessing.test.ts`

**Interfaces:**
- Consumes: `preprocessVocSnapshot(input: unknown)` where input must parse and pass integrity as `VocDataSnapshotRecord@1.0.0`.
- Produces: `VocDeterministicPreprocessingResultSchema`, `VocDeterministicPreprocessingResult`, `preprocessVocSnapshot`.

- [ ] **Step 1: Write failing full-fixture contract tests**

Use `RepositoryVocSourceReader` to obtain real scooter and lighting candidates and wrap them in deterministic UUID/created-at record metadata. Assert ordinary source record facts, partial lighting availability, independent Sorftime/SellerSprite metrics for the same theme, fixed seven-dimension order, evidence resolution and output schema closure.

```ts
const result = preprocessVocSnapshot(snapshotRecord);
assert.equal(result.schemaVersion, "1.0.0");
assert.equal(result.kind, "voc-deterministic-preprocessing");
assert.deepEqual(result.snapshot.asins, snapshotRecord.asins);
assert.deepEqual(VocDeterministicPreprocessingResultSchema.parse(result), result);
assert.equal(result.evidenceIndex.every(e => e.snapshotId === snapshotRecord.id), true);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-deterministic-preprocessing.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `preprocess-voc-snapshot`.

- [ ] **Step 3: Define the closed result schema**

Use nested `z.strictObject` schemas. All nullable facts are required keys with `null`, not omitted or defaulted. Define fixed enums for source ID, availability, comparability, basis, priority and safety rule. Export only the schema, inferred result type and preprocessing function.

The exact top-level shape is:

```ts
{
  schemaVersion: "1.0.0";
  kind: "voc-deterministic-preprocessing";
  snapshot: { id; runId; contentHash; marketplace; asins; dataCutoffAt };
  availability: SourceAvailability[];
  dimensions: DimensionFacts[];
  evidenceIndex: EvidenceFact[];
  factsDigest: string;
}
```

- [ ] **Step 4: Implement source traversal and independent metrics**

First call `VocDataSnapshotRecordSchema.parse` and `assertVocDataSnapshotRecordIntegrity`. Resolve source provenance only by the closed references in `VOC_SOURCE_REFERENCES`. Derive family only from validated review records for the same ASIN; conflicts or absence use `generic`.

Alexa uses `parseAlexaThemeObservation`; review records preserve `sharePct` and `sampledReviews` and set `mentionCount: null`. Never reconstruct a rounded count. Each metric is record-scoped and carries `comparability: "comparable"` only to itself.

- [ ] **Step 5: Implement canonical priority, evidence and digest**

Evidence record keys hash `{snapshotId, sourceId, sourceType, reference, marketplace, asin, family, capturedAt}`. Evidence IDs hash that record identity plus `{dimension, canonicalThemeKey, rawLabel, basis, mentionCount, sampleCount, mentionPct}`. Deduplicate identical evidence, sort metrics/evidence with fixed source order, target ASIN order and code-point text order, and validate every theme evidence ID. Compute `factsDigest` with `canonicalJsonSha256` over only whitelist facts; exclude the upstream order-sensitive `snapshot.contentHash` and source checksums while retaining both as provenance.

- [ ] **Step 6: Verify GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-deterministic-preprocessing.test.ts`

Expected: PASS for the real scooter and lighting fixtures.

- [ ] **Step 7: Commit the strict preprocessor**

```powershell
git add -- server/domain/voc/preprocess-voc-snapshot.ts tests/agent/voc-deterministic-preprocessing.test.ts
git diff --cached --check
git commit -m "feat: preprocess immutable VOC snapshots"
```

### Task 4: Harden edge cases, determinism, evidence and immutability

**Files:**
- Modify: `tests/agent/voc-deterministic-preprocessing.test.ts`
- Modify: `server/domain/voc/preprocess-voc-snapshot.ts`
- Modify: `server/domain/voc/priority-rules.ts`
- Modify: `server/domain/voc/theme-normalization.ts`

**Interfaces:**
- Consumes/produces: same public interfaces as Tasks 2 and 3; no new public surface.

- [ ] **Step 1: Add failing table-driven edge tests**

Build strict candidates with `buildVocSnapshotCandidate` and cover:

- source absence and target partial coverage;
- three-source conflicting percentages without a combined percentage;
- duplicate synonyms, case, whitespace, Chinese and English;
- zero Alexa denominator and presence-only statistics remaining null;
- schema unknown fields and `NaN`, `Infinity`, negative/out-of-range percentages;
- exactly 5, exactly 10, `10.01`, ties and input block/row permutations;
- safety low frequency, safety unknown frequency and positive/negative source conflict remaining P0;
- duplicate evidence dedupe, no dangling IDs and all target/source/snapshot bindings;
- caller input unchanged, deep output freeze, repeated equality and stable digest;
- result unknown-field rejection.

- [ ] **Step 2: Run the focused test and verify RED for each new behavior batch**

Run after each group: `npx tsx --conditions=react-server --test tests/agent/voc-deterministic-preprocessing.test.ts`

Expected: at least one assertion FAIL for the newly introduced case before changing production code; record the expected failure in the execution notes.

- [ ] **Step 3: Implement the minimum hardening for each batch**

Reject invalid input at the 8.1 schema boundary. Use `null` for unknowns, fixed source and dimension arrays for availability, semantic-key dedupe for identical rows, canonical sorting for unordered arrays, and `deepFreeze` only after final schema/digest validation. Do not catch validation errors into a partial result.

- [ ] **Step 4: Add ordinary Node import isolation test**

Spawn the existing Node executable with `--import tsx` and import only `server/domain/voc/preprocess-voc-snapshot.ts`. Assert exit code 0 and exported function/schema names; scan the module dependency text to ensure it does not import React, vinext, browser, MCP, database, Cursor/Codex, network, clock or random facilities.

- [ ] **Step 5: Verify focused tests and legacy characterization**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-domain-rules.test.ts tests/agent/voc-deterministic-preprocessing.test.ts tests/agent/voc-legacy-characterization.test.ts`

Expected: all focused tests pass and both legacy digests remain exact.

- [ ] **Step 6: Commit the hardening**

```powershell
git add -- server/domain/voc tests/agent/voc-deterministic-preprocessing.test.ts
git diff --cached --check
git commit -m "test: harden deterministic VOC facts"
```

### Task 5: Complete OpenSpec 8.2 and run repository gates

**Files:**
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`
- Preserve with zero diff: `package-lock.json`, `pnpm-lock.yaml`, `server/db/migrations/0001_*` through `0005_*`, `app/rufus-voc-data.ts`, `app/sorftime-review-analysis-data.ts`, `app/seller-sprite-mcp-review-analysis-data.ts`.

**Interfaces:**
- Consumes: all implementation and tests.
- Produces: checked OpenSpec task 8.2 only after fresh gate evidence.

- [ ] **Step 1: Run focused and full tests before checking the task**

```powershell
npx tsx --conditions=react-server --test tests/agent/voc-domain-rules.test.ts tests/agent/voc-deterministic-preprocessing.test.ts tests/agent/voc-legacy-characterization.test.ts
npm run test:agent
npm run skills:validate
npm run lint
npx openspec validate build-standalone-agent-workflow --strict
npm test
```

Expected: focused PASS; agent suite has zero failures and one opt-in skip; skill validation PASS; lint has 0 errors and exactly the 26 baseline warnings; OpenSpec strict PASS; rendered HTML has 2/2 pass.

- [ ] **Step 2: Run TypeScript diagnostic differential**

Capture the baseline diagnostics from `12b854f30b50f5d3afc851e3ea9fbc8b3722f8f9` without modifying the current worktree, capture feature diagnostics, normalize paths/line drift, and compare exact diagnostic identities.

Expected: base 17, feature 17, new 0.

- [ ] **Step 3: Verify protected files and scope**

```powershell
git diff --check 12b854f30b50f5d3afc851e3ea9fbc8b3722f8f9...HEAD
git diff --exit-code 12b854f30b50f5d3afc851e3ea9fbc8b3722f8f9 -- package-lock.json pnpm-lock.yaml server/db/migrations app/rufus-voc-data.ts app/sorftime-review-analysis-data.ts app/seller-sprite-mcp-review-analysis-data.ts
git status --short
```

Expected: no whitespace errors, protected diff empty, only intended OpenSpec file remains before the final commit.

- [ ] **Step 4: Mark only 8.2 complete**

Change exactly:

```md
- [x] 8.2 抽取并复用 VOC 主题、占比、P0 安全规则和证据索引等确定性 TypeScript 预处理，建立与旧逻辑一致性测试
```

Keep 8.3, 8.4 and 8.5 unchecked.

- [ ] **Step 5: Validate OpenSpec and commit completion**

```powershell
npx openspec validate build-standalone-agent-workflow --strict
git add -- openspec/changes/build-standalone-agent-workflow/tasks.md
git diff --cached --check
git commit -m "docs(openspec): complete deterministic VOC preprocessing"
```

- [ ] **Step 6: Run final clean verification**

Freshly rerun the full gate list from Step 1, TypeScript differential, protected-file diff, `git diff --check`, `git status --short --branch`, and `git log --oneline 12b854f..HEAD`.

Expected: every gate meets the required count, the worktree is clean on `feat/voc-deterministic-preprocessing`, and no push/merge/rebase/amend/stash operation occurred.

## Review-fix addendum: deterministic labels, semantic closure and provenance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline and superpowers:test-driven-development for every production change. The OpenSpec 8.2 checkbox remains unchecked until Task 10.

**Goal:** Resolve review findings I1/I2 and B1-B3 plus Alexa header and whitelist-digest coverage without changing legacy projection behavior.

**Architecture:** Keep generation and the public result contract in `server/domain/voc/preprocess-voc-snapshot.ts`, but replace arrival-order state with canonical representatives and expose one shape-plus-semantic result parser. Preserve 8.1 content/source hashes as provenance while computing `factsDigest` only from 8.3-whitelisted facts.

**Tech Stack:** TypeScript, Node test runner, Zod strict schemas/refinements, canonical SHA-256 helpers already in the repository.

### Global review-fix constraints

- Use the existing worktree and branch; do not amend, rebase, push, merge or touch stash.
- Add no dependency and do not modify lock files, migrations 0001-0005 or generated VOC data.
- Alexa always uses `generic`; review family comes only from the same record's `family ?? generic`.
- Safety escalation scans only `negatives | unmet | attention` problem facts.
- `factsDigest` excludes 8.1 `contentHash` and source checksums; future identity is `(snapshot.id, snapshot.contentHash, factsDigest)`.
- Legacy characterization output and its two known display-boundary differences remain exact.

---

### Task 6: Canonical display representative and semantic Alexa headers

**Files:**
- Modify: `tests/agent/voc-deterministic-preprocessing.test.ts`
- Modify: `server/domain/voc/preprocess-voc-snapshot.ts`
- Modify: `server/domain/voc/theme-normalization.ts`

**Interfaces:**
- Produces: `isAlexaDimensionHeader(line, dimension)` and arrival-order-independent theme labels.
- Preserves: `canonicalTheme(label, dimension, family)` behavior for every existing legacy caller.

- [ ] **Step 1: Write collision and header permutation tests**

Add all six permutations of three rows whose cleaned labels are `Foo Bar`, `foobar`, and `Foo   Bar`, plus known `Durability`/`耐用性` aliases. Assert one canonical key, code-point-minimum normalized display label, stable dimensions/evidence and equal `factsDigest` for each permutation. For audiences, scenarios and motives, permute the semantic header among two child rows and assert the header never becomes a fact and no child disappears.

```ts
assert.deepEqual(
  outputs.map((output) => dimension(output, "negatives").themes),
  outputs.map(() => dimension(outputs[0]!, "negatives").themes),
);
assert.equal(new Set(outputs.map((output) => output.factsDigest)).size, 1);
assert.equal(theme.label, "Foo Bar");
```

- [ ] **Step 2: Run RED**

Run: `node --import tsx --test --test-name-pattern="canonical display|semantic Alexa header" tests/agent/voc-deterministic-preprocessing.test.ts`

Expected: collision permutations differ in label/digest and header permutations misclassify a child/header.

- [ ] **Step 3: Implement deterministic representatives and headers**

Add a closed helper:

```ts
export function isAlexaDimensionHeader(line: string, dimension: VocDimension) {
  const marker = line.split("｜", 1)[0]?.trim();
  return (
    (dimension === "audiences" && marker === "人群分类") ||
    (dimension === "scenarios" && marker === "场景") ||
    (dimension === "motives" && marker === "动机")
  );
}
```

Use it without inspecting array index. When a canonical key already exists, replace `theme.label` only when `compareCodePoints(normalized.label, theme.label) < 0`. Keep the existing metric/evidence sort and add any missing full-field tie-break before the final ID.

- [ ] **Step 4: Run GREEN and commit**

Run the focused file and legacy characterization. Expected: all pass and legacy digests unchanged.

```powershell
git add -- server/domain/voc/theme-normalization.ts server/domain/voc/preprocess-voc-snapshot.ts tests/agent/voc-deterministic-preprocessing.test.ts
git diff --cached --check
git commit -m "fix: stabilize VOC theme representatives"
```

### Task 7: Scope safety escalation to problem dimensions

**Files:**
- Modify: `tests/agent/voc-domain-rules.test.ts`
- Modify: `server/domain/voc/priority-rules.ts`

**Interfaces:**
- Produces: safety matching only for the closed `negatives | unmet | attention` set.
- Preserves: published numeric thresholds and legacy display helper strings.

- [ ] **Step 1: Write the safety polarity matrix**

Assert positive 20% `安全稳定的刹车设计` is P1, and unknown motives/audiences/scenarios containing safety words remain unknown. Assert low-frequency or unknown negative, unmet and attention problem labels still return P0 with `cannotDowngradeReason`.

```ts
assert.equal(classifyVocPriority([{ dimension: "positives", mentionPct: 20, label: "安全稳定的刹车设计" }]).level, "P1");
assert.equal(classifyVocPriority([{ dimension: "motives", mentionPct: null, label: "夜间安全骑行" }]).level, "unknown");
assert.equal(classifyVocPriority([{ dimension: "unmet", mentionPct: null, label: "刹车失效" }]).level, "P0");
```

- [ ] **Step 2: Run RED**

Run: `node --import tsx --test --test-name-pattern="problem dimensions" tests/agent/voc-domain-rules.test.ts`

Expected: positive/motive cases incorrectly return P0.

- [ ] **Step 3: Implement the closed problem-dimension filter**

```ts
const SAFETY_PROBLEM_DIMENSIONS = new Set<VocDimension>([
  "negatives",
  "unmet",
  "attention",
]);
```

Filter facts by this set before regex scanning; do not change the numeric decision set or legacy compatibility functions.

- [ ] **Step 4: Run GREEN and commit**

```powershell
git add -- server/domain/voc/priority-rules.ts tests/agent/voc-domain-rules.test.ts
git diff --cached --check
git commit -m "fix: scope VOC safety escalation"
```

### Task 8: Preserve record-local family and capture time

**Files:**
- Modify: `tests/agent/voc-deterministic-preprocessing.test.ts`
- Modify: `server/domain/voc/preprocess-voc-snapshot.ts`

**Interfaces:**
- Consumes: `normalizeRepositoryDateOnlyUtc` from `server/data/voc-data-snapshot.ts`.
- Produces: metric/evidence `sourceType`, `family`, canonical record `capturedAt`, and source-presence-invariant evidence identities.

- [ ] **Step 1: Write source-presence and mixed-time tests**

Build a Sorftime record with no family and compare its source-specific facts with snapshots that add/remove SellerSprite `scooter` or conflicting `lighting` family records for the same ASIN. Repeat for Alexa. Assert existing source metrics/evidence do not change. Build two review records fetched on `2026-08-01` and `2026-08-10` under a source captured at `2026-08-10T23:59:59.999Z`; assert per-record times are their UTC day ends while availability keeps the source maximum. Assert an output time in an offset spelling and a record time after source/cutoff are rejected.

- [ ] **Step 2: Run RED**

Run: `node --import tsx --test --test-name-pattern="source presence|record capture time" tests/agent/voc-deterministic-preprocessing.test.ts`

Expected: adding another family recanonicalizes existing metrics and both review records inherit the source maximum.

- [ ] **Step 3: Implement record-local provenance**

Remove `resolveFamilies`. Pass `generic` for Alexa and `record.family ?? "generic"` plus `normalizeRepositoryDateOnlyUtc(record.fetchedAt)` for each review record. Add `sourceType` and `family` to metric/evidence schemas and include `capturedAt`, source type and family in record/evidence hash tuples. Compute theme family from its metric families only.

```ts
const recordCapturedAt = normalizeRepositoryDateOnlyUtc(record.fetchedAt);
addMetric({
  snapshot,
  config,
  capturedAt: recordCapturedAt,
  family: record.family ?? "generic",
  // existing metric fields
});
```

- [ ] **Step 4: Run GREEN and commit**

```powershell
git add -- server/domain/voc/preprocess-voc-snapshot.ts tests/agent/voc-deterministic-preprocessing.test.ts
git diff --cached --check
git commit -m "fix: isolate VOC record provenance"
```

### Task 9: Enforce serialized-result semantic integrity and whitelist digest scope

**Files:**
- Modify: `tests/agent/voc-deterministic-preprocessing.test.ts`
- Modify: `server/domain/voc/preprocess-voc-snapshot.ts`
- Modify: `docs/superpowers/specs/2026-08-15-voc-deterministic-preprocessing-design.md` only if implementation evidence reveals a contradiction.

**Interfaces:**
- Produces: `VocDeterministicPreprocessingResultSchema` with semantic refinement, `parseVocDeterministicPreprocessingResult(input)`, `factsDigest`, source checksum provenance and deep-frozen JSON round trips.
- Removes before integration: ambiguous `canonicalDigest` output name.

- [ ] **Step 1: Write the serialized mutation matrix**

Start every mutation from `JSON.parse(JSON.stringify(preprocessVocSnapshot(snapshot)))`. Assert public `safeParse` rejects dangling and duplicate evidence IDs; orphan evidence; changed evidence ASIN/source/type/reference/marketplace/time/record key/dimension/key/family/raw label/basis; duplicate sources/dimensions/themes/metrics; theme evidence IDs that do not exactly equal metrics; wrong label/metric/priority/order; and stale `factsDigest`. Assert `parseVocDeterministicPreprocessingResult(JSON.parse(JSON.stringify(result)))` succeeds and deeply freezes all levels.

```ts
for (const [name, mutate] of invalidResultMutations) {
  const serialized = JSON.parse(JSON.stringify(result));
  mutate(serialized);
  assert.equal(VocDeterministicPreprocessingResultSchema.safeParse(serialized).success, false, name);
}
```

- [ ] **Step 2: Run semantic validator RED**

Run: `node --import tsx --test --test-name-pattern="serialized result integrity" tests/agent/voc-deterministic-preprocessing.test.ts`

Expected: current shape-only schema accepts dangling, cross-boundary and stale-digest mutations; public parse export is absent.

- [ ] **Step 3: Write provenance and 8.1 coverage RED tests**

Rebuild valid 8.1 snapshots while changing only review block label/reason and Alexa title/rating/prompt/conclusion. Assert 8.1 content/source hashes change, `factsDigest` remains equal, excluded strings are absent from serialized results, and provenance hashes remain present. Separately change fetchedAt, block key, row label/share or record family and assert `factsDigest` changes.

- [ ] **Step 4: Implement one public semantic parse boundary**

Keep a private strict shape schema. Export a schema refined by `assertVocDeterministicResultIntegrity`, transform successful results with `deepFreeze`, and export the named parse helper:

```ts
export const VocDeterministicPreprocessingResultSchema =
  VocDeterministicPreprocessingResultShapeSchema
    .superRefine((value, context) => addIntegrityIssues(value, context))
    .transform((value) => deepFreeze(value));

export function parseVocDeterministicPreprocessingResult(input: unknown) {
  return VocDeterministicPreprocessingResultSchema.parse(input);
}
```

The integrity routine recomputes `factsDigest` after omitting only `snapshot.contentHash` and availability `sourceChecksum`; verifies the exact closed source/dimension sets and canonical order; recomputes all record/evidence IDs; validates canonical UTC times and `recordTime <= sourceTime <= cutoff`; binds source/type/reference/marketplace/checksum presence, target ASIN and snapshot IDs; recomputes canonical key/label/family and priority; enforces one-to-one metric/evidence closure; and rejects duplicates/orphans/dangling facts.

- [ ] **Step 5: Run GREEN, ordinary Node import and all focused tests**

Run:

```powershell
node --import tsx --test tests/agent/voc-domain-rules.test.ts tests/agent/voc-deterministic-preprocessing.test.ts tests/agent/voc-legacy-characterization.test.ts
node --import tsx -e "import('./server/domain/voc/preprocess-voc-snapshot.ts').then(m=>{if(typeof m.parseVocDeterministicPreprocessingResult!=='function')process.exit(2)})"
```

Expected: all focused tests pass; legal JSON parse is frozen; no browser/database/network dependency is introduced.

- [ ] **Step 6: Commit semantic closure**

```powershell
git add -- server/domain/voc/preprocess-voc-snapshot.ts tests/agent/voc-deterministic-preprocessing.test.ts docs/superpowers/specs/2026-08-15-voc-deterministic-preprocessing-design.md
git diff --cached --check
git commit -m "fix: validate serialized VOC facts"
```

### Task 10: Requalify OpenSpec 8.2 after review fixes

**Files:**
- Modify last: `openspec/changes/build-standalone-agent-workflow/tasks.md`
- Preserve with zero diff: lock files, migrations 0001-0005 and all three generated data files.

- [ ] **Step 1: Run pre-checkbox gates**

Run focused tests, `npm run test:agent`, `npm run skills:validate`, `npm run lint`, OpenSpec strict and `npm test`. Expected: zero failures, one opt-in Agent skip, 0 lint errors/26 baseline warnings and 2/2 rendered tests.

- [ ] **Step 2: Run ordinary-clone TypeScript differential**

Use a new fixed system Temp ordinary git clone checked out at exact base `12b854f30b50f5d3afc851e3ea9fbc8b3722f8f9`, install its own dependencies, and run the same `npx tsc --noEmit --incremental false --pretty false` in base and feature directories. Normalize by relative file/line/column/TS code. Expected: base 17, feature 17, new 0, missing 0.

- [ ] **Step 3: Verify protected files and then mark only 8.2**

Require empty protected diff, `git diff --check`, OpenSpec strict and intended scope. Change only 8.2 to `[x]`; leave 8.3+ unchecked; commit `docs(openspec): requalify deterministic VOC preprocessing`.

- [ ] **Step 4: Fresh final verification and branch preservation**

Repeat focused/full/lint/Skill/OpenSpec/npm/TypeScript/protected gates after the final commit. Require clean `feat/voc-deterministic-preprocessing`; do not merge, push or delete the worktree.

### Task 11: Bound safety-rule English tokens after second business review

**Files:**
- Modify first: `openspec/changes/build-standalone-agent-workflow/tasks.md`
- Modify: `tests/agent/voc-domain-rules.test.ts`
- Modify: `tests/agent/voc-deterministic-preprocessing.test.ts`
- Modify: `server/domain/voc/priority-rules.ts`
- Modify: `server/domain/voc/preprocess-voc-snapshot.ts`
- Modify: `docs/superpowers/specs/2026-08-15-voc-deterministic-preprocessing-design.md`

- [ ] **Step 1: Reopen 8.2 and record the review fix**

Return OpenSpec 8.2 to unchecked before implementation. Audit every English safety-rule alternative for substring matching while preserving the closed problem-dimension gate and the legacy projection. Audit every public result identity collection for uniqueness enforcement.

- [ ] **Step 2: Write and observe focused RED tests**

Add structural-failure false positives for `breakfast`, `snapshot`, `snapdragon`, and non-structural `breakdown`; add true inflections for `broke`, `broken`, `breaking`, `snapped`, `snaps`, and the exact `structural failure` phrase. Add representative boundary tests for adjacent English safety-rule families. Mutate serialized target ASINs from unique `[A, B, C]` to `[A, B, B]`, synchronize derived `missingAsins` and `factsDigest`, and require public parsing to fail before evidence, denominator, or target-count semantics become ambiguous.

- [ ] **Step 3: Implement the closed token grammar and run GREEN**

Use word boundaries plus explicit accepted inflections/phrases for English tokens. Keep Chinese tokens unchanged. Add an integrity invariant that preserves target order but requires `Set(asins).size === asins.length`; retain the existing exact-order/uniqueness checks for sources, dimensions, denominator ASINs, theme keys, metrics, evidence IDs, and derived missing ASINs. Run the focused domain, preprocessing, and legacy characterization suites and commit the tested fixes without amending prior commits.

- [ ] **Step 4: Requalify only after the complete gates**

Run focused tests, the full Agent suite, Skill validation, lint, OpenSpec strict, rendered tests, ordinary-clone TypeScript differential, protected-file checks, and `git diff --check`. Only then restore 8.2 to checked, keep 8.3+ unchecked, commit, and repeat fresh final verification.
