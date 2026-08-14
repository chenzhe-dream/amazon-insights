# VOC DataSnapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build OpenSpec 8.1 only: create a strict, provenance-bearing, immutable VOC `DataSnapshot` from the repository's existing Alexa, Sorftime, and SellerSprite data without changing the generated source files.

**Architecture:** A pure Node source adapter filters static repository data by the trusted project's marketplace and ordered ASIN whitelist, normalizes date-only provenance to the end of that UTC day, reports missing inputs with closed reason codes, and builds a strict versioned payload. A service resolves the actor's trusted `AnalysisRun`/`Project`, constructs and hashes the candidate outside the database transaction, and delegates one atomic revalidation/insert to a domain repository. SQLite migration 0005 adds semantic identity and immutability constraints; readers strictly parse and re-hash stored JSON before returning deeply frozen records.

**Tech Stack:** TypeScript, Zod, Node `crypto`, Node `sqlite`, Node test runner, existing `tsx` test harness, forward-only SQLite SQL migrations.

## Global Constraints

- Implement only OpenSpec 8.1; do not implement 8.2 theme preprocessing, 8.3 Skill execution, 8.4 UI, 8.5 E2E, login, PostgreSQL, or live collection.
- Do not add dependencies or change `package-lock.json`.
- Do not modify migrations 0001-0004 or the generated files `app/rufus-voc-data.ts`, `app/sorftime-review-analysis-data.ts`, and `app/seller-sprite-mcp-review-analysis-data.ts`.
- Use only repository data, fake fixtures, and SQLite; do not access the network, Chrome, MCP, Codex, Cursor, or hidden context.
- Production behavior is test-first: every production behavior must be preceded by a focused failing test and observed RED result.
- Preserve project ASIN order after strict uppercase normalization; do not sort the target list or include an ASIN outside it.
- Interpret every repository date-only value as `23:59:59.999Z` on that UTC calendar day. A source or record after the run cutoff is unavailable.
- Build payloads and provenance outside the database transaction. The SQLite transaction performs only synchronous local reads/checks/insertion and revalidates run, project, organization, marketplace, ASIN identity, and cutoff.
- Ordinary logs contain only run ID, snapshot ID, source count, record count, status, and a short content-hash prefix; never VOC/review text, secrets, or complete payloads.

---

### Task 1: Strict VOC payload and deterministic repository-data adapter

**Files:**
- Create: `server/data/voc-data-snapshot.ts`
- Create: `server/data/repository-voc-source.ts`
- Test: `tests/agent/voc-data-source.test.ts`

**Interfaces:**
- Consumes: `rufusVocMeta`/`rufusVocData`, `sorftimeReviewAnalysisMeta`/`sorftimeReviewAnalysisData`, `sellerSpriteMcpReviewAnalysisMeta`/`sellerSpriteMcpReviewAnalysisData`, and the record shapes exported by the existing app modules.
- Produces: `VOC_SNAPSHOT_SCHEMA_VERSION`, `VocSnapshotPayloadSchema`, `VocSnapshotSourceIdSchema`, `MissingVocSourceSchema`, `normalizeRepositoryDateOnlyUtc`, `buildVocSnapshotCandidate`, and `RepositoryVocSourceReader.read(input)`.

- [ ] **Step 1: Write strict-contract and date-normalization tests**

  Add focused tests that assert the wished-for API and verify:

  ```ts
  assert.equal(normalizeRepositoryDateOnlyUtc("2026-08-13"), "2026-08-13T23:59:59.999Z");
  assert.throws(() => normalizeRepositoryDateOnlyUtc("2026-8-13"), /date-only/i);
  assert.equal(VocSnapshotPayloadSchema.safeParse({
    schemaVersion: "1.0.0",
    kind: "voc",
    marketplace: "US",
    asins: ["B07VY9Q95Q"],
    records: { alexaVoc: [], sorftimeReviewAnalysis: [], sellerSpriteReviewAnalysis: [] },
    extra: true,
  }).success, false);
  ```

  Also assert nested Alexa and review-analysis records reject undeclared keys, malformed statuses, invalid percentages, duplicate ASINs, and payload ASINs not represented by the target identity.

