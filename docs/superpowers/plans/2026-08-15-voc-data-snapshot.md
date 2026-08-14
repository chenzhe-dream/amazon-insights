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
- Ordinary logs contain only run ID, snapshot ID, source count, record count, and a short content-hash prefix; never VOC/review text, secrets, status payloads, or complete payloads.

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
    runId: string;
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
- Produces: `VocDataSnapshotService.createForRun(runId)` with the actor held in trusted server-side `executionContext` and a closed `ready | waiting-input` result.

- [ ] **Step 1: Write authorization, waiting-input, and logging tests**

  Test the wished-for service API with real SQLite and injected source fixtures. Assert:

  - construction accepts trusted `executionContext` and the method accepts only `runId`; marketplace, ASINs, tenant, and cutoff cannot be supplied;
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

---

## Duplicate-review fix plan (2026-08-15)

The first duplicate review returned six Important findings. OpenSpec 8.1 is returned to `[ ]` before these changes and may be checked again only after every RED/GREEN cycle and full gate below succeeds.

### Review Task 5: A1 trusted source marketplace provenance

**Files:**
- Modify: `server/data/voc-data-snapshot.ts`
- Modify: `server/data/repository-voc-source.ts`
- Modify: `tests/agent/voc-data-source.test.ts`

**Interfaces:**
- `VocSnapshotSourceSchema` replaces the generic metadata-only source schema inside the strict VOC candidate/record and includes exactly `type`, `reference`, `marketplace`, `capturedAt`, and `checksum`.
- Alexa repository provenance declares trusted marketplace `US`; review provenance uses each module's trusted `meta.marketplace`.
- Per-source checksum preimage becomes exactly `{ sourceId, marketplace, records }`.

- [ ] **Step 1 (RED):** Add tests proving a CA target emits no Alexa records, reports `marketplace-mismatch` for every requested Alexa ASIN, and still reads matching CA review fixtures. Add a US control proving Alexa remains available. Add a checksum/hash test proving source marketplace is material to provenance and recomputation.
- [ ] **Step 2:** Run `npx tsx --conditions=react-server --test tests/agent/voc-data-source.test.ts`; expect failures showing Alexa is incorrectly accepted for CA and source provenance lacks marketplace.
- [ ] **Step 3 (GREEN):** Add strict internal source marketplace, reject Alexa when target marketplace is not `US`, include marketplace in checksum preimages, and make integrity verification recompute the same values.
- [ ] **Step 4:** Re-run the focused source test and require 0 failures.

### Review Task 6: A2 actor and all-missing subject revalidation

**Files:**
- Modify: `server/db/data-snapshot-repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/services/voc-data-snapshot-service.ts`
- Modify: `tests/agent/data-snapshot-repository.test.ts`
- Modify: `tests/agent/voc-data-snapshot-service.test.ts`

**Interfaces:**
- `CreateDataSnapshotForRunInput` adds required trusted `actorId` alongside `actorOrganizationId`.
- `DataSnapshotRepository.revalidateDataSnapshotSubject(input)` performs the same synchronous `BEGIN IMMEDIATE` actor/run/project identity checks without inserting a snapshot.
- Subject validation requires an exact `users.id`, `status = 'active'`, and matching `organization_id` before run/project/marketplace/ASIN/cutoff checks.

- [ ] **Step 1 (RED):** Add repository tests for wrong, disabled, deleted, and moved-organization actors. Add service fixtures that mutate actor state after source reading and assert rejection plus zero snapshots. Add all-missing actor/project drift tests that require post-read revalidation even though no insert occurs.
- [ ] **Step 2:** Run the two focused repository/service files; expect actor drift and all-missing drift tests to fail because the current create input has no actor ID and the null-candidate path skips the repository.
- [ ] **Step 3 (GREEN):** Centralize a synchronous trusted-subject query/check, call it inside each immediate transaction, pass the trusted actor ID from the service, and call revalidation after all-missing source reads. Do not place source-reader or other external I/O inside a transaction.
- [ ] **Step 4:** Re-run the two focused files and require 0 failures and zero persisted rows in every rejected case.

### Review Task 7: B1 explicit legacy compatibility in migration 0005

**Files:**
- Modify: `server/db/migrations/0005_voc_data_snapshot.sql`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `tests/agent/sqlite-migrations.test.ts`
- Modify: `tests/agent/agent-run-repository.test.ts`
- Modify: `tests/agent/data-snapshot-repository.test.ts`

**Interfaces:**
- Migration 0005 adds nullable `snapshot_kind TEXT CHECK (snapshot_kind IS NULL OR snapshot_kind = 'voc')`; rows created by migrations 0001-0004 remain `NULL` legacy rows.
- The semantic identity index is partial with `WHERE snapshot_kind = 'voc'`.
- VOC insert/immutability triggers and VOC repository reads are discriminator-scoped; legacy rows remain untouched and retain AgentRun references.

