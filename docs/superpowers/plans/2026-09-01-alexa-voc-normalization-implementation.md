# Alexa VOC Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn authenticated Alexa report imports into one strict seven-dimension VOC contract, sending only incomplete or invalid parser results through an encrypted, per-ASIN audited normalization stage before the formal `amazon-voc-insight` report chain consumes a committed revision.

**Architecture:** The import service first validates authorization and runs the deterministic parser against `AlexaVocMatrixRecordSchema`; only a complete latest-Skill-format result writes the canonical revision directly. A fallback persists an immutable encrypted normalization-input snapshot and wakes one run-level `alexa-voc-normalization` stage; its worker executes the repository-vendored Alexa skill separately for every snapshot, commits only strict successful revisions, and then wakes the existing `voc-positioning` stage after its definition is switched to the formal `amazon-voc-insight` skill. Status is derived per project, ASIN, fingerprint, snapshot, agent run, and revision; raw Alexa text and unvalidated provider output never leave the authorized worker.

**Tech Stack:** TypeScript, Zod, Fastify, Node `node:test`, SQLite, PostgreSQL, `SkillRegistry`, `SkillRunner`, `AuditedSkillRunner`, existing AES-256-GCM manual Alexa cipher.

## Global Constraints

- Vendor the current approved source package from `C:\Users\EDY\Desktop\alexa-for-shopping-voc\` into `skills-src/alexa-for-shopping-voc\`; production opens only `skills-src`, and no execution path may name or load `voc-listing-optimizer`. Preserve the supplied rules and examples; the only permitted source adaptation is moving the two linked Markdown files under `references/` and updating those relative links so the existing registry can hash and authorize them.
- Vendor the approved `amazon-voc-insight` skill under `skills-src/amazon-voc-insight\` and register it in the formal `voc-positioning` chain. Its output contract must faithfully contain the Skill's seven ordered business sections and a strictly validated `VocPositioningOutput` projection; the publisher stores the combined result while `product-definition` consumes only the projection. `.agents/skills` visibility is not runtime registration.
- The free path is legal only if all seven dimensions are nonempty and the new `AlexaVocMatrixRecordSchema` strictly succeeds. That schema mirrors the latest supplied Skill: seven matrix-string arrays plus `captureStatus: "dialog"` and `alexaReport`; ASIN routing is added by the service when constructing the existing `ManualAlexaVocNormalizedRecord`. Missing, empty, unknown, incorrectly typed, header-invalid, or matrix-format-invalid data must take the normalization path.
- Do not add an Alexa/VOC business table. Reuse `manual_alexa_voc_revisions`, immutable `data_snapshots`, `agent_runs`, `run_stages`, and the existing report store.
- Add `alexa-voc-normalization` to `StageNameSchema`, agent definitions, orchestrator handling, and both PostgreSQL and SQLite `run_stages.stage` checks. In the same two migrations, add `alexa-voc-normalization-input` to `data_snapshots.snapshot_kind` and `artifact_kind`, update their consistency/insert triggers, and retain every existing row/index/constraint. One run has one such stage (`UNIQUE (run_id, stage)`); it can process many ASIN snapshots.
- Require and authorize `projectId` at every import/list/poll boundary. A same-organization completed revision may be reused only for an identical complete fingerprint; all job, budget, pending, and failure state stays scoped to the requesting project/run. Cross-organization reuse is forbidden.
- A fingerprint includes raw-text SHA-256, parser id/version, Alexa skill id/version/contentHash, strict schema digest, and provider/model plus output-affecting runner settings. Pending and failed executions never count as a cache hit.
- Fallback input is an immutable, dedicated encrypted envelope snapshot with only hash, byte length, project/run/ASIN routing data, fingerprint, and cipher envelope. Encryption reuses the existing keyring/AES-256-GCM primitive through a dedicated normalization-input cipher and `alexa-voc-normalization-input/v1` AAD bound to organization/project/run/snapshot/marketplace/ASIN/schema; it must never synthesize a future manual revision identity. No raw text or raw model response may appear in logs, errors, traces, agent-run summaries, API responses, polling payloads, normal snapshots, or exports.
- A single ASIN failure is terminal only for that ASIN. Continue remaining snapshots, mark the stage succeeded when all queued inputs are terminal, and leave SIF, keywords, Sorftime, images, history, other ASIN cards, and other pages usable.

---

## File map

| Path | Responsibility |
| --- | --- |
| `skills-src/alexa-for-shopping-voc/` | Approved, hash-verified Alexa normalizer package used exclusively by `SkillRegistry`. |
| `skills-src/amazon-voc-insight/` | Approved downstream VOC insight package used by the formal `voc-positioning` agent definition. |
| `shared/agent-contracts.ts` and `server/domain/voc/alexa-voc-normalization-contracts.ts` | Import/status wire contracts, stage enum, and strict latest-Skill matrix input/output contracts. |
| `server/domain/voc/amazon-voc-insight-contracts.ts` | Strict seven-section business report plus backward-compatible VOC positioning projection. |
| `server/skills/agent-definitions.ts` | Binds `alexa-voc-normalization` to the Alexa skill and `voc-positioning` to `amazon-voc-insight`. |
| `server/db/migrations/0022_alexa_voc_normalization_stage.sql` | SQLite `run_stages` and `data_snapshots` kind/trigger upgrades with existing rows, indexes, and constraints retained. |
| `server/db/migrations/postgres/0022_alexa_voc_normalization_stage.sql` | PostgreSQL stage, snapshot/artifact kind, and consistency-trigger upgrades. |
| `server/security/alexa-voc-normalization-input-cipher.ts` | Dedicated normalization-input AAD over the existing keyring/AES-256-GCM primitive. |
| `server/services/manual-alexa-voc-service.ts` | Authorized strict fast path, encrypted fallback snapshot, run-stage/job enqueue, reuse lookup, and redacted status queries. |
| `server/services/alexa-voc-normalization-execution-service.ts` | Per-snapshot fingerprint validation, decrypt-run-validate-commit flow, and downstream wake after the PG revision commit. |
| `server/runtime/alexa-voc-normalization-runtime.ts` | Registry/runner/budget/worker construction for the new stage. |
| `server/services/alexa-voc-normalization-worker-handler.ts` | Batch handler that continues after ASIN-local failures and reports only system failures to the worker loop. |
| `server/routes/manual-alexa-voc.ts` and `app/api/alexa-voc/*` | Project-scoped import and status API contracts without raw payload echo. |
| `app/alexa-voc-import-panel.tsx` and `app/manual-alexa-voc-store.ts` | Per-ASIN polling/render state without a global VOC loading lock. |

### Task 1: Runtime skill, strict contract, and stage migration

**Files:**

- Create: `skills-src/alexa-for-shopping-voc/SKILL.md`, `skills-src/alexa-for-shopping-voc/references/matrix-format.md`, `skills-src/alexa-for-shopping-voc/references/examples.md`, and generated `manifest.json` from `C:\Users\EDY\Desktop\alexa-for-shopping-voc\` (only the two registry-required relative-link rewrites are allowed).
- Create: `skills-src/amazon-voc-insight/SKILL.md`, `skills-src/amazon-voc-insight/references/output-templates.md`, and `skills-src/amazon-voc-insight/manifest.json` from the approved package, retaining its analysis rules while binding the manifest to the combined Amazon insight contracts.
- Create: `server/domain/voc/alexa-voc-normalization-contracts.ts`.
- Create: `server/domain/voc/amazon-voc-insight-contracts.ts`.
- Create: `server/db/migrations/0022_alexa_voc_normalization_stage.sql`.
- Create: `server/db/migrations/postgres/0022_alexa_voc_normalization_stage.sql`.
- Modify: `shared/agent-contracts.ts:StageNameSchema` only for the stage enum in this slice; do not loosen or replace the existing persisted `ManualAlexaVocNormalizedRecordSchema`.
- Modify: `server/skills/agent-definitions.ts:AgentDefinitionSchema` and `agentDefinitions`.
- Modify: `server/orchestrator/stage-definitions.ts:stageDefinitions`.
- Modify: `server/orchestrator/analysis-orchestrator.ts:dependencySatisfied`.
- Modify: `server/db/repository.ts:RunStageRecord` plus SQLite stage claim validation/order and `server/db/postgres/job-store.ts:isStage` so the new stage can be enqueued, claimed, released, and completed.
- Test: `tests/agent/skill-registry.test.ts`, `tests/agent/contracts.test.ts`, `tests/agent/alexa-voc-normalization-contracts.test.ts`, `tests/agent/sqlite-migrations.test.ts`, `tests/agent/postgres-migrations.test.ts`, `tests/agent/job-repository.test.ts`, `tests/agent/postgres-job-repository.test.ts`.

**Interfaces:**

- Produces `AlexaVocMatrixRecordSchema`, whose record has exactly the latest supplied Skill fields: `attention`, `positives`, `negatives`, `unmet`, `audiences`, `scenarios`, `motives`, `captureStatus`, and `alexaReport`; every dimension is nonempty and audience/scenario/motive headers use the required full-width `｜` matrix format. There is no invented top-level `evidence` field.
- Produces `AlexaVocNormalizationInputSchema` named `AlexaVocNormalizationInput@1.0.0` for exactly `{ schemaVersion, kind, marketplace, asin, rawText, knownMeta }`, where trusted `knownMeta` carries nullable rating/review count, optional star breakdown, capture time, and capture mode; and `AlexaVocNormalizationOutputSchema` named `AlexaVocNormalizationOutput@1.0.0` for exactly `{ schemaVersion, kind, record: AlexaVocMatrixRecord }`. The execution service canonicalizes trusted header metadata, then creates the persisted object with `ManualAlexaVocNormalizedRecordSchema.parse({ asin, ...record })`.
- Produces `AmazonVocInsightInputSchema` named `AmazonVocInsightInput@1.0.0` by reusing the existing validated `VocPositioningInput` facts, and `AmazonVocInsightOutputSchema` named `AmazonVocInsightOutput@1.0.0`. Its exact shape is `{ schemaVersion, kind: "amazon-voc-insight-result", insight, positioningProjection }`: `insight` strictly contains the seven ordered latest-Skill sections (summary, seven-dimension rows, negative priorities, unmet opportunities, at least three product directions, ranked scored opportunities, and final decision), while `positioningProjection` is `VocPositioningOutputShapeSchema` and remains subject to the existing facts/evidence canonicalizer.
- Extends `StageName` with exactly `"alexa-voc-normalization"`; adds `AgentDefinition` `{ id: "alexa-voc-normalization", skill: { id: "alexa-for-shopping-voc", version: "1.0.0" }, mode: "structured-analysis", inputSchema: "AlexaVocNormalizationInput@1.0.0", outputSchema: "AlexaVocNormalizationOutput@1.0.0", budget: { maxInputTokens: 32000, maxOutputTokens: 12000, timeoutMs: 300000 }, dependencies: [] }`.

- [ ] **Step 1: Write the first failing skill/stage contract test.**

  Put this test before implementation in `tests/agent/skill-registry.test.ts`. This is the first RED because it proves the runtime contract rejects any legacy fallback before import, parser, storage, or worker code can accidentally route to it.

  ```ts
  test("registers only the vendored Alexa normalizer and formal VOC insight skills", async () => {
    const registry = await SkillRegistry.open(resolve("skills-src"));
    assert.deepEqual(
      registry.list().filter(skill =>
        ["alexa-for-shopping-voc", "amazon-voc-insight", "voc-listing-optimizer"].includes(skill.id),
      ).map(skill => skill.id),
      ["alexa-for-shopping-voc", "amazon-voc-insight"],
    );
    await assert.rejects(
      registry.load("voc-listing-optimizer", "1.0.0"),
      /Skill is not registered/,
    );
  });
  ```

- [ ] **Step 2: Run the RED test and confirm the missing registered skills fail.**

  Run: `npm test -- tests/agent/skill-registry.test.ts`

  Expected: FAIL; `registry.list()` lacks `alexa-for-shopping-voc` and `amazon-voc-insight` (or `registry.load` reports the normalizer is not registered). The failure must not mention `voc-listing-optimizer` as a successful registry entry.

- [ ] **Step 3: Add the strict contracts, vendored packages, agent definitions, and migrations.**

  Copy the approved normalizer content, make only the declared relative-link/path adaptation required by the registry, and test the adapted files against the desktop source after reversing those two link rewrites. Then generate `manifest.json` from the actual registered entries so `contentHash` matches `computeSkillContentHashFromEntries`. Add the downstream package with the same manifest rule. Use these exact contract and definition shapes:

  ```ts
  export const StageNameSchema = z.enum([
    "traffic-analysis",
    "alexa-voc-normalization",
    "voc-positioning",
    "product-definition",
  ]);

  export const AlexaVocMatrixRecordSchema = strictObject({
    attention: z.array(z.string().trim().min(1).max(1200)).min(1).max(8),
    positives: z.array(z.string().trim().min(1).max(1200)).min(1).max(10),
    negatives: z.array(z.string().trim().min(1).max(1200)).min(1).max(8),
    unmet: z.array(z.string().trim().min(1).max(1200)).min(1).max(8),
    audiences: z.array(z.string().trim().min(1).max(1200)).min(1).max(256),
    scenarios: z.array(z.string().trim().min(1).max(1200)).min(1).max(256),
    motives: z.array(z.string().trim().min(1).max(1200)).min(1).max(256),
    captureStatus: z.literal("dialog"),
    alexaReport: ManualAlexaVocReportHeaderSchema.extend({
      title: z.literal("顾客评价深度分析"),
      prompt: z.literal(MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT),
      captureStatus: z.literal("dialog"),
    }),
  });
  ```

  Add deterministic refinements/tests for `人群分类｜特征`, `场景｜说明与示例`, and `动机｜重要性｜说明` headers plus at least one data row in each matrix. The skill package may say `暂无数据` when a metric is unavailable, but a missing VOC dimension is not a valid fast-path success.

  Make the SQLite migration retain every current `run_stages`/`data_snapshots` row, child foreign-key relationship, index, and trigger while replacing the stage and kind checks. Prefix this migration with `-- sqlite-migration-mode: rebuild-with-foreign-keys-off`, and update `runMigrations` to recognize only that exact trusted header: before `BEGIN IMMEDIATE` set `PRAGMA foreign_keys = OFF`, run the migration transaction, inspect `PRAGMA foreign_key_check` and roll back on any row, commit, and always restore `PRAGMA foreign_keys = ON`. Do not execute `PRAGMA foreign_keys = OFF` from inside the transaction.

  ```sql
  -- sqlite-migration-mode: rebuild-with-foreign-keys-off
  CREATE TABLE run_stages_next (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (stage IN ('traffic-analysis','alexa-voc-normalization','voc-positioning','product-definition')),
    status TEXT NOT NULL CHECK (status IN ('queued','running','waiting-input','succeeded','failed','skipped','budget-exceeded','cancelled','stale')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    started_at TEXT, completed_at TEXT,
    last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (run_id, stage)
  ) STRICT;
  INSERT INTO run_stages_next SELECT * FROM run_stages;
  DROP TABLE run_stages;
  ALTER TABLE run_stages_next RENAME TO run_stages;
  CREATE INDEX run_stages_run_status_idx ON run_stages (run_id, status);
  ```

  Make the PostgreSQL migration use the existing constraint name:

  ```sql
  ALTER TABLE run_stages DROP CONSTRAINT run_stages_stage_check;
  ALTER TABLE run_stages ADD CONSTRAINT run_stages_stage_check CHECK (
    stage IN ('traffic-analysis','alexa-voc-normalization','voc-positioning','product-definition')
  );
  ```

  Set the `voc-positioning` definition to `{ id: "amazon-voc-insight", version: "1.0.0" }` with `AmazonVocInsightInput@1.0.0` and `AmazonVocInsightOutput@1.0.0`; update `validateAgentDefinitions` from `.length(3)` to `.length(4)`. The `0022` migrations must also prove that pre-existing `run_stages`, child `job_attempts`, `agent_runs`, and `data_snapshots` survive; the new snapshot/artifact kind pair is accepted, mismatched pairs are rejected, and ordinary VOC/traffic readers remain filtered to their own kinds. Test both a successful populated rebuild and an injected foreign-key violation that aborts without recording migration `0022`.

  Extend both persistence implementations' hard-coded stage validators and claim ordering. Add a test that creates, claims, releases/retries, and completes an `alexa-voc-normalization` job on SQLite and PostgreSQL; a migration-only enum test is insufficient.

- [ ] **Step 4: Run contract and migration tests to confirm GREEN.**

  Run: `npm test -- tests/agent/skill-registry.test.ts tests/agent/contracts.test.ts tests/agent/alexa-voc-normalization-contracts.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts tests/agent/job-repository.test.ts tests/agent/postgres-job-repository.test.ts`

  Expected: PASS; the registry hash-verifies both vendored packages, `voc-listing-optimizer` is unregistered, both databases reject an unlisted stage and accept `alexa-voc-normalization` after migration while preserving seeded `run_stages` rows.

- [ ] **Step 5: Commit the self-contained contract slice.**

  ```bash
  git add skills-src/alexa-for-shopping-voc skills-src/amazon-voc-insight shared/agent-contracts.ts server/domain/voc/alexa-voc-normalization-contracts.ts server/domain/voc/amazon-voc-insight-contracts.ts server/skills/agent-definitions.ts server/orchestrator/stage-definitions.ts server/orchestrator/analysis-orchestrator.ts server/db/repository.ts server/db/sqlite-repository.ts server/db/postgres/job-store.ts server/db/migrations/0022_alexa_voc_normalization_stage.sql server/db/migrations/postgres/0022_alexa_voc_normalization_stage.sql tests/agent/skill-registry.test.ts tests/agent/contracts.test.ts tests/agent/alexa-voc-normalization-contracts.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts tests/agent/job-repository.test.ts tests/agent/postgres-job-repository.test.ts
  git commit -m "feat: register strict Alexa VOC normalization contracts"
  ```

### Task 2: Authorized strict fast path and encrypted fallback snapshot

**Files:**

- Modify: `shared/agent-contracts.ts:ManualAlexaVocImportRequestSchema`, `ManualAlexaVocWriteResponseSchema`, and add `AlexaVocNormalizationStatusSchema`.
- Modify: `server/db/repository.ts:ManualAlexaVocRepositoryCapability` and `server/db/data-snapshot-repository.ts` to add project-scoped snapshot/fingerprint lookup and stage wake operations.
- Modify: `server/db/sqlite-repository.ts` and `server/db/postgres/manual-alexa-voc-store.ts` with identical organization/project/member checks and encrypted-envelope persistence.
- Create: `server/security/alexa-voc-normalization-input-cipher.ts` with a dedicated identity/AAD and JSON-safe base64url envelope fields, reusing the existing keyring and AES-256-GCM primitives without calling `ManualAlexaVocCipher` with a fabricated revision.
- Modify: `server/services/manual-alexa-voc-service.ts:importReport` and `listReports`.
- Modify: `server/routes/manual-alexa-voc.ts:principal` and both route handlers.
- Test: `tests/agent/alexa-voc-normalization-input-cipher.test.ts`, `tests/agent/manual-alexa-voc-service.test.ts`, `tests/agent/manual-alexa-voc-routes.test.ts`, `tests/agent/manual-alexa-voc-sqlite-repository.test.ts`, `tests/agent/postgres-manual-alexa-voc-store.test.ts`.

**Interfaces:**

- Consumes `AlexaVocMatrixRecordSchema`, the existing persisted `ManualAlexaVocNormalizedRecordSchema`, and `AlexaVocNormalizationInputCipher.encrypt({ identity, plaintext })` where identity is exactly `{ organizationId, projectId, runId, snapshotId, marketplace, asin, schema: "alexa-voc-normalization-input/v1" }`.
- Extends `ManualAlexaVocImportRequest` with `projectId: string` and returns `ManualAlexaVocWriteResponse = { disposition: "success" | "pending", record: ManualAlexaVocRecord | null, normalization: AlexaVocNormalizationStatus }`.
- Produces `ManualAlexaVocService.importReport(input: { principal: ManualAlexaVocPrincipal; request: unknown }): Promise<ManualAlexaVocWriteResponse>` that never returns `rawText`, cipher bytes, prompt, or model output.

- [ ] **Step 1: Write failing fast-path/fallback and authorization tests.**

  Add this focused case to `tests/agent/manual-alexa-voc-service.test.ts`, extending the existing `successfulHarness` with `findProjectById`, snapshot, stage, and job spies:

  ```ts
  test("queues an encrypted per-ASIN normalization snapshot when one strict dimension is empty", async () => {
    const harness = normalizationHarness({
      project: { id: PROJECT_ID, organizationId: ORGANIZATION_ID, marketplace: "US", asins: [ASIN] },
      parserResult: { ...strictRecord(ASIN), motives: [] },
    });
    const response = await harness.service.importReport({
      principal: { organizationId: ORGANIZATION_ID, userId: USER_ID },
      request: { projectId: PROJECT_ID, asin: ASIN, marketplace: "US", rawText: REPORT },
    });
    assert.equal(response.disposition, "pending");
    assert.equal(response.record, null);
    assert.equal(harness.putRevisionCalls(), 0);
    assert.deepEqual(harness.createdStage(), { runId: RUN_ID, stage: "alexa-voc-normalization" });
    assert.equal(harness.enqueuedJob().stage, "alexa-voc-normalization");
    assert.notEqual(harness.snapshot().payloadJson.includes(REPORT), true);
    assert.equal(JSON.stringify(response).includes(REPORT), false);
  });

  test("rejects a project outside the principal organization before parser, cipher, snapshot, or job access", async () => {
    const harness = normalizationHarness({ project: { id: PROJECT_ID, organizationId: "other-org", marketplace: "US", asins: [ASIN] } });
    await assert.rejects(
      harness.service.importReport({ principal: { organizationId: ORGANIZATION_ID, userId: USER_ID }, request: { projectId: PROJECT_ID, asin: ASIN, marketplace: "US", rawText: REPORT } }),
      (error: unknown) => error instanceof ManualAlexaVocServiceError && error.kind === "forbidden",
    );
    assert.equal(harness.sideEffectCount(), 0);
  });
  ```

- [ ] **Step 2: Run the RED tests and confirm current behavior is insufficient.**

  Run: `npm test -- tests/agent/manual-alexa-voc-service.test.ts tests/agent/manual-alexa-voc-routes.test.ts`

  Expected: FAIL because the current request has no `projectId`, `ManualAlexaVocServiceError` has no `forbidden` branch, and incomplete input throws `incomplete` instead of creating a pending encrypted snapshot.

- [ ] **Step 3: Implement project authorization, strict free path, and fallback persistence.**

  Parse `projectId` before calling `processAlexaVocText`, load the project, require `project.organizationId === principal.organizationId`, `project.marketplace === request.marketplace`, and `project.asins.includes(request.asin)`. Replace the current `processed.filled < 3` branch with exactly this gate:

  ```ts
  const candidate = AlexaVocMatrixRecordSchema.safeParse({
    attention: processed.sections.attention,
    positives: processed.sections.positives,
    negatives: processed.sections.negatives,
    unmet: processed.sections.unmet,
    audiences: processed.sections.audiences,
    scenarios: processed.sections.scenarios,
    motives: processed.sections.motives,
    captureStatus: "dialog",
    alexaReport: buildAlexaReportHeader(request.asin, processed),
  });
  if (candidate.success) return this.#storeFastPath({ project, principal: input.principal, request, record: candidate.data });
  return this.#queueNormalization({ project, principal: input.principal, request, rawReportSha256 });
  ```

  In `#queueNormalization`, allocate `snapshotId` before encryption, encrypt with the dedicated normalization-input cipher identity, and write only this JSON payload to the dedicated snapshot: `{ kind: "alexa-voc-normalization-input", version: "1.0.0", asin, rawReportSha256, plaintextBytes, executionFingerprint, envelope }`; all binary envelope fields are canonical base64url strings. Create-or-read exactly one `run_stages` row for `(runId, "alexa-voc-normalization")`, enqueue one job only when the snapshot/fingerprint has no terminal successful revision or current job, and return `{ disposition: "pending", record: null, normalization: { status: "pending", asin, fingerprint } }`. The repository query must join project ownership before returning a reusable revision, and reserve model budget using the current run/project pair. If the stage already reached a terminal state, use the existing legal stage/job retry transition to schedule the new snapshot rather than inserting a second stage row.

  Add a focused cipher test proving that changing any bound organization/project/run/snapshot/marketplace/ASIN/schema field fails decryption and that no synthetic manual VOC revision is accepted. Add snapshot repository tests proving ordinary `listDataSnapshotsByRun`/traffic readers never return `alexa-voc-normalization-input` artifacts.

- [ ] **Step 4: Run the service, route, SQLite, and PostgreSQL tests to confirm GREEN.**

  Run: `npm test -- tests/agent/alexa-voc-normalization-input-cipher.test.ts tests/agent/manual-alexa-voc-service.test.ts tests/agent/manual-alexa-voc-routes.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts`

  Expected: PASS; complete strict reports write a revision with no `SkillRunner` call, every invalid strict shape creates a ciphertext-only pending snapshot, invalid/missing/foreign project IDs create no side effect, same-org successful fingerprints can be reused, and pending/failure/budget jobs remain project/run scoped.

- [ ] **Step 5: Commit the import slice.**

  ```bash
  git add shared/agent-contracts.ts server/db/repository.ts server/db/data-snapshot-repository.ts server/db/sqlite-repository.ts server/db/postgres/manual-alexa-voc-store.ts server/security/alexa-voc-normalization-input-cipher.ts server/services/manual-alexa-voc-service.ts server/routes/manual-alexa-voc.ts tests/agent/alexa-voc-normalization-input-cipher.test.ts tests/agent/manual-alexa-voc-service.test.ts tests/agent/manual-alexa-voc-routes.test.ts tests/agent/manual-alexa-voc-sqlite-repository.test.ts tests/agent/postgres-manual-alexa-voc-store.test.ts
  git commit -m "feat: queue encrypted Alexa VOC normalization inputs"
  ```

### Task 3: Per-ASIN audited worker, revision identity, and downstream report chain

**Files:**

- Create: `server/runtime/alexa-voc-normalization-runtime.ts`.
- Create: `server/services/alexa-voc-normalization-execution-service.ts`.
- Create: `server/services/alexa-voc-normalization-worker-handler.ts`.
- Create: `server/db/migrations/0023_per_input_agent_execution.sql`.
- Create: `server/db/migrations/postgres/0023_per_input_agent_execution.sql`.
- Modify: `server/agent-service.ts:CreateAgentServiceOptions`, runtime creation/start/stop lists.
- Modify: `server/runtime/voc-positioning-runtime.ts:prepare` to consume only snapshots rebuilt from committed strict revisions and the formal `amazon-voc-insight` combined contract.
- Modify: `server/services/voc-positioning-execution-service.ts:VocPositioningAgentDefinition` to validate the combined insight output and its canonical positioning projection before publication.
- Modify: `server/db/manual-alexa-voc-repository.ts`, `server/db/sqlite-repository.ts`, `server/db/postgres/manual-alexa-voc-store.ts`, and `server/db/postgres/agent-run-store.ts` for committed normalized revisions, fingerprint claim/replay, ASIN-local terminal state, and downstream stage wake after commit.
- Modify: `server/db/model-budget-repository.ts`, `server/db/postgres/model-budget-store.ts`, `server/runtime/model-request-accounting.ts`, `server/runtime/skill-runner.ts`, and `server/runtime/agent-run-service.ts` so multiple audited per-input executions under one claimed job have separate budget/request authority and usage.
- Modify: `server/db/analysis-report-repository.ts`, `server/db/postgres/analysis-report-store.ts`, `server/domain/product/product-definition-contracts.ts`, and the SQLite equivalents to publish the combined `AmazonVocInsightOutput` while projecting legacy/current `VocPositioningOutput` for `product-definition`.
- Test: `tests/agent/agent-run-service.test.ts`, `tests/agent/model-budget-repository.test.ts`, `tests/agent/postgres-model-budget-repository.test.ts`, `tests/agent/worker-loop.test.ts`, `tests/agent/voc-positioning-runtime.test.ts`, `tests/agent/manual-alexa-voc-run-atomicity.test.ts`, `tests/agent/product-definition-contracts.test.ts`.

**Interfaces:**

- Produces `createAlexaVocNormalizationRuntime(options: AlexaVocNormalizationRuntimeOptions): Promise<{ start(): void; stop(): Promise<void> }>` with `JobAttemptWorkerLoop.stage === "alexa-voc-normalization"`.
- Produces `AlexaVocNormalizationExecutionService.execute(request: AlexaVocNormalizationExecutionRequest, context: AlexaVocNormalizationExecutionContext): Promise<{ revision: ManualAlexaVocRevision; agentRunId: string; replayed: boolean }>`.
- Consumes the Task 2 encrypted snapshot; calls `AuditedSkillRunner.run<AlexaVocNormalizationInput, AlexaVocNormalizationOutput>` with `snapshotIds: [snapshot.id]` and the existing `SkillExecutionContext` project/run budget authority.
- Migration `0023` drops the one-agent-run-per-job uniqueness and replaces it with `(job_attempt_id, execution_fingerprint)`; likewise it replaces `(stage_id, logical_execution_cycle_id)` with `(stage_id, logical_execution_cycle_id, execution_fingerprint)`. It adds `model_budget_reservations.agent_run_id`, keys request ordinal uniqueness by `(agent_run_id, request_ordinal)`, and requires every governed reservation/transition to match the active agent run authority. Existing rows are backfilled from their one-to-one job attempt before constraints are enabled.

- [ ] **Step 1: Write failing worker/revision/downstream tests.**

  Add this case to `tests/agent/manual-alexa-voc-run-atomicity.test.ts`:

  ```ts
  test("continues a normalization stage after one ASIN fails and wakes insight only after another ASIN commits", async () => {
    const harness = normalizationWorkerHarness({
      snapshots: [encryptedSnapshot(ASIN_A), encryptedSnapshot(ASIN_B)],
      outputs: new Map([[ASIN_A, new SkillRuntimeError("MODEL_OUTPUT_ERROR", "invalid")], [ASIN_B, { record: strictRecord(ASIN_B) }]]),
    });
    await harness.handleClaimedNormalizationJob();
    assert.deepEqual(harness.asinStates(), [[ASIN_A, "failure"], [ASIN_B, "success"]]);
    assert.equal(harness.revisionsFor(ASIN_A).length, 0);
    assert.equal(harness.revisionsFor(ASIN_B).length, 1);
    assert.equal(harness.wokenStages(), 1);
    assert.equal(harness.stageStatus(), "succeeded");
    assert.equal(JSON.stringify(harness.audits()).includes(REPORT), false);
  });
  ```

- [ ] **Step 2: Run the RED tests and confirm no normalizer worker exists.**

  Run: `npm test -- tests/agent/manual-alexa-voc-run-atomicity.test.ts tests/agent/voc-positioning-runtime.test.ts tests/agent/agent-run-service.test.ts`

  Expected: FAIL with missing `createAlexaVocNormalizationRuntime` or missing normalization handler; no current handler can process multiple encrypted snapshots with ASIN-local outcomes.

- [ ] **Step 3: Implement auditable per-ASIN execution and committed-revision downstream wake.**

  Implement the execution core with this order; `decrypt` is called only inside the runner input construction and neither `rawText` nor provider output is persisted outside the encrypted snapshot/validated record:

  ```ts
  const envelope = await this.#repository.findNormalizationInputSnapshot({ actorOrganizationId: context.organizationId, snapshotId: request.snapshotId });
  const fingerprint = createAlexaNormalizationFingerprint({ rawReportSha256: envelope.rawReportSha256, parser: { id: "deterministic-alexa-parser", version: "v3" }, skill, schemaDigest: AlexaVocMatrixRecordSchemaDigest, model: request.model });
  const rawText = this.#normalizationInputCipher.decrypt({ identity: envelope.cipherIdentity, envelope: envelope.envelope });
  const audited = await this.#auditedRunner.run({ skill: { id: "alexa-for-shopping-voc", version: "1.0.0" }, inputContract: { name: "AlexaVocNormalizationInput@1.0.0", schema: AlexaVocNormalizationInputSchema, allowedFields: ["schemaVersion", "kind", "marketplace", "asin", "rawText", "knownMeta"] }, outputContract: { name: "AlexaVocNormalizationOutput@1.0.0", schema: AlexaVocNormalizationOutputSchema }, input: buildNormalizationSkillInput(envelope, rawText), snapshotIds: [envelope.id], model: request.model }, { ...context, executionLineage: "stage-input" });
  const record = ManualAlexaVocNormalizedRecordSchema.parse({ asin: envelope.asin, ...audited.value.record });
  const revision = await this.#repository.transaction(repository => repository.manualAlexaVoc.putCommittedNormalization({ fingerprint, record, agentRunId: audited.agentRun.id, snapshotId: envelope.id, projectId: context.projectId }));
  await this.#repository.publishCommittedVocRevisionAndWake({ runId: context.runId, projectId: context.projectId, asin: record.asin, revision: revision.revision, sourceSnapshotId: envelope.id });
  ```

  The batch handler must wrap each snapshot in its own `try/catch`, record only a fixed error category (`model-output`, `schema`, `persistence`, or `authorization`) with snapshot/agent-run IDs, continue the loop, and return `{ status: "succeeded" }` after all snapshots are terminal. Re-throw only lease, database connectivity, or worker infrastructure errors. Include `contentHash`, version, schema digest, parser version, model configuration, and snapshot ID in the agent-run/revision provenance so any differing input causes a new revision while an identical completed fingerprint replays one result and emits one downstream wake. Reuse the existing manual-VOC publication/snapshot mechanism so `voc-positioning` sees a newly committed revision rather than an immutable pre-import snapshot; wake it only after both the revision and its authorized snapshot projection are committed.

  Process a stable page ordered by `(created_at, id)`, then drain again before finishing. The repository's finalization transaction must compare the processed watermark against the newest pending snapshot: if a new input arrived after enumeration, keep/requeue the stage and continue; only atomically mark the stage succeeded when no unprocessed snapshot remains. Tests must inject a late snapshot between the first drain and finalization.

  Scope model usage/recovery queries by `agentRunId`, not only `jobAttemptId`; otherwise the second ASIN sees the first ASIN's settled request as its own interrupted execution. `createModelRequestIdempotencyKey` must include the active per-input `agentRunId` (new schema version), and SQLite/PostgreSQL authority queries must join `model_budget_reservations.agent_run_id = agent_runs.id`.

  `amazon-voc-insight` must emit the combined strict `AmazonVocInsightOutput`: the seven-section business report is preserved for UI/report consumers and `positioningProjection` is canonicalized with the existing facts/evidence rules. Update report readers to accept both legacy `VocPositioningOutput` and the new combined output; `product-definition` calls one `extractVocPositioningProjection()` adapter so historical reports and new reports both remain valid.

- [ ] **Step 4: Run worker, audit, revision, and downstream tests to confirm GREEN.**

  Run: `npm test -- tests/agent/manual-alexa-voc-run-atomicity.test.ts tests/agent/agent-run-service.test.ts tests/agent/model-budget-repository.test.ts tests/agent/postgres-model-budget-repository.test.ts tests/agent/worker-loop.test.ts tests/agent/voc-positioning-runtime.test.ts tests/agent/voc-positioning-execution-service.test.ts tests/agent/product-definition-contracts.test.ts`

  Expected: PASS; 3–10 ASIN snapshots under one claimed job create separate audited runs and separate ordinal-zero budget reservations, each ASIN has one audited run per effective fingerprint, same fingerprints deduplicate concurrent work, raw text/model output is absent from audit/log DTOs, a late-arriving snapshot is drained or atomically requeued, one ASIN failure does not fail its siblings, and `amazon-voc-insight` is called only after its source revision transaction commits. Both legacy and combined VOC reports still build a valid product-definition input.

- [ ] **Step 5: Commit the worker and downstream slice.**

  ```bash
  git add server/runtime/alexa-voc-normalization-runtime.ts server/services/alexa-voc-normalization-execution-service.ts server/services/alexa-voc-normalization-worker-handler.ts server/agent-service.ts server/runtime/voc-positioning-runtime.ts server/services/voc-positioning-execution-service.ts server/db/manual-alexa-voc-repository.ts server/db/analysis-report-repository.ts server/db/sqlite-repository.ts server/db/postgres/manual-alexa-voc-store.ts server/db/postgres/agent-run-store.ts server/db/postgres/model-budget-store.ts server/db/postgres/analysis-report-store.ts server/db/model-budget-repository.ts server/runtime/model-request-accounting.ts server/runtime/skill-runner.ts server/runtime/agent-run-service.ts server/domain/product/product-definition-contracts.ts server/db/migrations/0023_per_input_agent_execution.sql server/db/migrations/postgres/0023_per_input_agent_execution.sql tests/agent/agent-run-service.test.ts tests/agent/model-budget-repository.test.ts tests/agent/postgres-model-budget-repository.test.ts tests/agent/worker-loop.test.ts tests/agent/voc-positioning-runtime.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts tests/agent/voc-positioning-execution-service.test.ts tests/agent/product-definition-contracts.test.ts
  git commit -m "feat: run audited Alexa normalization per ASIN"
  ```

### Task 4: Per-ASIN UI polling, isolation, and final gates

**Files:**

- Modify: `app/api/alexa-voc/import/route.ts`, `app/api/alexa-voc/pending/route.ts`, and `app/api/alexa-voc/route.ts` to pass `projectId` and return redacted per-ASIN status.
- Modify: `app/lib/agent-service-client.ts` with `getAlexaVocNormalizationStatus(projectId: string, asins: readonly string[]): Promise<AlexaVocNormalizationStatusResponse>`.
- Modify: `app/manual-alexa-voc-store.ts` with per-ASIN `pending | success | failure` state keyed by `projectId`, ASIN, and fingerprint.
- Modify: `app/alexa-voc-import-panel.tsx` so only the affected card polls/retries; do not set a page-global loading state.
- Test: `tests/agent/manual-alexa-voc-client-store.test.ts`, `tests/agent/manual-alexa-voc-import-feedback.test.ts`, `tests/agent/traffic-voc-isolation.test.ts`, `tests/agent/alexa-voc-mutation-routes.test.ts`, `tests/agent/service-security.test.ts`.

**Interfaces:**

- Consumes `AlexaVocNormalizationStatusResponse = { records: readonly { asin: string; fingerprint: string; status: "pending" | "success" | "failure"; revision: string | null; error: "model-output" | "schema" | "persistence" | "authorization" | null }[] }`.
- Produces a card state reducer with `setPending`, `setSuccess`, `setFailure`, and `clear` actions scoped to one `{ projectId, asin, fingerprint }` key.

- [ ] **Step 1: Write failing UI/API isolation and raw-data leakage tests.**

  Add this to `tests/agent/manual-alexa-voc-client-store.test.ts`:

  ```ts
  test("keeps sibling ASIN and non-VOC modules interactive while one normalization record fails", () => {
    const state = reduceAlexaVocState(initialAlexaVocState, [
      { type: "setPending", projectId: PROJECT_ID, asin: ASIN_A, fingerprint: "a".repeat(64) },
      { type: "setFailure", projectId: PROJECT_ID, asin: ASIN_A, fingerprint: "a".repeat(64), error: "model-output" },
      { type: "setSuccess", projectId: PROJECT_ID, asin: ASIN_B, fingerprint: "b".repeat(64), revision: "2" },
    ]);
    assert.equal(selectAlexaVocStatus(state, PROJECT_ID, ASIN_A)?.status, "failure");
    assert.equal(selectAlexaVocStatus(state, PROJECT_ID, ASIN_B)?.status, "success");
    assert.equal(selectPageBlockingLoading(state), false);
  });
  ```

  Add this route assertion to `tests/agent/alexa-voc-mutation-routes.test.ts`:

  ```ts
  assert.equal(JSON.stringify(response.body).includes(REPORT), false);
  assert.doesNotMatch(JSON.stringify(response.body), /rawText|ciphertext|wrappedDek|modelResponse/i);
  ```

- [ ] **Step 2: Run the RED UI/API tests and confirm global/unsafe behavior is caught.**

  Run: `npm test -- tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/traffic-voc-isolation.test.ts tests/agent/service-security.test.ts`

  Expected: FAIL because the client has no fingerprint-keyed normalization state/polling response and the mutation proxy does not yet carry project-scoped pending status.

- [ ] **Step 3: Implement redacted polling and localized rendering.**

  Have `/api/alexa-voc/pending` forward only `{ projectId, asins }`, validate the server response with `AlexaVocNormalizationStatusResponseSchema`, and render the card branch exactly from its own state:

  ```tsx
  const status = selectAlexaVocStatus(state, projectId, asin);
  return status?.status === "pending" ? <VocCardPending asin={asin} />
    : status?.status === "failure" ? <VocCardFailure asin={asin} error={status.error} />
    : <VocCardReady asin={asin} revision={status?.revision ?? null} />;
  ```

  Poll only while that card is `pending`, stop on `success` or `failure`, and retry by submitting the same project/ASIN request through the existing protected route. Do not include raw input in state, route output, error text, debug props, or network-visible status. Preserve historical revisions only as explicitly labeled stale history; never display them as the pending/failing request's success.

- [ ] **Step 4: Run final targeted, build, and leakage gates.**

  Run: `npm test -- tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/traffic-voc-isolation.test.ts tests/agent/service-security.test.ts && npm run build && rg -n "voc-listing-optimizer|rawText|modelResponse" skills-src server app tests/agent`

  Expected: all tests and build PASS; the `rg` result contains no `voc-listing-optimizer` occurrence, and each permitted `rawText` occurrence is limited to the protected request/cipher/worker input implementation and no response, log, summary, route payload, or client store occurrence is returned.

- [ ] **Step 5: Commit the UI and release gates.**

  ```bash
  git add app/api/alexa-voc/import/route.ts app/api/alexa-voc/pending/route.ts app/api/alexa-voc/route.ts app/lib/agent-service-client.ts app/manual-alexa-voc-store.ts app/alexa-voc-import-panel.tsx tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts tests/agent/traffic-voc-isolation.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/service-security.test.ts
  git commit -m "feat: show isolated Alexa normalization status"
  ```

## Plan self-review

- **Spec coverage:** Task 1 establishes the two formal vendored skills, strict contracts, stage contract, and PostgreSQL/SQLite migration. Task 2 covers authenticated project membership, seven-dimension free-path gating, ciphertext-only snapshot persistence, idempotency, and project-scoped reuse. Task 3 covers one stage/many ASIN audited execution, full fingerprint identity, failure continuation, committed revision ordering, budget/run isolation, and formal `amazon-voc-insight` report consumption. Task 4 covers polling, card-level pending/success/failure, sibling module isolation, redacted API payloads, build, and legacy-skill leakage gates.
- **Placeholder scan:** This plan contains no `TODO`, `TBD`, `implement later`, `fill in details`, `similar to`, or unnamed test step.
- **Type consistency:** `AlexaVocMatrixRecordSchema` is the sole latest-Skill matrix payload used by Task 2 input gating and Task 3 output validation; the service adds the bound ASIN and validates the existing persisted `ManualAlexaVocNormalizedRecordSchema`. `alexa-voc-normalization` is the exact `StageName`, `AgentDefinition.id`, worker stage filter, persistence key, and UI status source. `amazon-voc-insight` uses `AmazonVocInsightInput@1.0.0` / `AmazonVocInsightOutput@1.0.0`; its required seven business sections are retained and its strict `positioningProjection` preserves the current publisher-to-`product-definition` dependency.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-01-alexa-voc-normalization-implementation.md`. Two execution options:

1. Subagent-Driven (recommended) - dispatch a fresh subagent per task and review between tasks.

2. Inline Execution - execute the four tasks in this session with review checkpoints.