- [ ] **Step 2: Run the focused file and confirm RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts`

  Expected: FAIL because `server/data/voc-data-snapshot.ts` and its exports do not exist.

- [ ] **Step 3: Implement the strict versioned payload contract and canonical hashing**

  Define closed Zod schemas for the unmodified Alexa record fields and the six review-analysis block/row fields. Do not use `z.unknown()`, `z.any()`, `Record<string, unknown>`, or passthrough objects for persisted payload data. Use the existing `canonicalJsonSha256` only after schema parsing.

  The stable candidate shape is:

  ```ts
  export const VOC_SNAPSHOT_SCHEMA_VERSION = "1.0.0" as const;
  export const VocSnapshotPayloadSchema = z.strictObject({
    schemaVersion: z.literal(VOC_SNAPSHOT_SCHEMA_VERSION),
    kind: z.literal("voc"),
    marketplace: MarketplaceSchema,
    asins: z.array(AsinSchema).min(1),
    records: z.strictObject({
      alexaVoc: z.array(AlexaVocSnapshotRecordSchema),
      sorftimeReviewAnalysis: z.array(ReviewAnalysisSnapshotRecordSchema),
      sellerSpriteReviewAnalysis: z.array(ReviewAnalysisSnapshotRecordSchema),
    }),
  });
  ```

  `buildVocSnapshotCandidate` validates the target, source list, and payload; verifies each persisted record belongs to the ordered target whitelist; computes each source checksum over `{ sourceId, records }`; and computes the overall lowercase SHA-256 over exactly `{ schemaVersion, marketplace, asins, dataCutoffAt, sources, payload }`. IDs and `createdAt` are deliberately excluded from the content identity.

- [ ] **Step 4: Run contract/date tests and confirm GREEN**

  Run: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts`

  Expected: contract/date subtests PASS.

- [ ] **Step 5: Add repository-source filtering, provenance, cutoff, and missing-input tests**

  Add tests against both the real static modules and small injected fixtures. Assert:

  - imports work in ordinary Node/`tsx` and no React/UI module is loaded;
  - project ASIN order is retained after uppercase normalization and an unrelated source ASIN is excluded;
  - source order is Alexa, Sorftime, SellerSprite;
  - source mappings are `manual-voc` + `app/rufus-voc-data.ts#rufusVocData`, then two `connector` references;
  - each source has an end-of-UTC-day `capturedAt` and a lowercase SHA-256 checksum covering only its included records;
  - `pending`, `error`, not-found, marketplace mismatch, and after-cutoff inputs produce the closed missing reasons `pending`, `source-error`, `not-found`, `marketplace-mismatch`, and `after-cutoff`;
  - only available records are emitted, and an all-missing input produces no candidate rather than an empty success;
  - semantically identical inputs have identical source checksums and `contentHash`; changed payload text changes both the affected source checksum and overall hash.

- [ ] **Step 6: Run the expanded file and confirm RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts`

  Expected: FAIL because `RepositoryVocSourceReader` behavior is absent.

- [ ] **Step 7: Implement the pure deterministic source adapter**

  `RepositoryVocSourceReader` accepts fixture overrides for tests but defaults to the three static repository modules. It performs no file writes, dynamic network access, UI work, or collection. It emits a closed result:

  ```ts
  type RepositoryVocReadResult = Readonly<{
    candidate: VocSnapshotCandidate | null;
    missingSources: readonly MissingVocSource[];
    recordCount: number;
  }>;
  ```

  For each source, it walks the trusted target ASIN list (never the source object's key order), validates source records, skips unavailable records, and attaches a source only when at least one valid record exists. The source-level `capturedAt` is the maximum included record timestamp; Alexa uses the module `capturedAt`, while review records use their own `fetchedAt`. Freeze returned candidates and missing-input arrays recursively.

- [ ] **Step 8: Run the focused source suite and confirm GREEN**

  Run: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts`

  Expected: all source tests PASS.