- [ ] **Step 1 (RED):** Build a database through migrations 0001-0004, insert two duplicate semantic legacy snapshots (including one referenced by an AgentRun), then apply/reopen through 0005. Assert both legacy rows and the reference survive. Add controls that new VOC rows are uniquely constrained and immutable.
- [ ] **Step 2:** Run migration and AgentRun-focused tests; expect migration 0005 to fail while creating the current global unique index.
- [ ] **Step 3 (GREEN):** Replace the global index/trigger assumptions with the nullable discriminator, partial index, and VOC-scoped triggers. Insert/read only `snapshot_kind = 'voc'` in the VOC repository.
- [ ] **Step 4:** Re-run migration, AgentRun, and snapshot persistence files and require 0 failures without rewriting, merging, or deleting legacy rows.

### Review Task 8: B2 canonical instants and B3 NULL-safe strict SQL boundary

**Files:**
- Modify: `server/data/voc-data-snapshot.ts`
- Modify: `server/db/migrations/0005_voc_data_snapshot.sql`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `tests/agent/voc-data-source.test.ts`
- Modify: `tests/agent/data-snapshot-repository.test.ts`
- Modify: `tests/agent/sqlite-migrations.test.ts`

**Interfaces:**
- `canonicalizeVocSnapshotCandidate` parses legal offset DateTimes and normalizes cutoff/source timestamps to UTC millisecond `toISOString()` before checksum/hash validation, identity lookup, or insertion.
- New VOC SQL rows require canonical UTC-millisecond cutoff, capture, and creation timestamps.
- Source JSON must be a non-empty array of exact five-key objects; type is `manual-voc | connector`, reference is 1-500 characters, marketplace equals the snapshot marketplace, capturedAt is canonical and not after cutoff, and checksum is lowercase SHA-256.

- [ ] **Step 1 (RED):** Add idempotency tests where canonical, offset, and no-millisecond equivalent cutoff inputs resolve to one ID; retain changed-content conflict. Add raw SQL tests rejecting noncanonical VOC cutoff/capturedAt, source missing keys, JSON nulls, wrong types, invalid enum, extra keys, blank/oversized reference, mismatched marketplace, invalid/late capturedAt, invalid checksum, malformed top-level payload/asins/content hash/kind. Assert every failed transaction leaves no row.
- [ ] **Step 2:** Run source, migration, and snapshot repository files; expect equivalent instant identity splits and malformed raw inserts to bypass the current trigger.
- [ ] **Step 3 (GREEN):** Canonicalize at adapter, service, and repository boundaries; use instant comparisons. Rewrite migration predicates with `IS NOT` and exact key-count/name checks, validate strict payload top-level/records structure and metadata equality, and enforce canonical text for new VOC rows only.
- [ ] **Step 4:** Re-run the three focused files and require 0 failures; verify valid Alexa/Sorftime/SellerSprite provenance remains insertable and reader recomputation matches database values.

### Review Task 9: B4 real cross-isolate SQLite races

**Files:**
- Create: `tests/agent/helpers/sqlite-data-snapshot-worker.ts`
- Modify: `tests/agent/data-snapshot-repository.test.ts`

**Interfaces:**
- Worker data contains the database path, complete create input, and a bounded shared-memory barrier.
- Worker result is a closed success `{ kind: 'success', created, id, contentHash }` or conflict `{ kind: 'conflict' }`; unexpected SQLite errors fail the test.

- [ ] **Step 1 (RED):** Replace the same-isolate `Promise.all` test with two `worker_threads` module isolates, each opening its own repository connection. Add same-hash and different-hash races with a simultaneous barrier, bounded ready/result timeouts, exit checks, termination, and `finally` cleanup.
- [ ] **Step 2:** First run the worker race tests against a deliberate test expectation requiring worker-isolate evidence; confirm RED before adding the helper/production concurrency adjustments.
- [ ] **Step 3 (GREEN):** Implement the worker helper and, only if the real race exposes it, minimally adjust the immediate transaction/replay/conflict handling so no `SQLITE_BUSY` or unique error leaks.
- [ ] **Step 4:** Re-run the worker race tests repeatedly and require same-hash results to contain one `created=true` plus one replay with identical ID/hash, and different-hash results to contain one success plus one closed drift conflict with one readable final row.

### Review Task 10: Review-fix integration, completion, and handoff