---

### Task 2: Domain repository contract and immutable SQLite persistence

**Files:**
- Modify: `shared/agent-contracts.ts`
- Create: `server/db/data-snapshot-repository.ts`
- Create: `server/db/migrations/0005_voc_data_snapshot.sql`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `tests/agent/sqlite-migrations.test.ts`
- Modify: `tests/agent/repository.test.ts`
- Create: `tests/agent/data-snapshot-repository.test.ts`

**Interfaces:**
- Consumes: strict `VocSnapshotPayload`, `SnapshotSource`, and the existing `SqliteAgentRepository` transaction/serialization facilities.
- Produces: shared `DataSnapshot.contentHash`; `DataSnapshotRepository.createDataSnapshotForRun`, `findDataSnapshotById`, `listDataSnapshotsByRun`; `DataSnapshotConflictError`, `DataSnapshotSubjectNotFoundError`, and `DataSnapshotDataError`.

- [ ] **Step 1: Write migration and repository-contract tests**

  Extend migration tests to require version 5 and assert its SQL declares:

  ```sql
  CREATE UNIQUE INDEX data_snapshots_semantic_identity_idx
    ON data_snapshots (run_id, schema_version, marketplace, asins_json, data_cutoff_at);
  CREATE TRIGGER data_snapshots_update_immutable BEFORE UPDATE ON data_snapshots ...;
  CREATE TRIGGER data_snapshots_delete_immutable BEFORE DELETE ON data_snapshots ...;
  ```

  Add a compile/runtime contract test showing `DataSnapshotSchema` requires lowercase `contentHash`, source checksums are lowercase, and strict payload objects reject unknown fields.

- [ ] **Step 2: Run migration/contract tests and confirm RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/contracts.test.ts`

  Expected: FAIL because migration 0005 and `contentHash` are missing.

- [ ] **Step 3: Add migration 0005 and domain repository types**

  Add only a forward migration. Besides the unique identity index and unconditional update/delete blockers, add insert triggers checking lower-case 64-character hashes, valid array/object JSON, `data_cutoff_at <= analysis_runs.data_cutoff_at`, each `sources_json[*].capturedAt <= data_cutoff_at`, run/project marketplace and ASIN JSON equality, and `schema_version = '1.0.0'`. The delete trigger intentionally blocks `analysis_runs` cascade deletion so snapshots cannot disappear silently.

  Define repository inputs without caller-provided tenant/target authority:

  ```ts
  export interface CreateDataSnapshotForRunInput {
    actorOrganizationId: string;
    expectedProjectId: string;
    expectedMarketplace: string;
    expectedAsins: readonly string[];
    expectedRunCutoffAt: string;
    candidateId: string;
    createdAt: string;
    candidate: VocSnapshotCandidate;
  }
  ```

  The repository returns `{ snapshot, created }`; same identity + same hash is idempotent, while same identity + different hash throws `DataSnapshotConflictError`.

- [ ] **Step 4: Run migration/contract tests and confirm GREEN**

  Run: `npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/contracts.test.ts`

  Expected: both files PASS.

- [ ] **Step 5: Write persistence, idempotency, concurrency, restart, and tamper tests**

  Seed real user/project/run rows through the repository and assert:

  - create persists metadata, strict `payload_json`, sources, and hash and returns a deeply immutable record;
  - by-ID and by-run reads survive close/reopen and preserve project ASIN order;
  - same semantic identity/hash returns the original ID and `createdAt`;
  - same identity with changed content throws conflict and does not overwrite;
  - two separate `SqliteAgentRepository` connections racing the same identity both observe one consistent row;
  - cross-run/project/organization, marketplace, ASIN, run-cutoff, snapshot-cutoff, and source-after-cutoff inputs are rejected;
  - a caller transaction rollback removes a newly inserted snapshot;
  - direct SQL `UPDATE`, `DELETE`, and parent-run `DELETE` fail at the database boundary;
  - after deliberately bypassing an immutability trigger in a test fixture, malformed payload/provenance/hash is rejected by the reader as `DataSnapshotDataError`.

- [ ] **Step 6: Run the persistence suite and confirm RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/data-snapshot-repository.test.ts tests/agent/repository.test.ts`

  Expected: FAIL because the SQLite repository methods do not exist.