**Files:**
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`

- [ ] **Step 1:** Run the combined focused 8.1 suite and record final counts.
- [ ] **Step 2:** Commit executable review fixes atomically without amend/rebase/push/merge.
- [ ] **Step 3:** Run `npm run test:agent`, `npm run skills:validate`, `npm run lint`, strict OpenSpec validation, `npm test`, and `git diff --check`; require 0 test failures and lint 0 errors/26 baseline warnings.
- [ ] **Step 4:** Re-run TypeScript diagnostics from the exact base `174a800a74a5e0b032777b9c558e2463f9e64d5d` using an ordinary system-Temp clone and identical non-incremental command; require base 17, feature 17, feature-only 0.
- [ ] **Step 5:** Verify zero diff for `package-lock.json`, migrations 0001-0004, and the three generated source modules. Inspect scope and confirm 8.2-8.5 remain unchecked.
- [ ] **Step 6:** Only after all gates pass, set exactly OpenSpec 8.1 to `[x]`, re-run focused/agent/strict/diff checks, and commit the checkbox separately.
- [ ] **Step 7:** Confirm a clean worktree and preserve this branch/worktree for the next duplicate review.

---

## Second duplicate-review fix (2026-08-15)

### Review Task 11: Close the post-migration legacy-kind write bypass

**Files:**
- Modify: `server/db/migrations/0005_voc_data_snapshot.sql`
- Modify: `tests/agent/sqlite-migrations.test.ts`
- Modify: `tests/agent/data-snapshot-repository.test.ts`

**Compatibility boundary:** Rows inserted before migration 0005 retain `snapshot_kind = NULL`, including duplicate legacy identities and AgentRun links. After migration 0005, no new NULL-kind row may be inserted, and no existing data snapshot may be updated, including NULL-to-voc, NULL-to-other, voc-to-NULL, kind changes, or payload/identity changes.

- [ ] **Step 1 (RED):** Extend the real 0001-0004 upgrade test to keep duplicate legacy NULL rows and their AgentRun link, then assert a post-0005 NULL garbage insert fails. Add a fresh 0001-0005 database test that proves NULL garbage insert currently succeeds and NULL-to-voc/update mutations currently bypass immutability; isolate every attempt with transactions and assert failed attempts leave zero bad rows.
- [ ] **Step 2:** Run `npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/data-snapshot-repository.test.ts`; expect failures specifically for post-migration NULL insert and legacy-row UPDATE bypasses.
- [ ] **Step 3 (GREEN):** Add a `BEFORE INSERT ... WHEN NEW.snapshot_kind IS NULL` rejection trigger after the migration has preserved existing rows. Make `data_snapshots_update_immutable` unconditional so all legacy and VOC rows reject kind, payload, identity, and provenance updates. Keep VOC delete immutability scoped without changing legacy AgentRun read/link behavior.
- [ ] **Step 4:** Re-run focused migration/snapshot/AgentRun tests and require the legacy upgrade controls and every post-migration rejection to pass. Confirm VOC list/read filters remain discriminator-scoped so raw legacy rows cannot reach the VOC mapper.
- [ ] **Step 5:** Commit the executable fix atomically, run all full gates and protected-file/scope checks, then restore only 8.1 to `[x]` and commit that state separately.

### Review Task 12: Enforce the strict payload element contract in SQLite

**Files:**
- Modify: `server/db/migrations/0005_voc_data_snapshot.sql`
- Modify: `tests/agent/data-snapshot-repository.test.ts`

**Database boundary:** For new `snapshot_kind = 'voc'` rows, each Alexa and review-analysis array element must satisfy the same required keys, optional-key closure, scalar types, enums, ASIN membership/order, text constraints, nested report/block/row structure, and marketplace relationship as `VocSnapshotPayloadSchema@1.0.0`. Provenance references/types/count/order must correspond exactly to the non-empty payload source arrays.

- [ ] **Step 1 (RED):** Extend the raw SQL SAVEPOINT table with null/scalar/array/missing/extra/wrong-field cases for all three record arrays, plus Alexa report/text/status constraints, review date/count/status/family/block/row constraints, target ASIN membership/order, and source-to-payload count/reference/type/order mismatches. Require every attempt to fail with zero rows.
- [ ] **Step 2:** Run the snapshot repository test and observe malformed elements such as `alexaVoc: [null]` insert successfully under the current array-shell-only trigger.
- [ ] **Step 3 (GREEN):** Add NULL-safe JSON traversal predicates for Alexa records/reports/text arrays and shared review records/blocks/rows. Add target ASIN ordering and strict source-reference association predicates. Keep the valid full three-source candidate and existing partial-source service path green.
- [ ] **Step 4:** Re-run snapshot, service, migration, and AgentRun focused suites; then continue Review Task 11 Step 5 only after every deep-element and association case passes.