- [ ] **Step 7: Implement atomic SQLite create/read paths**

  Extend `SqliteAgentRepository` with the domain repository interface. Candidate construction and hashing remain outside this method. Inside one existing serialized `BEGIN IMMEDIATE` transaction, synchronously join `analysis_runs` to `projects`, compare the actor organization and all expected identity fields, canonicalize the stored run cutoff, re-parse the candidate, re-compute all checksums/hash, read an existing semantic identity, and either replay, conflict, or insert.

  Reader mapping must:

  ```ts
  const payload = VocSnapshotPayloadSchema.parse(JSON.parse(row.payload_json));
  const sources = z.array(SnapshotSourceSchema).min(1).parse(JSON.parse(row.sources_json));
  const snapshot = VocDataSnapshotRecordSchema.parse({ ...metadata, sources, payload });
  assertVocSnapshotIntegrity(snapshot); // checks per-source checksums and contentHash
  return deepFreeze(snapshot);
  ```

  Do not call an async callback or external provider from the immediate transaction.

- [ ] **Step 8: Run the persistence suite and confirm GREEN**

  Run: `npx tsx --conditions=react-server --test tests/agent/data-snapshot-repository.test.ts tests/agent/repository.test.ts`

  Expected: all persistence tests PASS.

---

### Task 3: Trusted snapshot service, waiting-input result, and safe logging

**Files:**
- Create: `server/services/voc-data-snapshot-service.ts`
- Create: `tests/agent/voc-data-snapshot-service.test.ts`

**Interfaces:**
- Consumes: `AgentRepository & DataSnapshotRepository`, `RepositoryVocSourceReader`, trusted `AnalysisExecutionContext`, injected UUID/clock, and a summary-only logger.
- Produces: `VocDataSnapshotService.createForRun({ actor, runId })` with the closed `ready | waiting-input` result.

- [ ] **Step 1: Write authorization, waiting-input, and logging tests**

  Test the wished-for service API with real SQLite and injected source fixtures. Assert:

  - input accepts only `actor` and `runId`; marketplace, ASINs, tenant, and cutoff cannot be supplied;
  - missing run and cross-organization actor are rejected before the source reader is called;
  - run/project marketplace, ASIN order, and run cutoff drive source reading and persistence;
  - partial availability returns `waiting-input` with a persisted snapshot containing only available records plus a closed missing-source list;
  - total absence returns `waiting-input` with `snapshot: null` and writes no row;
  - all three sources available returns `ready`;
  - the repository's in-transaction revalidation catches run/project mutation between preflight and insert;
  - logs expose only the declared summary fields and do not contain recognizable VOC text, review reasons, complete payload JSON, email, or organization ID.

- [ ] **Step 2: Run the service test and confirm RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/voc-data-snapshot-service.test.ts`

  Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement trusted orchestration with no collection fallback**

  Resolve the run, then its project, then verify `project.organizationId === actor.organizationId`. Normalize the project target, read static sources, and build the candidate before calling `createDataSnapshotForRun`. Never call network, Chrome, MCP, import/sync scripts, or return fabricated empty source arrays as success.

  Return only:

  ```ts
  type CreateVocSnapshotResult =
    | Readonly<{ status: "ready"; snapshot: VocDataSnapshotRecord; missingSources: readonly [] }>
    | Readonly<{ status: "waiting-input"; snapshot: VocDataSnapshotRecord | null; missingSources: readonly MissingVocSource[] }>;
  ```

  Emit one best-effort summary log after the repository result; logger failures must not replace a successful snapshot result.

- [ ] **Step 4: Run the service test and confirm GREEN**

  Run: `npx tsx --conditions=react-server --test tests/agent/voc-data-snapshot-service.test.ts`

  Expected: all service tests PASS.

- [ ] **Step 5: Run all focused 8.1 tests together**

  Run: `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts tests/agent/data-snapshot-repository.test.ts tests/agent/voc-data-snapshot-service.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/contracts.test.ts tests/agent/repository.test.ts`

  Expected: 0 failures.

- [ ] **Step 6: Commit the executable 8.1 implementation**

  Review `git diff --stat` and `git diff --check`, then stage only Task 1-3 files and commit:

  ```text
  feat(agent): persist immutable VOC data snapshots
  ```

---

### Task 4: OpenSpec completion and complete merge gates

**Files:**
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`

**Interfaces:**
- Consumes: all green 8.1 implementation and verification evidence.
- Produces: only the 8.1 checkbox changed from `[ ]` to `[x]`; 8.2 and later remain untouched.

- [ ] **Step 1: Run the full pre-completion gate suite**

  Run, in order:

  ```text
  npm run test:agent
  npm run skills:validate
  npm run lint
  npx openspec validate build-standalone-agent-workflow --strict
  npm test
  git diff --check
  ```

  Expected: agent tests 0 failures; skills valid; lint 0 errors and exactly 26 known warnings; OpenSpec valid; rendered build/tests 2/2; diff check clean.

- [ ] **Step 2: Run the TypeScript differential gate against base `174a800a74a5e0b032777b9c558e2463f9e64d5d`**

  Create a system-Temp ordinary local read-only clone with `git clone --no-local --shared`, detach it at the exact base, verify its absolute path is outside both the main checkout and this worktree, and junction its `node_modules` to the already-installed dependency tree. Do not use tar/archive and do not create another worktree. Run identical commands in base and feature:

  ```text
  node node_modules/typescript/bin/tsc --noEmit --pretty false --incremental false
  ```

  Normalize checkout roots and slash directions, compare unique `error TS...` lines, and require base diagnostics = 17, feature diagnostics = 17, feature-only = 0. Remove only the explicitly verified system-Temp clone afterward.

- [ ] **Step 3: Verify protected files and 8.1-only scope**

  Require no diff against base for:

  ```text
  package-lock.json
  server/db/migrations/0001_agent_runtime.sql
  server/db/migrations/0002_job_retry_cycles.sql
  server/db/migrations/0003_model_budget_ledger.sql
  server/db/migrations/0004_agent_run_audit.sql
  app/rufus-voc-data.ts
  app/sorftime-review-analysis-data.ts
  app/seller-sprite-mcp-review-analysis-data.ts
  ```

  Inspect the full changed-file list and confirm no UI, Skill, theme preprocessing, report, authentication, PostgreSQL, connector, or collection files changed.

- [ ] **Step 4: Mark only OpenSpec 8.1 complete**

  Change exactly:

  ```md
  - [x] 8.1 从仓库已有 VOC/评论数据生成带来源和截止时间的不可变 DataSnapshot，不修改现有生成数据文件
  ```

  Leave 8.2-8.5 and all other unchecked tasks unchanged.

- [ ] **Step 5: Re-run strict/spec and final verification after the checkbox edit**

  Re-run focused 8.1 tests, `npm run test:agent`, OpenSpec strict, `git diff --check`, and protected-file/scope checks. Confirm the working tree contains only intended 8.1 changes.

- [ ] **Step 6: Commit OpenSpec completion atomically**

  Stage only `openspec/changes/build-standalone-agent-workflow/tasks.md` and commit:

  ```text
  docs(openspec): complete VOC data snapshot task
  ```

- [ ] **Step 7: Preserve branch/worktree for duplicate review**

  Do not amend, rebase, push, merge, touch stash, or remove the worktree. Report source mapping, contract/identity/cutoff decisions, observed RED/GREEN evidence, final test counts, commit SHAs, residual risks, and the explicit 8.2 boundary.
