# SIF Keyword Evidence Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 SIF 关键词同步从全局生成文件改造成组织隔离、run-scoped、可审计且最多三次物理请求的 PostgreSQL evidence 流水线，并按 target canonical、等价参数重试、已验证父体/主 Listing、类目代理的固定顺序有界降级。

**Architecture:** 共享 strict contracts 定义 target-scoped evidence、无 target 的共享 category lookup/result、provider adapter 和 run-scoped API；PostgreSQL/SQLite repository 持久化不可变 evidence、logical attempts、物理 request receipts、stage binding 与 enrichment revision。同步 worker 只接受并反查完整 committed scope，经版本化 capability registry 选择严格 adapter，在每次网络 dispatch 前原子 reserve receipt；category 查询按 organization/job/category/params 只产生一个共享 `lookupId`，随后为每个 requested target 分别 materialize 唯一 `evidenceId`。浏览器、导出和 product-definition 统一调用认证的 run-scoped read service，不再读取按 ASIN latest cache 或 client-side 生成 TS。

**Tech Stack:** TypeScript 5.9、Node.js 22、Zod 4、Fastify 5、PostgreSQL/SQLite、React 19、Node test runner（`tsx --test`）、现有 MCP connector 与 sync-job/stage-output 基础设施。

## Global Constraints

- 规划/预检基线固定为 `a5d233bdfe977fb33d814b79a89352d567d3d6c5`。该 HEAD 只有 Plan 01 migrations `0019`/`0020`；`0021`、`0022` 和本计划核心 symbols 均不存在。本计划只覆盖 Phase 3，并且只有在统一恢复计划 Batch 0 通过、Plan 02 Task 8 acceptance commit 完成、SQLite/PostgreSQL `0021_comparison_project_scope` 升级与 comparison/Manual 回归全部通过后才允许开始。执行顺序固定为 Plan 01（`0019`/`0020`）→ Plan 02（`0021`）→ 本计划（`0022`），不得并行执行、跳号、改号或把前两个切片的工作塞回本计划。
- 首发 marketplace 只有 `US`。organization 从认证 principal 或 repository 中的 committed scope 取得；Web body、环境默认组织、全局 catalog ASIN、全局 TS 数据都不能补齐缺失 scope。
- `app/sif-keyword-analysis-data.ts` 与 `app/sif-keyword-enrichment-data.ts` 只能由 server-only migration/diagnostic reader 使用；禁止进入浏览器依赖图，也不是运行时 fallback。
- 关键词 client import 移除和 bundle gate 的唯一所有者是本计划 Task 10/12。Task 8/9 修改 `shared/agent-contracts.ts`、Task 10 修改 `app/page.tsx` 时都必须从 Plan 01/02 提交后的版本开始，保留 Manual VOC 与 Comparison 的既有合同、`comparisonDraft/committedScope`、state/session/overlay 逻辑；不得恢复、覆盖或复制前两计划的实现。
- Task 10/11 的 cutover 范围必须覆盖所有当前 static keyword 消费者：`app/page.tsx`、`app/keyword-fetch-status.tsx`、`app/keyword-demand-analysis.ts`、`app/keyword-demand-conclusions.ts`、`app/lib/stage-output-view.ts`，以及经 `app/product-launch-analysis.ts` 间接消费关键词的 launch/VOC positioning/product definition/checklist 组件。页面必须把同一个 run-scoped keyword evidence view 与同一个 `manualVocByAsin` owner 合并成显式产品分析 source；不得让任何 consumer 在参数缺失时退回全局 TS，也不得丢失 Manual VOC 的 session/org epoch fencing。
- 所有新增表只做向前 migration；回滚不 drop、不 delete、不重写 evidence mode。六个 feature flags 默认关闭且彼此独立；运维推荐按 canonical → parameter retry → parent/main → category/cross-validation 顺序开启、反向关闭，但 schema/runtime 不强制依赖关系。
- 不调用 provider “余额查询”。每个 target 的所有 SIF 物理 HTTP dispatch（含 connector 网络 retry）合计硬上限为 3；每次 dispatch 必须有独立 receipt。reserve 后交给网络栈即 consume，成功、4xx、5xx、timeout、结果未知都不退；仅证明从未发送时 release。
- Sorftime 只能验证 relationship/category 或形成销售、评论、价格、趋势 cross-validation；不得生成、覆盖或补齐 SIF target traffic share、rank、keyword count 或关键词列表。
- `ready` 必须有非空 keywords 且 `terminalReason=null`；`empty` 只能是 strict-valid 空响应及 `valid-empty`；`unavailable`、`schema-error`、`quota-blocked` 必须是空 keywords，并使用与状态匹配的 terminal reason。
- 日志、metrics、API、stage output、export 不得包含 credential、header、endpoint、raw response、provider error body、内部 receipt id 或 tenant-wide dataset。
- 每个任务先 RED、再最小 GREEN、再 scoped regression；只有列出的文件可加入该任务 commit。不要 stage 用户已有 WIP、生成数据、publication state 或服务配置，不启动/重启正式服务，不调用真实 provider，不 push。
- 测试中的 provider 响应全部使用 inline fixture 或本地 fake transport。所有时间、UUID、hash、capability descriptor 和 receipt settlement 均注入确定性依赖。
- Category dedupe 只能复用无 `targetAsin` 的共享 `KeywordCategoryLookup`。每个 requested target 必须拥有独立、不可变、target-scoped `KeywordEvidence` 与 `evidenceId`，其 `categoryLookupId` 引用共享结果；禁止把一个 evidence id 绑定、返回或计作多个 target 的 coverage。
- 当前全树 `npx tsc --noEmit --incremental false --pretty false` 已确认 exit 2、306 diagnostics。逐 Task GREEN 使用 focused/affected tests、changed-path TypeScript diagnostics=0、列出文件 ESLint 与 diff-check；不得写成 full-tree typecheck PASS。Task 12/统一恢复计划 Batch 7 才重跑全树 compiler，并把 306 条基线分为保留、已解决、实现新增；实现新增必须为 0，总数不得增加。
- Migration head expectations are numeric and sequential: Plan 02 acceptance expects 21; Task 2 RED changes every latest-head assertion to 22 and must fail against 21; Task 2 GREEN and every subsequent Plan 03 focused/acceptance test expect exactly 22.

---

## Changed-path TypeScript Gate

Run this helper in the PowerShell execution shell before each Task GREEN command:

```powershell
function ConvertTo-NormalizedTscDiagnostic([string]$Line) {
  $normalized = $Line.Replace('\\', '/')
  if ($normalized -match '^([^\(]+)\(\d+,\d+\): error (TS\d+): (.*)$') {
    return "$($Matches[1])|$($Matches[2])|$($Matches[3])"
  }
  return $null
}

function Add-OccurrenceIndex([string[]]$Items) {
  $counts = @{}
  foreach ($item in $Items) {
    $next = 1 + [int]($counts[$item] ?? 0)
    $counts[$item] = $next
    "$item|occurrence=$next"
  }
}

function Assert-NoAffectedTypeDiagnostics([string[]]$Paths) {
  $baselinePath = '.superpowers/sdd/voc-keyword-tsc-baseline.txt'
  if (-not (Test-Path -LiteralPath $baselinePath)) { throw "Missing frozen TypeScript baseline" }
  $output = @(& npx tsc --noEmit --incremental false --pretty false 2>&1)
  $normalizedPaths = @($Paths | ForEach-Object { $_.Replace('\\', '/') })
  $baseline = @(Add-OccurrenceIndex @(Get-Content -LiteralPath $baselinePath | ForEach-Object { ConvertTo-NormalizedTscDiagnostic "$_" } | Where-Object { $_ } | Sort-Object))
  $current = @(Add-OccurrenceIndex @($output | ForEach-Object { ConvertTo-NormalizedTscDiagnostic "$_" } | Where-Object { $_ } | Sort-Object))
  $baselineAffected = @($baseline | Where-Object { $normalizedPaths -contains ($_ -split '\|', 2)[0] })
  $currentAffected = @($current | Where-Object { $normalizedPaths -contains ($_ -split '\|', 2)[0] })
  $introduced = @(Compare-Object $baselineAffected $currentAffected | Where-Object SideIndicator -eq '=>' | ForEach-Object InputObject)
  if ($introduced.Count -gt 0) {
    $introduced | ForEach-Object { Write-Error "$_" }
    throw "Introduced affected TypeScript diagnostics: $($introduced.Count)"
  }
  Write-Host "Introduced affected TypeScript diagnostics: 0; retained affected baseline: $($currentAffected.Count)"
}
```

The full-tree process exit remains non-zero until baseline remediation is complete; this helper does not convert that failure into a repository-wide success claim.

---

## Task 1: 定义 strict evidence contracts 与版本化 SIF capability registry

**Files:**

- Create: `shared/keyword-evidence-contracts.ts`
- Create: `scripts/lib/sif-keyword-capability-registry.mjs`
- Create: `scripts/lib/sif-keyword-strict-adapter.mjs`
- Create: `server/connectors/sif-keyword-capability-source.ts`
- Create: `server/connectors/provider-contracts/sif/manifest.json`
- Modify: `scripts/lib/sif-keyword-sync-config.mjs`
- Create: `tests/fixtures/providers/sif-tools-list.contract-test.json`
- Test: `tests/scripts/sif-keyword-strict-adapter.test.mjs`
- Test: `tests/agent/keyword-evidence-contract.test.ts`

**Interfaces:**

- Consumes: current canonical `market_get_asin_keyword_signals` semantic and `SIF_KEYWORD_QUERY_WINDOW`; production alternate/category operations are accepted only from an official-document or previously saved, sanitized `tools/list` contract fixture.
- Produces: `SifKeywordEvidenceSchema`, `KeywordCategoryLookupSchema`, `KeywordEvidenceApiResponseSchema`, `KeywordAttemptSummarySchema`, `KeywordEnrichmentReferenceSchema`, `CrossValidationFactSchema`, strict adapter result, and a fail-closed registry resolver.
- Constant: `KEYWORD_EVIDENCE_SCHEMA_VERSION="1.0.0"`. `providerVersion`, operation, query variant and parameter mapping come from the approved fixture descriptor hash; no invented production version literal is allowed.

- [ ] Write contract tests proving all five statuses retain a mode, invalid status/reason combinations fail, category proxy rejects listing traffic/rank, ready rejects empty keywords, and API quota summary cannot contain receipt ids. `KeywordCategoryLookupSchema` must reject `targetAsin`; category-proxy evidence must require `categoryLookupId` and one target ASIN. Two category evidences may share one lookup id only when their `evidenceId` and `targetAsin` differ.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { SifKeywordEvidenceSchema } from "../../shared/keyword-evidence-contracts";

test("category proxy cannot impersonate target listing traffic", () => {
  const result = SifKeywordEvidenceSchema.safeParse({
    ...validEvidence("category-proxy"),
    status: "ready",
    keywords: [{ ...validCategoryKeyword(), trafficShare: 12.3 }],
  });
  assert.equal(result.success, false);
});

test("quota blocked evidence contains no residual keyword values", () => {
  const result = SifKeywordEvidenceSchema.safeParse({
    ...validEvidence("target-canonical"),
    status: "quota-blocked",
    terminalReason: "physical-attempt-limit",
    keywords: [validListingKeyword()],
  });
  assert.equal(result.success, false);
});
```

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-contract.test.ts
node --test tests/scripts/sif-keyword-strict-adapter.test.mjs
```

Expected: both commands fail because the new contract and strict adapter modules do not exist.

- [ ] Implement strict shared types. Use a discriminated union for keyword rows so `category-proxy` rows structurally omit `trafficShare`, `organicRank`, `advertisingRank`, and target listing count. Add `superRefine` for the status/terminal-reason matrix:

```ts
export const KeywordEvidenceModeSchema = z.enum([
  "target-canonical", "target-parameter-retry", "parent-listing", "category-proxy",
]);

const terminalReasonsByStatus = {
  ready: new Set([null]),
  empty: new Set(["valid-empty"]),
  unavailable: new Set(["capability-unknown", "provider-unavailable", "identity-unverified", "category-unverified"]),
  "schema-error": new Set(["schema-invalid"]),
  "quota-blocked": new Set(["request-budget-unavailable", "request-budget-exhausted", "physical-attempt-limit"]),
} as const;
```

Define `KeywordCategoryLookupSchema` as a strict discriminated union over shared base `lookupId,organizationId,projectId,runId,stageId:"keywords",jobId,marketplace,categoryId,paramsHash,schemaVersion,providerVersion`: `state:"pending"` has null result/provenance fields, while `state:"terminal"` has the same status/reason/keywords matrix as evidence plus `operation,queryVariant,queryWindow,fetchedAt,contentHash`. `operation/queryVariant` are non-null for a dispatched provider result and may be null only for pre-dispatch `capability-unknown` or request-budget rejection; the schema tests this cross-field rule. Neither branch has `targetAsin`, relationship evidence, cross-validation, or stage binding. The `category-proxy` branch of `SifKeywordEvidenceSchema` adds `categoryLookupId` and `categoryLookupContentHash`; every other mode requires both fields to be null. Target-specific `CategoryEvidence` remains on the evidence record and proves why that target belongs to the shared category.

- [ ] Define a registry constructor that is empty/fail-closed by default and compiles only audited fixture entries. Do not hardcode an alternate parameter spelling, category tool name, or provider version:

```js
export function createSifKeywordCapabilityRegistry({
  approvedFixtures = [],
  allowTestFixtures = false,
} = {}) {
  const fixtures = approvedFixtures.map(fixture => ApprovedSifCapabilityFixtureSchema.parse(fixture));
  const permitted = fixtures.filter(fixture =>
    fixture.source !== "test-only" || allowTestFixtures,
  );
  return Object.freeze({
    resolve(input) {
      const exact = permitted.find(fixture =>
        fixture.descriptorSha256 === input.descriptorSha256 &&
        fixture.providerVersion === input.providerVersion,
      );
      return exact ? compileAuditedMappings(exact, input.semantic) : null;
    },
  });
}
```

`ApprovedSifCapabilityFixtureSchema` is strict and contains `source: "official-document" | "saved-tools-list" | "test-only"`, `descriptorSha256`, `providerVersion`, sanitized operation/input/response schemas, semantic mapping, captured/reviewed timestamps and reviewer id. Production rejects `test-only`; the tracked test fixture exercises mechanics only and cannot authorize a production operation. If no approved exact fixture proves canonical, alternate or category capability, resolver returns null and the evidence is `unavailable/capability-unknown` without HTTP. It never guesses keys, selects “latest”, or treats a synthetic unit fixture as provider proof. Capability discovery is separately governed and cached by descriptor hash; this plan makes no real provider call.

- [ ] Add a server-only capability source. `server/connectors/provider-contracts/sif/manifest.json` starts as exact JSON `{ "schemaVersion": "1.0.0", "fixtures": [] }`; `loadApprovedSifKeywordCapabilities()` loads only manifest-listed files beneath that directory, verifies each SHA-256 against the manifest and rejects traversal, duplicate semantic/version, test-only source, or checksum mismatch. No runtime env/body may inject a mapping. A separately reviewed provider-contract commit may add an official/saved sanitized fixture and manifest checksum; until that approval exists, production correctly returns `capability-unknown`.

- [ ] Implement strict response schemas: top-level keys, optional pagination, summary, echoed ASIN/category identity, keyword rows, finite nonnegative counts/ranks/bids, and ratios in `[0,1]`. Unknown keys, strings masquerading as numbers, identity mismatch, or malformed pagination return `schema-error/schema-invalid` and never return partial rows.

- [ ] Add fixture tests for canonical nonempty, strict empty, unknown top-level field, wrong numeric type, echoed identity mismatch, category rows, empty production registry, descriptor hash/version mismatch, production rejection of `test-only`, and an injected `allowTestFixtures:true` registry. Assert only `INVALID_ARGUMENT` and `UNSUPPORTED_PARAMETER` are classified as parameter compatibility errors; alternate/category semantics resolve only when the injected fixture explicitly contains them.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-contract.test.ts
node --test tests/scripts/sif-keyword-strict-adapter.test.mjs
Assert-NoAffectedTypeDiagnostics @('shared/keyword-evidence-contracts.ts','server/connectors/sif-keyword-capability-source.ts','tests/agent/keyword-evidence-contract.test.ts')
```

Expected: all contract/adapter cases pass and listed TypeScript paths have zero diagnostics; malformed fixtures fail closed, shared lookup rejects target identity, and no keyword result crosses target scope.

- [ ] Commit:

```powershell
git add shared/keyword-evidence-contracts.ts scripts/lib/sif-keyword-capability-registry.mjs scripts/lib/sif-keyword-strict-adapter.mjs scripts/lib/sif-keyword-sync-config.mjs server/connectors/sif-keyword-capability-source.ts server/connectors/provider-contracts/sif/manifest.json tests/fixtures/providers/sif-tools-list.contract-test.json tests/scripts/sif-keyword-strict-adapter.test.mjs tests/agent/keyword-evidence-contract.test.ts
git commit -m "feat(keywords): define strict SIF evidence contracts"
```

## Task 2: 新增 evidence、attempt、binding、budget 与 enrichment 向前迁移

**Files:**

- Create: `server/db/migrations/0022_keyword_evidence.sql`
- Create: `server/db/migrations/postgres/0022_keyword_evidence.sql`
- Modify: `tests/agent/sqlite-migrations.test.ts`
- Modify: `tests/agent/postgres-migrations.test.ts`
- Modify: `tests/agent/product-definition-runtime.test.ts`

**Interfaces:**

- Consumes: Plan 02 committed `projects/analysis_runs`; PostgreSQL additionally consumes existing `sync_jobs`. SQLite has no sync-job/stage-output tables and must not reference them.
- Produces: cross-backend `keyword_evidence_subjects`, `keyword_category_lookups`, `keyword_evidences`, `keyword_evidence_attempts`, `keyword_request_budget_receipts`, `keyword_stage_evidence_bindings`, `keyword_enrichment_revisions` and their uniqueness/check constraints.

- [ ] Write migration tests that upgrade from Plan 02 head 21 and fresh install, then inspect tables, FKs, composite unique indexes, immutable-update triggers, and status checks. Before creating migration files, change every latest-head assertion, including `tests/agent/product-definition-runtime.test.ts`, to 22 and preserve RED evidence showing current head 21. Add a negative test that cannot bind an evidence row from another organization/job/run, plus a category test that inserts one shared lookup and two distinct target evidences but rejects reuse of either target evidence id for the other target.

```ts
test("keyword evidence binding rejects mixed immutable subjects", async () => {
  await migrateCurrentDatabase(db);
  await seedProjectRunAndEvidenceSubject(db, { organizationId: "org-a", projectId: "project-a", runId: "run-a", stageId: "keywords", jobId: "job-a" });
  await seedProjectRunAndEvidenceSubject(db, { organizationId: "org-b", projectId: "project-b", runId: "run-b", stageId: "keywords", jobId: "job-b" });
  await insertKeywordEvidence(db, { organizationId: "org-a", jobId: "job-a", evidenceId: "ev-a" });
  await assert.rejects(() => bindKeywordEvidence(db, {
    organizationId: "org-b", projectId: "project-b", runId: "run-b", stageId: "keywords", jobId: "job-b", evidenceId: "ev-a",
  }));
});
```

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts tests/agent/product-definition-runtime.test.ts
```

Expected: new table/index assertions fail because migration 0022 is absent.

- [ ] Create a cross-backend subject root before evidence tables. `keyword_evidence_subjects` has immutable `(organization_id,project_id,run_id,stage_id,job_id)` identity, `stage_id='keywords'`, `marketplace`, ordered target ASIN JSON, `data_cutoff_at`, capability descriptor SHA-256, provider/schema version and quota policy id. Evidence, attempts, receipts and bindings reference this subject instead of directly assuming every backend has a sync-job table.

- [ ] PostgreSQL runtime subject registration will use one `INSERT ... SELECT` joined through project → run → `sync_jobs` and verify the job's strict `stages` JSON contains `keywords`; it must not require a `sync_job_stage_outputs` row before the worker can start. Task 2 PostgreSQL migration tests may seed a subject only after seeding that valid project/run/sync-job chain. SQLite migration references only existing project/run tables and never names `sync_jobs` or `sync_job_stage_outputs`; its Task 2 fixture inserts a valid immutable subject directly after project/run and proves composite evidence/binding constraints. Task 3 owns the public repository registration method, and Task 5 supplies its verified runtime scope—Task 2 calls neither task's code.

- [ ] Create the shared category lookup/result table before target evidence. `keyword_category_lookups` has immutable `lookup_id` plus full subject FK fields and a semantic unique key exactly `(organization_id,job_id,marketplace,category_id,params_hash,schema_version,provider_version)`. It contains `state`, hashed claim token, lease expiry and, after the single legal compare-and-swap `pending -> terminal` transition, strict normalized category keywords, status/reason, nullable operation/query variant, window/fetched-at/content hash. DB checks mirror Task 1: operation/query variant are required after provider dispatch and null only for typed pre-dispatch terminal reasons. Expired pending ownership may rotate token/lease without changing lookup id; terminal payload/state cannot change. It has no `target_asin` column and cannot be stage-bound. Triggers enforce the transition and reject terminal UPDATE/DELETE.

- [ ] Create target evidence tables with these identities and checks:

```sql
-- PostgreSQL semantic key; SQLite uses COALESCE expressions in an equivalent unique index.
UNIQUE NULLS NOT DISTINCT (
  organization_id, job_id, marketplace, target_asin, mode,
  lookup_asin, category_id, category_lookup_id, params_hash, schema_version, provider_version
)
```

`keyword_evidences` stores immutable normalized JSON only (`keywords_json`, `relationship_evidence_json`, target-specific `category_evidence_json`, `cross_validation_json`, `enrichment_revision_ids_json`, `query_window_json`) plus nullable `category_lookup_id/category_lookup_content_hash`, `status`, `terminal_reason`, `operation`, hashes/versions/timestamps. Add DB checks for target/lookup/category mode relationships and status/reason compatibility. `category-proxy` requires an FK to a terminal lookup in the same full subject/category/provider/schema scope; all other modes require null lookup fields. The target-specific semantic key always includes `target_asin`, so one shared lookup can back multiple evidence rows but one evidence row can never cover multiple targets.

- [ ] Make attempt rows append-only with `(evidence_id, logical_attempt_number)` unique. Make receipt rows append-only except one legal settlement transition `reserved -> consumed|released`; fields are `organization_id,job_id,provider,operation,target_asin,category_id,category_lookup_id,mode,params_hash,reserved_at,handed_to_network_at,settled_at,state,result_code,duration_ms`. The category owner dispatch receipt may retain its initiating target for that target's physical cap and references the shared lookup id; waiters create no receipt because they send no HTTP request. Do not store URL, request body, response body, credential, or raw error.

- [ ] Make binding identity exactly `(organization_id,project_id,run_id,stage_id,job_id,evidence_id)` with stage check `keywords`, a composite FK to `keyword_evidence_subjects`, a scoped FK to evidence, and an immutable trigger that rejects UPDATE/DELETE. PostgreSQL subject creation proves the live project/run/sync-job chain before dispatch; Task 8 atomically couples bindings to the finalized `sync_job_stage_outputs` row. SQLite proves the equivalent scope through Task 5 service validation and the immutable subject row. Add unique `(organization_id,run_id,stage_id,evidence_id)`.

- [ ] Put category dedupe uniqueness only on `keyword_category_lookups`, never on `keyword_evidences`. Add an evidence scoped uniqueness/FK that prevents the same `evidence_id` from being associated with two `target_asin` values. Add enrichment cache uniqueness on `(organization_id,marketplace,keyword,params_hash,schema_version,provider_version,window_start,window_end,revision)`.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts tests/agent/product-definition-runtime.test.ts
Assert-NoAffectedTypeDiagnostics @('tests/agent/sqlite-migrations.test.ts','tests/agent/postgres-migrations.test.ts','tests/agent/product-definition-runtime.test.ts')
```

Expected: fresh/upgrade paths pass and listed TypeScript paths have zero diagnostics; invalid cross-scope binding, terminal lookup mutation, target-less lookup violations, and multi-target evidence reuse are rejected on both engines.

- [ ] Commit:

```powershell
git add server/db/migrations/0022_keyword_evidence.sql server/db/migrations/postgres/0022_keyword_evidence.sql tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts tests/agent/product-definition-runtime.test.ts
git commit -m "feat(db): add scoped keyword evidence ledger"
```

## Task 3: 实现 KeywordEvidenceRepository 与组织隔离 stores

**Files:**

- Create: `server/db/keyword-evidence-repository.ts`
- Create: `server/db/postgres/keyword-evidence-store.ts`
- Modify: `server/db/repository.ts`
- Modify: `server/db/postgres-repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Test: `tests/agent/postgres-keyword-evidence-repository.test.ts`
- Test: `tests/agent/sqlite-keyword-evidence-repository.test.ts`

**Interfaces:**

- Consumes: `SifKeywordEvidence`, complete scope and migration tables.
- Produces: one runtime authority for verified subject registration, shared category lookup claim/completion/read, per-target evidence materialization/read, attempt append, stage binding, enrichment revision, budget reserve/settle/count.

- [ ] Write repository conformance tests against both engines. Cover idempotent same target semantic key+same content, conflict on same key+different content, organization/job isolation, immutable evidence id, ordered `findBoundEvidenceForRun`, and redacted receipt aggregation. For category concurrency, two target callers in the same organization/job/category/params must receive one lookup id and one owner, then materialize two different evidence ids whose target ASINs remain distinct; cross-job/category/params lookup reuse and binding one evidence to the other target must fail.

```ts
export interface KeywordEvidenceRepository {
  registerVerifiedSubject(input: RegisterVerifiedKeywordSubjectInput): Promise<KeywordEvidenceSubjectRecord>;
  createEvidence(input: CreateKeywordEvidenceInput): Promise<{ evidence: SifKeywordEvidenceRecord; created: boolean }>;
  appendAttempt(input: AppendKeywordAttemptInput): Promise<void>;
  reservePhysicalRequest(input: ReserveKeywordRequestInput): Promise<KeywordRequestReservation>;
  markRequestHandedToNetwork(input: MarkKeywordRequestSentInput): Promise<void>;
  settlePhysicalRequest(input: SettleKeywordRequestInput): Promise<void>;
  claimCategoryLookup(input: ClaimCategoryLookupInput): Promise<CategoryLookupClaim>;
  completeCategoryLookup(input: CompleteCategoryLookupInput): Promise<KeywordCategoryLookupRecord>;
  findCategoryLookup(input: FindCategoryLookupInput): Promise<KeywordCategoryLookupRecord | null>;
  materializeCategoryEvidence(input: MaterializeCategoryEvidenceInput): Promise<{ evidence: SifKeywordEvidenceRecord; created: boolean }>;
  bindEvidenceToStage(input: BindKeywordEvidenceInput): Promise<void>;
  findBoundEvidenceForRun(input: FindBoundKeywordEvidenceInput): Promise<readonly SifKeywordEvidenceRecord[]>;
  upsertEnrichmentRevision(input: CreateKeywordEnrichmentRevisionInput): Promise<KeywordEnrichmentRevisionRecord>;
}

type CategoryLookupClaim =
  | Readonly<{ kind: "owner"; lookupId: string; claimToken: string }>
  | Readonly<{ kind: "waiter"; lookupId: string }>;
```

`ClaimCategoryLookupInput` carries the full immutable subject, `categoryId,paramsHash,schemaVersion,providerVersion,claimantId,claimedAt,leaseMs`. `CompleteCategoryLookupInput` carries `lookupId,claimToken,status,terminalReason,keywords,operation,queryVariant,queryWindow,fetchedAt,contentHash,completedAt`. `FindCategoryLookupInput` carries actor organization plus full subject and lookup id; it cannot query by category alone. All three strict schemas reject `targetAsin`. `KeywordCategoryLookupRecord` is the storage-parsed Task 1 union.

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/postgres-keyword-evidence-repository.test.ts tests/agent/sqlite-keyword-evidence-repository.test.ts
```

Expected: repository modules and RuntimeAgentRepository members are missing.

- [ ] Define `RegisterVerifiedKeywordSubjectInput` in `server/db/keyword-evidence-repository.ts` with `organizationId,projectId,runId,stageId:"keywords",jobId,marketplace,orderedTargetAsins,dataCutoffAt,capabilityDescriptorSha256,providerVersion,schemaVersion,quotaPolicyId`. PostgreSQL `registerVerifiedSubject` performs `INSERT ... SELECT` against the committed project/run/sync-job chain and validates `keywords` membership in the job's strict `stages` JSON. SQLite validates project/run ownership, ordered project ASINs, marketplace and cutoff against existing tables, then inserts the immutable subject; it never queries nonexistent sync tables. Conformance tests call this method before evidence writes and reject forged/mismatched project/run/ASIN/cutoff. Task 5 separately proves the service never calls this method until its injected `SyncJobScopeReader` verifies job/stage scope.

- [ ] Implement validation before SQL using shared Zod schemas. Every evidence/attempt/receipt/binding write first resolves the exact immutable subject. Generate `evidenceId` and `lookupId` from separately injected UUID sources once. `claimCategoryLookup` atomically inserts or returns the unique organization/job/category/params row; the owner receives an opaque claim token, only that token can perform the single terminal completion, and waiters read the same lookup id. Owner error handling completes a typed terminal result; a resume may reclaim an expired pending lease with the same lookup id only through repository compare-and-swap, never by inserting a second lookup. On evidence semantic conflict, lock/read the existing target row and compare canonical content hash. Same target+content replays its evidence id; different target always materializes a distinct evidence id even when `categoryLookupId` is shared; same target+different content throws `KeywordEvidenceConflictError`.

- [ ] Define `MaterializeCategoryEvidenceInput` with full immutable subject identity, `targetAsin`, terminal `lookupId`, target-specific `categoryEvidence`, relationship/cross-validation facts and enrichment revision ids. In one transaction, load the terminal lookup by exact organization/project/run/stage/job/category/provider/schema scope, copy or join its immutable keyword payload/provenance, require the target in `orderedTargetAsins`, and create the target-scoped category-proxy evidence. Reject an input-supplied keyword/provider payload that differs from the lookup. Never return the lookup id as an evidence id and never bind a lookup directly to a stage.

- [ ] Implement every read with actor organization and full subject/binding filters, never `WHERE target_asin = ? ORDER BY fetched_at DESC`. PostgreSQL `findBoundEvidenceForRun` additionally joins `sync_jobs` and finalized `sync_job_stage_outputs`; SQLite joins its immutable subject, project/run, binding and evidence. Both reject if the requested set differs from the bound set.

- [ ] Add the interface to `RuntimeAgentRepository`, instantiate `PostgresKeywordEvidenceStore` with the existing Postgres query context, and implement the same methods inside the repository's existing monolithic `SqliteAgentRepository` transaction boundary. Delegate each PostgreSQL method explicitly. Do not expose raw query contexts or SQLite handles to routes, UI assemblers, or export.

- [ ] Ensure returned records are deep-frozen and parsed from storage; corrupt JSON or invalid status/reason throws `KeywordEvidenceDataError`, not an empty result.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/postgres-keyword-evidence-repository.test.ts tests/agent/sqlite-keyword-evidence-repository.test.ts
Assert-NoAffectedTypeDiagnostics @('server/db/keyword-evidence-repository.ts','server/db/postgres/keyword-evidence-store.ts','server/db/repository.ts','server/db/postgres-repository.ts','server/db/sqlite-repository.ts','tests/agent/postgres-keyword-evidence-repository.test.ts','tests/agent/sqlite-keyword-evidence-repository.test.ts')
```

Expected: both stores pass identical isolation, idempotency, immutability, shared-lookup/per-target-evidence, dedupe, coverage and corruption tests; listed TypeScript paths have zero diagnostics.

- [ ] Commit:

```powershell
git add server/db/keyword-evidence-repository.ts server/db/postgres/keyword-evidence-store.ts server/db/repository.ts server/db/postgres-repository.ts server/db/sqlite-repository.ts tests/agent/postgres-keyword-evidence-repository.test.ts tests/agent/sqlite-keyword-evidence-repository.test.ts
git commit -m "feat(keywords): persist immutable scoped evidence"
```

## Task 4: 在物理 HTTP dispatch 边界实现 request budget ledger

**Files:**

- Modify: `server/connectors/connector-contract.ts`
- Modify: `server/connectors/remote-mcp-connector.ts`
- Modify: `server/connectors/mcp-connectors.ts`
- Modify: `scripts/lib/sif-mcp-client.mjs`
- Modify: `scripts/lib/postgres-resource-governor.mjs`
- Create: `server/services/keyword-request-budget-service.ts`
- Test: `tests/agent/keyword-request-budget.test.ts`
- Test: `tests/agent/remote-mcp-connector.test.ts`
- Test: `tests/scripts/sif-physical-request-budget.test.mjs`

**Interfaces:**

- Consumes: repository `reservePhysicalRequest/markRequestHandedToNetwork/settlePhysicalRequest`, connector scope, and injected fetch.
- Produces: one receipt per real SIF fetch, target cap 3, per-job/category cap, and typed admission results without pretending provider credits exist.

- [ ] Write RED tests with an injected fetch spy: a connector operation has at most two attempts; each attempt creates one consumed receipt; timeout consumes; HTTP 500 consumes; local input validation releases; the next logical fallback may consume the third receipt; the fourth physical SIF dispatch is blocked before fetch; ledger unavailable blocks before fetch. For a Task 3 claimed shared category lookup, only the `owner` may enter the connector and create a receipt tagged with `categoryLookupId`; `waiter` callers never enter fetch and create no receipt.

```ts
test("two-attempt connector plus logical fallback stop at three receipts", async () => {
  const fetches: string[] = [];
  const connector = createSifConnector(keywordBudgetFixture({
    fetchImpl: sequenceFetch(fetches, [
      () => { throw { kind: "http", status: 503 }; },
      () => strictEmptyResponse("B0D31VY644"),
      () => strictParentResponse("B0PARENT01"),
    ]),
    maxAttempts: 2,
  }));
  await connector.execute(scopedKeywordRequest("B0D31VY644", "target-canonical"));
  await connector.execute(scopedKeywordRequest("B0D31VY644", "parent-listing"));
  await assert.rejects(
    () => connector.execute(scopedKeywordRequest("B0D31VY644", "category-proxy")),
    /physical-attempt-limit/,
  );
  assert.equal(fetches.length, 3);
  assert.deepEqual(await receiptStates(), ["consumed", "consumed", "consumed"]);
  assert.equal(await attemptedCategoryFetches(), 0);
});
```

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-request-budget.test.ts tests/agent/remote-mcp-connector.test.ts
node --test tests/scripts/sif-physical-request-budget.test.mjs
```

Expected: retries are only governed as logical attempts and no keyword receipt service/cap exists.

- [ ] Extend `ConnectorRequest` with a strict optional dispatch scope rather than environment fallbacks:

```ts
type PhysicalRequestBudgetScope = Readonly<{
  organizationId: string; jobId: string; provider: "sif" | "sorftime";
  operation: string; targetAsin: string; categoryId: string | null;
  categoryLookupId: string | null; mode: KeywordEvidenceMode;
  paramsHash: string; quotaPolicyId: string;
}>;
```

For keyword operations this scope is mandatory. Other existing connector operations retain their existing governor behavior.

- [ ] Move SIF keyword accounting into the wrapper immediately around each `fetchImpl(...)`. Sequence: validate local payload and initialize connector → reserve atomically → call `markRequestHandedToNetwork` immediately before invoking fetch → settle consumed in `finally` if handed off, otherwise released. A connector retry re-enters this sequence and reserves a new receipt.

- [ ] Export strict `KeywordRequestBudgetPolicySchema` and inject one immutable policy `{id,enabled,targetSifPhysicalCap:3,perJobCategoryCap,enrichmentOperationCaps}` into the budget service. In one repository transaction, reject reserve if count of non-released target SIF receipts is already 3, if the injected policy is missing/invalid/disabled, or per-job/category cap is exhausted. Map these to `quota-blocked/request-budget-unavailable`, `request-budget-exhausted`, or `physical-attempt-limit`; do not call fetch after rejection. Do not assume a provider balance API or an undeclared database policy row.

- [ ] Reconciler may release only reservations with `handed_to_network_at IS NULL` and an expired lease. It must never release a sent/unknown receipt. Store only a fixed redacted `resultCode` enum and duration.

- [ ] Preserve the existing generic connector policy invariant `maxAttempts <= 2`; never raise it for keyword work. A logical canonical/alternate/parent/category transition is orchestrator-owned and starts another connector execution only when its semantic gate permits, while all executions share the same three-receipt target ledger. Add explicit tests that 401/403, provider quota response, schema-error, and cancellation after handoff do not create an unaccounted dispatch.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-request-budget.test.ts tests/agent/remote-mcp-connector.test.ts
node --test tests/scripts/sif-physical-request-budget.test.mjs
Assert-NoAffectedTypeDiagnostics @('server/connectors/connector-contract.ts','server/connectors/remote-mcp-connector.ts','server/connectors/mcp-connectors.ts','server/services/keyword-request-budget-service.ts','tests/agent/keyword-request-budget.test.ts','tests/agent/remote-mcp-connector.test.ts')
```

Expected: focused tests pass and listed TypeScript paths have zero diagnostics; every observed fetch corresponds to one consumed receipt, waiters send no HTTP/create no receipt, released receipts prove fetch was never entered, and maximum SIF fetches per initiating target is three.

- [ ] Commit:

```powershell
git add server/connectors/connector-contract.ts server/connectors/remote-mcp-connector.ts server/connectors/mcp-connectors.ts scripts/lib/sif-mcp-client.mjs scripts/lib/postgres-resource-governor.mjs server/services/keyword-request-budget-service.ts tests/agent/keyword-request-budget.test.ts tests/agent/remote-mcp-connector.test.ts tests/scripts/sif-physical-request-budget.test.mjs
git commit -m "feat(keywords): account every physical SIF request"
```

## Task 5: 传递并反查完整 worker scope

**Files:**

- Modify: `server/db/sync-job-repository.ts`
- Modify: `server/db/postgres/sync-job-store.ts`
- Modify: `server/services/sync-job-worker-handler.ts`
- Create: `server/services/keyword-worker-scope-service.ts`
- Modify: `server/runtime/sync-job-dispatcher.ts`
- Modify: `scripts/run-asin-sync-job.mjs`
- Create: `scripts/lib/keyword-worker-scope.mjs`
- Test: `tests/agent/sync-job-keyword-scope.test.ts`
- Test: `tests/scripts/keyword-worker-scope.test.mjs`

**Interfaces:**

- Consumes: committed project/run/sync-job scope from Plan 02, Task 3 `registerVerifiedSubject`, Task 1 approved capability selection, and Task 4 `KeywordRequestBudgetPolicySchema`.
- Produces: frozen `KeywordWorkerScope` containing `organizationId,jobId,projectId,runId,stageId:"keywords",marketplace,orderedTargetAsins,dataCutoffAt,capabilityDescriptorSha256,providerVersion,schemaVersion,quotaPolicyId`.

- [ ] Write tests that omit or alter each field one at a time. Assert worker exits before connector/repository write and does not use `SIF_ASINS`, global catalog, `AGENT_EXECUTION_ORGANIZATION_ID`, or generated TS as a fallback.

```js
test("keyword worker fails closed when ordered target scope differs from committed project", async () => {
  await assert.rejects(
    () => validateKeywordWorkerScope(
      scope({ orderedTargetAsins: ["B0D31VY644", "B0G26P9FMV"] }),
      committed({ orderedTargetAsins: ["B0G26P9FMV", "B0D31VY644"] }),
    ),
    /KEYWORD_SCOPE_MISMATCH/,
  );
  assert.equal(connectorCalls, 0);
});
```

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-job-keyword-scope.test.ts
node --test tests/scripts/keyword-worker-scope.test.mjs
```

Expected: current dispatcher passes only ASIN/marketplace environment values and cannot verify full scope.

- [ ] Add a repository method that reads the sync job joined to project/run and returns the authoritative scope. The dispatcher serializes that exact object to one base64url JSON environment value `AGENT_KEYWORD_WORKER_SCOPE`; the script parses with a strict schema and re-reads the same job via the existing PostgreSQL bridge before any provider action.

- [ ] Implement `KeywordWorkerScopeService` with an injected `SyncJobScopeReader` and `KeywordEvidenceRepository`. `verifyAndRegister(input)` compares all fields to the reader result, calls `registerVerifiedSubject` only after exact equality, and returns the immutable subject. Production uses the PostgreSQL sync-job reader; SQLite repository tests inject an in-memory reader with the same contract, so SQLite never needs nonexistent sync tables. Add spies proving a missing/mismatched organization/project/run/stage/job/ASIN/cutoff/version/policy produces zero subject rows and zero connector calls.

- [ ] Require exact ordered ASIN equality, organization/project/run/stage/job equality, `stageId === "keywords"`, `US`, exact `dataCutoffAt`, selected provider/schema versions, and an enabled quota policy. Reject missing DB connectivity as configuration failure; never continue with local defaults. Every produced evidence then fixes `targetAsin` from this list and `lookupAsin/categoryId` from the verified query step; neither may be supplied by an untrusted provider payload.

- [ ] Change the keywords stage command from generic `npm run keywords:sync` data-file behavior to `node scripts/build-sif-keyword-analysis.mjs --job-scope`; keep the legacy command available only behind `AGENT_KEYWORD_LEGACY_DIAGNOSTIC=1` and disallow it for a run-bound job.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-job-keyword-scope.test.ts
node --test tests/scripts/keyword-worker-scope.test.mjs
Assert-NoAffectedTypeDiagnostics @('server/db/sync-job-repository.ts','server/db/postgres/sync-job-store.ts','server/services/sync-job-worker-handler.ts','server/services/keyword-worker-scope-service.ts','server/runtime/sync-job-dispatcher.ts','tests/agent/sync-job-keyword-scope.test.ts')
```

Expected: focused tests pass and listed TypeScript paths have zero diagnostics; all missing/mismatched fields fail before external side effects and matching scope preserves ASIN order.

- [ ] Commit:

```powershell
git add server/db/sync-job-repository.ts server/db/postgres/sync-job-store.ts server/services/sync-job-worker-handler.ts server/services/keyword-worker-scope-service.ts server/runtime/sync-job-dispatcher.ts scripts/run-asin-sync-job.mjs scripts/lib/keyword-worker-scope.mjs tests/agent/sync-job-keyword-scope.test.ts tests/scripts/keyword-worker-scope.test.mjs
git commit -m "feat(keywords): enforce committed worker scope"
```

## Task 6: 实现 canonical 与一次性等价参数重试

**Files:**

- Create: `scripts/lib/sif-keyword-evidence-runner.mjs`
- Modify: `scripts/build-sif-keyword-analysis.mjs`
- Modify: `scripts/lib/sif-mcp-client.mjs`
- Modify: `scripts/lib/sif-keyword-transform.mjs`
- Test: `tests/scripts/sif-keyword-evidence-runner.test.mjs`

**Interfaces:**

- Consumes: validated worker scope, strict registry entry, budgeted connector, repository bridge.
- Produces: immutable `target-canonical` or `target-parameter-retry` evidence plus append-only logical attempts; no runtime TS write.

- [ ] Write a table-driven RED test for canonical ready, canonical strict empty, `INVALID_ARGUMENT`+matching alternate, `UNSUPPORTED_PARAMETER`+matching alternate, timeout, auth failure, quota failure, 5xx, schema drift, and provider valid-empty. Assert only the two explicit parameter errors invoke alternate and at most once.

```js
test("alternate parameters run once only for a registry-approved compatibility error", async () => {
  const calls = [];
  const result = await runTargetKeywordEvidence(fixture({
    registry: approvedContractTestRegistry(),
    execute: async request => {
      calls.push(request.queryVariant);
      if (calls.length === 1) throw providerError("INVALID_ARGUMENT");
      return canonicalFixture({ asin: "B0D31VY644", keywords: [keywordFixture()] });
    },
  }));
  assert.equal(result.mode, "target-parameter-retry");
  assert.deepEqual(calls, ["contract-test-canonical", "contract-test-alternate"]);
});
```

- [ ] Run RED:

```powershell
node --test tests/scripts/sif-keyword-evidence-runner.test.mjs
```

Expected: current builder writes generated TS and has neither strict evidence runner nor parameter-error gate.

- [ ] Implement a state machine with no recursive fallback and no provider-key literals:

```js
const canonical = registry.resolve({
  descriptorSha256: scope.capabilityDescriptorSha256,
  providerVersion: scope.providerVersion,
  semantic: "target-canonical",
});
if (!canonical) return capabilityUnknown("target-canonical");
const alternate = isParameterCompatibilityError(canonicalError)
  ? registry.resolve({
      descriptorSha256: scope.capabilityDescriptorSha256,
      providerVersion: scope.providerVersion,
      semantic: "target-parameter-retry",
    })
  : null;
```

Canonical executes first. Alternate executes exactly once only when `isParameterCompatibilityError(error)` is true and registry resolution returned the explicit equivalent entry. A valid empty alternate is persisted as `empty/valid-empty` before the caller considers parent fallback.

- [ ] Compute `paramsHash` from canonical JSON of the exact provider arguments, not target identity aliases. Persist an attempt before/after each logical call with mode, provider/operation/schema versions, query variant, params hash, duration, redacted result/error code, and associated quota receipt count.

- [ ] Persist evidence before returning it. Repository failure means stage failure; do not keep a memory-only result and do not write `app/sif-keyword-analysis-data.ts`. Preserve the old file-generation path only under the explicit diagnostic flag from Task 5.

- [ ] Convert terminal errors deterministically: unknown capability → `unavailable/capability-unknown`; auth/5xx/timeout after connector policy → `unavailable/provider-unavailable`; malformed strict response → `schema-error/schema-invalid`; ledger rejection → matching `quota-blocked` reason. All carry the attempted mode and empty keywords.

- [ ] Run GREEN:

```powershell
node --test tests/scripts/sif-keyword-evidence-runner.test.mjs
Assert-NoAffectedTypeDiagnostics @('shared/keyword-evidence-contracts.ts','server/db/keyword-evidence-repository.ts')
```

Expected: the exact fallback matrix passes, listed TypeScript paths have zero diagnostics, alternate never runs for valid empty or non-parameter errors, and every returned evidence id exists in repository.

- [ ] Commit:

```powershell
git add scripts/lib/sif-keyword-evidence-runner.mjs scripts/build-sif-keyword-analysis.mjs scripts/lib/sif-mcp-client.mjs scripts/lib/sif-keyword-transform.mjs tests/scripts/sif-keyword-evidence-runner.test.mjs
git commit -m "feat(keywords): run strict target evidence queries"
```

## Task 7: 加入可信 parent/main、category proxy 与 Sorftime 边界

**Files:**

- Create: `scripts/lib/keyword-identity-verifier.mjs`
- Create: `scripts/lib/sif-keyword-fallback-orchestrator.mjs`
- Create: `scripts/lib/sorftime-keyword-cross-validation.mjs`
- Modify: `scripts/lib/sorftime-mcp-client.mjs`
- Modify: `scripts/build-sif-keyword-analysis.mjs`
- Test: `tests/scripts/sif-keyword-fallback-orchestrator.test.mjs`
- Test: `tests/scripts/sorftime-keyword-boundary.test.mjs`

**Interfaces:**

- Consumes: strict target result, persisted catalog relationship/category facts, strict Sorftime `product_detail`, SIF registry, and request budget.
- Produces: `parent-listing`, per-target `category-proxy`, or explicit unavailable evidence with verifiable relationship/category provenance and separate cross-validation facts; category provider output first lands in one shared lookup and is never itself a target evidence.

- [ ] Write RED fixtures for: catalog parent, catalog main listing, Sorftime verified parent, target mismatch, inferred relationship, invalid/same ASIN, verified category, missing category, concurrent same-category targets, and Sorftime numeric cross-validation attempting to overwrite SIF fields. For two requested targets sharing the same verified category/params, assert exactly one provider call and one lookup id, followed by two different evidence ids with their original target ASINs and target-specific category provenance. Inject the Task 1 `allowTestFixtures:true` registry whose sanitized contract-test fixture explicitly permits the canonical mapping for a verified `lookupAsin` plus category-proxy semantics; also test an empty production registry and descriptor/version mismatch make zero provider calls.

```js
test("Sorftime may verify a parent but cannot populate target SIF traffic", async () => {
  const result = await orchestrateKeywordFallback(fixture({
    targetResult: strictEmpty("B0D31VY644"),
    sorftimeProduct: { asin: "B0D31VY644", parentAsin: "B0PARENT01", trafficShare: 0.91 },
    sifParentResult: keywordResponse("B0PARENT01"),
  }));
  assert.equal(result.mode, "parent-listing");
  assert.equal(result.lookupAsin, "B0PARENT01");
  assert.equal(result.relationshipEvidence?.targetAsin, "B0D31VY644");
  assert.equal(JSON.stringify(result).includes("0.91"), false);
});
```

- [ ] Run RED:

```powershell
node --test tests/scripts/sif-keyword-fallback-orchestrator.test.mjs tests/scripts/sorftime-keyword-boundary.test.mjs
```

Expected: no verified identity resolver or four-level orchestrator exists.

- [ ] Implement Level 3 gate: only strict-valid target empty or explicit provider child-listing unsupported can proceed. Read persisted catalog first; if absent, call Sorftime `product_detail` for the same target through a strict schema. Reject title/brand/category/image similarity, target mismatch, malformed ASIN, and candidate equal to target. Hash the strict normalized identity payload into `RelationshipEvidence`.

- [ ] Execute one SIF canonical query for the verified parent/main candidate, subject to the same target receipt cap. Persist `targetAsin` and `lookupAsin` separately. Never label parent rows as target traffic; if budget is exhausted, persist `parent-listing/quota-blocked/physical-attempt-limit`.

- [ ] Implement Level 4 only after prior levels have no usable strict result. Resolve and persist target-specific `CategoryEvidence` from catalog or strict same-target Sorftime detail, then call `claimCategoryLookup` with exact organization/project/run/stage/job/marketplace/category/params/schema/provider scope. Resolve semantic `category-proxy` from the approved Task 1 registry fixture. The owner invokes the returned operation once and calls `completeCategoryLookup` with its claim token in `finally` for every success/error mapping; waiters use the returned `lookupId` and boundedly read the same terminal lookup without HTTP or a process `Map`. Resume handles an expired pending lease through Task 3 compare-and-swap. If capability is absent, the owner completes the shared lookup as `unavailable/capability-unknown` without HTTP.

- [ ] After the shared lookup is terminal, every caller must independently call `materializeCategoryEvidence({lookupId,targetAsin,...targetCategoryEvidence})`. This produces exactly one target-scoped terminal evidence per requested target, copies/references the shared immutable provider provenance/content hash, and preserves its own category relationship, cross-validation and coverage. Never return `lookupId` in `evidenceIds`, never reuse the owner's evidence for waiters, and never let one evidence row satisfy two target ASINs.

- [ ] Category adapter only emits keyword/category fields (`keyword`, `searchVolume`, `abaRank`, bid/trend facts). Its type contains no target listing traffic, organic rank, or advertising rank. Missing or unverified category ends as `unavailable/category-unverified`.

- [ ] Build `CrossValidationFact` only from Sorftime sales/review/price/trend metrics with `provider,metric,window,observedValue,direction,comparison`. Merge these facts after SIF normalization without mutating SIF keywords or status. Cap Sorftime verification with its own operation policy and budget receipts.

- [ ] After the final usable evidence mode is selected, enrich only its normalized, de-duplicated top 50 display keywords. Cache each result by `organizationId,marketplace,normalizedKeyword,paramsHash,schemaVersion,providerVersion,windowStart,windowEnd`; every cache miss uses the same reserve/consume/release ledger under separate operations `market_get_keyword_history` and `market_assess_keyword_promotion` with independent configured caps. Persist only immutable `enrichmentRevisionIds` on the job evidence. An enrichment error produces an explicit partial enrichment fact and cannot change the selected SIF mode/status or trigger a deeper identity fallback.

- [ ] Add an explicit three-receipt test across canonical + parent + category or canonical network retry + parent: whichever sequence reaches three first prevents a fourth physical SIF send. Add a concurrent category test proving one receipt/provider call/shared lookup per job/category/params, zero waiter receipts, and one distinct materialized evidence id per target.

- [ ] Run GREEN:

```powershell
node --test tests/scripts/sif-keyword-fallback-orchestrator.test.mjs tests/scripts/sorftime-keyword-boundary.test.mjs tests/scripts/sif-physical-request-budget.test.mjs
Assert-NoAffectedTypeDiagnostics @('shared/keyword-evidence-contracts.ts','server/db/keyword-evidence-repository.ts','server/services/keyword-request-budget-service.ts')
```

Expected: focused tests pass and listed TypeScript paths have zero diagnostics; trusted identities permit fallback, inferred/mismatched identities fail closed, category provider work deduplicates at lookup level while every target keeps a distinct evidence id, and Sorftime never supplies SIF target fields.

- [ ] Commit:

```powershell
git add scripts/lib/keyword-identity-verifier.mjs scripts/lib/sif-keyword-fallback-orchestrator.mjs scripts/lib/sorftime-keyword-cross-validation.mjs scripts/lib/sorftime-mcp-client.mjs scripts/build-sif-keyword-analysis.mjs tests/scripts/sif-keyword-fallback-orchestrator.test.mjs tests/scripts/sorftime-keyword-boundary.test.mjs
git commit -m "feat(keywords): add bounded verified evidence fallback"
```

## Task 8: 让 keywords stage output 只绑定 immutable evidence ids

**Files:**

- Modify: `shared/agent-contracts.ts`
- Modify: `server/db/sync-job-repository.ts`
- Modify: `server/db/postgres/sync-job-store.ts`
- Modify: `server/services/sync-job-worker-handler.ts`
- Modify: `scripts/lib/sync-stage-output.mjs`
- Modify: `scripts/run-asin-sync-job.mjs`
- Test: `tests/agent/stage-output-contract.test.ts`
- Test: `tests/agent/sync-stage-output-persistence.test.ts`
- Test: `tests/scripts/sync-stage-output.test.mjs`

**Interfaces:**

- Consumes: committed evidence ids from KeywordEvidenceRepository and complete worker scope.
- Produces: keyword stage data `{ evidenceIds: string[] }` bound to `{organizationId,projectId,runId,stageId:"keywords",jobId}`; other stage output contracts remain unchanged.

- [ ] Write RED tests that reject raw `analysisByAsin`, duplicate/uncommitted ids, cross-job ids, mismatched organization/project/run, and evidence persistence after stage terminalization. Assert stage finalization cannot become `done` unless every requested target has exactly one terminal target-scoped evidence record committed and bound. A shared category lookup id is never a stage evidence id; two targets sharing that lookup must still contribute two distinct evidence ids, and binding the same evidence id as coverage for two targets fails.

```ts
test("keywords stage output contains only repository-bound immutable ids", async () => {
  const output = await repository.readStageOutput(scopedKeywordStage);
  assert.deepEqual(output.data, { evidenceIds: ["ev-target-1", "ev-target-2"] });
  assert.equal("analysisByAsin" in output.data, false);
});
```

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/stage-output-contract.test.ts tests/agent/sync-stage-output-persistence.test.ts
npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/comparison-project-contract.test.ts
node --test tests/scripts/sync-stage-output.test.mjs
```

Expected: the new keyword-stage tests fail because the current schema requires `analysisByAsin/enrichmentByKeyword`; the inherited Manual/Comparison contract regressions pass.

- [ ] Change only the keywords branch of `StageDataSchemas` to strict `{ evidenceIds: z.array(EntityIdSchema).min(1).max(10) }`. Keep reviews/sales/FBA/listing/category/traffic unchanged.

- [ ] Extend only the keyword stage gap contract with redacted reason `FEATURE_DISABLED` and test its strict serialization. Task 12 owns the feature-flag branch that emits it; Task 8 does not import Task 12 policy code. Other stage gap enums remain unchanged.

- [ ] In the worker completion transaction, validate evidence organization/job and exact target coverage, insert immutable bindings, then persist stage output/hash/version. If any binding insert or evidence validation fails, roll back output and leave stage failed/partial with a typed reason; never publish ids before repository commit.

- [ ] Change `projectStageOutput("keywords")` to read the worker result manifest containing only evidence ids; do not parse `app/sif-keyword-analysis-data.ts` or enrichment TS. Delete the keywords entries from `projectionSources` while preserving legacy diagnostic code outside runtime projection.

- [ ] Ensure replay/resume with the same evidence ids and content hash is idempotent; a changed id set requires a higher output version and may only belong to the same job/run scope.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/stage-output-contract.test.ts tests/agent/sync-stage-output-persistence.test.ts
npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/comparison-project-contract.test.ts
node --test tests/scripts/sync-stage-output.test.mjs
Assert-NoAffectedTypeDiagnostics @('shared/agent-contracts.ts','server/db/sync-job-repository.ts','server/db/postgres/sync-job-store.ts','server/services/sync-job-worker-handler.ts','tests/agent/stage-output-contract.test.ts','tests/agent/sync-stage-output-persistence.test.ts','tests/agent/contracts.test.ts','tests/agent/comparison-project-contract.test.ts')
```

Expected: focused/regression tests pass and listed TypeScript paths have zero diagnostics; keyword stage output is id-only, exact-target-covered and scope-bound, while lookup ids and raw tenant keyword JSON cannot enter stage output.

- [ ] Commit:

```powershell
git add shared/agent-contracts.ts server/db/sync-job-repository.ts server/db/postgres/sync-job-store.ts server/services/sync-job-worker-handler.ts scripts/lib/sync-stage-output.mjs scripts/run-asin-sync-job.mjs tests/agent/stage-output-contract.test.ts tests/agent/sync-stage-output-persistence.test.ts tests/scripts/sync-stage-output.test.mjs
git commit -m "feat(keywords): bind stage output to evidence ids"
```

## Task 9: 新增认证 run-scoped evidence GET

**Files:**

- Modify: `shared/agent-contracts.ts`
- Create: `server/services/keyword-evidence-read-service.ts`
- Create: `server/routes/keyword-evidence.ts`
- Modify: `server/app.ts`
- Modify: `app/api/agent/[...path]/route.ts`
- Modify: `app/lib/agent-service-client.ts`
- Test: `tests/agent/keyword-evidence-route.test.ts`
- Test: `tests/agent/agent-api-schema.test.ts`

**Interfaces:**

- Consumes: authenticated principal, `runId`, comma-separated requested immutable ids, repository binding chain.
- Produces: strict `GET /v1/runs/:runId/keyword-evidence?ids=e1,e2` response `{runId,stageId,evidences[]}` with complete provenance and redacted quota summary.

- [ ] Write route RED tests for: valid same-run ordered ids; missing Cookie/principal; other organization; wrong run/project/job; unbound id; mixed valid+invalid ids; duplicate ids; too many ids; corrupt evidence. Every identity mismatch returns the same 404 with zero partial records.

```ts
test("mixed authorized and foreign evidence ids return 404 without partial disclosure", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/v1/runs/run-a/keyword-evidence?ids=ev-a,ev-foreign",
    headers: sessionHeaders("org-a"),
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.includes("ev-a"), false);
  assert.equal(response.body.includes("ev-foreign"), false);
});
```

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-route.test.ts tests/agent/agent-api-schema.test.ts
```

Expected: route/service/contracts are absent.

- [ ] Add query schema accepting 1–10 unique entity ids in the explicit order. The service derives organization from `request.authPrincipal`, loads run→project→keywords stage output, verifies every binding’s organization/project/run/stage/job/evidence chain, and compares requested set exactly. Any mismatch returns `NOT_FOUND`; database/schema failures return typed 503 and never fall back to static data.

- [ ] Return each item with `evidenceId,targetAsin,lookupAsin,categoryLookupId,marketplace,status,mode,terminalReason,categoryEvidence,relationshipEvidence,keywords,enrichmentRevisionIds,crossValidation,provenance,quotaReceiptsSummary`. `categoryLookupId` is non-null only for category-proxy evidence and is never accepted as a requested evidence id. `provenance` contains `operation,queryVariant,paramsHash,schemaVersion,providerVersion,queryWindow,fetchedAt,categoryLookupContentHash`; quota summary contains only `physicalRequestCount,consumedCount,releasedCount,terminalBudgetReason`. Two response items may share `categoryLookupId` but must retain distinct evidence ids/target ASINs.

- [ ] Register the route under existing auth/role middleware and add it to the Agent API contract allowlist. Extend 31900 generic proxy validation so GET query survives unchanged, session/proxy token/origin protections remain, and response is parsed with the strict shared schema.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-route.test.ts tests/agent/agent-api-schema.test.ts
Assert-NoAffectedTypeDiagnostics @('shared/agent-contracts.ts','server/services/keyword-evidence-read-service.ts','server/routes/keyword-evidence.ts','server/app.ts','app/api/agent/[...path]/route.ts','app/lib/agent-service-client.ts','tests/agent/keyword-evidence-route.test.ts','tests/agent/agent-api-schema.test.ts')
```

Expected: route tests pass and listed TypeScript paths have zero diagnostics; valid run returns ordered target evidence, shared lookup ids never replace evidence ids, and all cross-scope/partial-leak attempts return indistinguishable 404.

- [ ] Commit:

```powershell
git add shared/agent-contracts.ts server/services/keyword-evidence-read-service.ts server/routes/keyword-evidence.ts server/app.ts app/api/agent/[...path]/route.ts app/lib/agent-service-client.ts tests/agent/keyword-evidence-route.test.ts tests/agent/agent-api-schema.test.ts
git commit -m "feat(api): expose run-scoped keyword evidence"
```

## Task 10: 用 run-scoped hydration 替换客户端 static keyword imports

**Files:**

- Create: `app/lib/keyword-evidence-browser.ts`
- Create: `app/keyword-evidence-view.ts`
- Modify: `app/lib/stage-output-browser.ts`
- Modify: `app/lib/stage-output-view.ts`
- Modify: `app/keyword-demand-analysis.ts`
- Modify: `app/keyword-demand-conclusions.ts`
- Modify: `app/keyword-fetch-status.tsx`
- Modify: `app/keyword-demand-section.tsx`
- Modify: `app/product-launch-analysis.ts`
- Modify: `app/product-launch-recommendation.tsx`
- Modify: `app/voc-positioning-section.tsx`
- Modify: `app/product-definition-section.tsx`
- Modify: `app/launch-checklist-section.tsx`
- Modify: `app/page.tsx`
- Test: `tests/agent/keyword-evidence-browser.test.ts`
- Test: `tests/agent/keyword-evidence-ui.test.tsx`
- Test: `tests/agent/stage-output-browser.test.ts`
- Test: `tests/agent/voc-keyword-page-model.test.ts`

**Interfaces:**

- Consumes: accepted run/job-scoped keyword stage output ids and authenticated evidence GET.
- Produces: epoch-safe UI view model with explicit mode/status/terminal reason/provenance labels; no static keyword data defaults.

- [ ] Write RED tests proving page loads evidence only after accepting matching stage output, rejects stale run/job response, clears on organization/session epoch change, and renders all modes/statuses. Assert parent rows are separated from target ranking, category rows never enter ASIN traffic-share charts, and cross-validation cannot alter SIF values.

  Add product-analysis composition RED cases that pass a Manual VOC record available only in the current `manualVocByAsin` overlay plus a keyword evidence record available only in the accepted run-scoped evidence view. The launch, VOC positioning, product definition and checklist models must all see both sources; omitting keyword evidence produces the typed `关键词数据未就绪`/C-grade state without reading a generated module, while omitting Manual VOC produces the existing bounded VOC missing state without throwing. Switch session organization while both requests are pending and prove neither old overlay nor old keyword evidence reaches any product-analysis consumer.

```tsx
test("category proxy is labeled and excluded from target traffic chart", async () => {
  render(<KeywordDemandSection evidences={[categoryProxyEvidence()]} />);
  expect(screen.getByText("类目需求代理，不代表该 ASIN 流量")).toBeTruthy();
  expect(screen.queryByTestId("target-traffic-share-B0D31VY644")).toBeNull();
});
```

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-browser.test.ts tests/agent/keyword-evidence-ui.test.tsx tests/agent/stage-output-browser.test.ts
npx tsx --conditions=react-server --test tests/agent/voc-keyword-page-model.test.ts tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/manual-alexa-voc-rollback.test.ts tests/agent/comparison-page-state.test.tsx
```

Expected: new keyword tests fail because current UI imports and defaults to `sifKeywordAnalysisData`/`sifKeywordEnrichmentData`; inherited Manual/Comparison state regressions pass.

- [ ] Before editing shared client files, start from the committed post-Plan-01/post-Plan-02 versions. In `app/page.tsx`, preserve the existing Manual VOC owner/session state, `comparisonDraft`, `committedScope`, epoch resets and overlay behavior exactly; add keyword evidence ownership as a separate slice. Keep the inherited Manual/Comparison regression suites in both RED and GREEN commands.

- [ ] Implement `createKeywordEvidenceOwner({organizationEpoch,projectId,runId,jobId})`. It accepts only ids from a matching accepted stage output, fetches the exact run-scoped URL, strict-parses the response, discards responses from an older owner epoch, and exposes `loading|ready|missing|source-error` without ASIN-latest fallback.

- [ ] Build a pure view mapper that preserves evidence id, target/lookup identity, category lookup id/content hash, mode, status, terminal reason, provider/schema versions, query window, fetchedAt, category/relationship evidence, and cross-validation. It may aggregate target-canonical and target-parameter-retry together only when query windows/schema/provider versions match. It may deduplicate display of shared category keyword rows by `categoryLookupId` only in a clearly labeled category-demand aggregate; it must retain one target card/coverage state per evidence id and must never collapse two target evidences into one target identity.

- [ ] Render fixed labels:

  - `target-canonical`: “目标 ASIN · 标准查询”
  - `target-parameter-retry`: “目标 ASIN · 等价参数兼容查询”
  - `parent-listing`: “父体/主 Listing 关键词，非目标子 ASIN 独立流量”
  - `category-proxy`: “类目需求代理，不代表该 ASIN 流量”

Show terminal reason for empty/unavailable/schema-error/quota-blocked. Parent traffic is displayed under `lookupAsin`; category proxy can enter demand discovery but not competitor traffic share/rank.

- [ ] Remove imports of `./sif-keyword-analysis-data` and `./sif-keyword-enrichment-data` from all client-reachable files. `buildKeywordDemandAnalysis` must require explicit evidence-derived sources and return a typed missing state when absent, never default globals.

- [ ] Remove the static merge branch from `app/lib/stage-output-view.ts`: keywords stage output now yields only evidence ids, and those ids are consumed by `createKeywordEvidenceOwner`; it must not synthesize `analysisByAsin/enrichmentByKeyword`. In `app/keyword-demand-conclusions.ts`, replace every direct enrichment lookup with a value supplied by the evidence-derived analysis/view. Type-only imports may come only from the shared evidence contracts, never generated tenant modules.

- [ ] Keep one explicit product-analysis input across every page consumer:

```ts
export type ProductLaunchRuntimeSources = Readonly<{
  manualVocByAsin: Readonly<Record<string, ManualAlexaVocNormalizedRecord | undefined>>;
  keywordDemand: KeywordDemandAnalysis | null;
}>;

export function buildProductLaunchAnalysis(
  products: readonly LaunchProductInput[],
  sources: ProductLaunchRuntimeSources,
): ProductLaunchAnalysis;

export function hasProductLaunchAnalysis(
  products: readonly LaunchProductInput[],
  sources: ProductLaunchRuntimeSources,
): boolean;
```

  `app/page.tsx` constructs this source only from the current Manual overlay owner and the `KeywordDemandAnalysis` built from the current accepted keyword evidence view, then passes it unchanged to `ProductLaunchRecommendationSection`, `VocPositioningSection`, `ProductDefinitionSection` and `LaunchChecklistSection`. Every component includes the source object in its memo dependencies. No optional/default parameter is allowed, because omission would reopen the static fallback path.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-browser.test.ts tests/agent/keyword-evidence-ui.test.tsx tests/agent/stage-output-browser.test.ts
npx tsx --conditions=react-server --test tests/agent/voc-keyword-page-model.test.ts tests/agent/manual-alexa-voc-client-store.test.ts tests/agent/manual-alexa-voc-rollback.test.ts tests/agent/comparison-page-state.test.tsx
Assert-NoAffectedTypeDiagnostics @('app/lib/keyword-evidence-browser.ts','app/keyword-evidence-view.ts','app/lib/stage-output-browser.ts','app/lib/stage-output-view.ts','app/keyword-demand-analysis.ts','app/keyword-demand-conclusions.ts','app/keyword-fetch-status.tsx','app/keyword-demand-section.tsx','app/product-launch-analysis.ts','app/product-launch-recommendation.tsx','app/voc-positioning-section.tsx','app/product-definition-section.tsx','app/launch-checklist-section.tsx','app/page.tsx','tests/agent/keyword-evidence-browser.test.ts','tests/agent/keyword-evidence-ui.test.tsx','tests/agent/stage-output-browser.test.ts','tests/agent/manual-alexa-voc-client-store.test.ts','tests/agent/comparison-page-state.test.tsx')
```

Expected: focused/regression tests pass and listed TypeScript paths have zero diagnostics; run-scoped evidence hydrates correctly, stale/cross-scope responses cannot land, shared category rows do not collapse target coverage, and proxy modes remain visually/numerically separate.

- [ ] Commit:

```powershell
git add app/lib/keyword-evidence-browser.ts app/keyword-evidence-view.ts app/lib/stage-output-browser.ts app/lib/stage-output-view.ts app/keyword-demand-analysis.ts app/keyword-demand-conclusions.ts app/keyword-fetch-status.tsx app/keyword-demand-section.tsx app/product-launch-analysis.ts app/product-launch-recommendation.tsx app/voc-positioning-section.tsx app/product-definition-section.tsx app/launch-checklist-section.tsx app/page.tsx tests/agent/keyword-evidence-browser.test.ts tests/agent/keyword-evidence-ui.test.tsx tests/agent/stage-output-browser.test.ts tests/agent/voc-keyword-page-model.test.ts
git commit -m "feat(ui): hydrate scoped keyword evidence"
```

## Task 11: 让 export 与 product definition 复用同一 read service 和 provenance

**Files:**

- Create: `server/services/keyword-evidence-projection-service.ts`
- Modify: `app/launch-checklist-export.ts`
- Modify: `app/final-product-definition.ts`
- Modify: `app/product-definition-section.tsx`
- Modify: `server/data/keyword-analysis-snapshot.ts`
- Modify: `server/services/product-definition-execution-service.ts`
- Modify: `server/services/product-definition-worker-handler.ts`
- Modify: `server/domain/product/product-definition-contracts.ts`
- Test: `tests/agent/keyword-evidence-export.test.ts`
- Test: `tests/agent/product-definition-runtime.test.ts`

**Interfaces:**

- Consumes: `KeywordEvidenceReadService` result for a specific run/stage binding.
- Produces: evidence-derived export rows and keyword snapshot/product-definition input with immutable evidence ids and full source qualifiers.

- [ ] Write RED tests asserting export and product definition never call repository by ASIN/latest, reject missing provenance, retain parent/category qualifiers in conclusions, and keep Sorftime facts outside target SIF numeric fields.

```ts
test("product definition cannot call category proxy a target ASIN traffic term", async () => {
  const input = await buildProductDefinitionInputFromRun(categoryProxyRunFixture());
  assert.equal(input.keywords.evidence[0]?.mode, "category-proxy");
  assert.match(input.keywords.evidence[0]?.scopeLabel ?? "", /类目需求代理/);
  assert.equal(JSON.stringify(input).includes("该 ASIN 的核心流量词"), false);
});
```

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-export.test.ts tests/agent/product-definition-runtime.test.ts
```

Expected: current product definition consumes the older snapshot evidence shape and exports can use page/static-derived data.

- [ ] Add one projection service that accepts `{actorOrganizationId,runId,evidenceIds}` and internally invokes the same binding/auth checks as the GET service. UI export calls the authenticated GET; server product-definition assembler calls the service directly with the worker principal scope. Neither receives direct repository search methods.

- [ ] Extend keyword snapshot evidence with `evidenceId,targetAsin,lookupAsin,categoryLookupId,categoryLookupContentHash,status,mode,terminalReason,operation,queryVariant,paramsHash,schemaVersion,providerVersion,queryWindow,fetchedAt,relationshipEvidence,categoryEvidence,enrichmentRevisionIds,crossValidation`. Derive snapshot content hash from this full payload so either target provenance or the referenced shared lookup provenance changes create a different immutable snapshot. Export/product-definition may group category demand by lookup id, but every claim retains the originating target evidence id and target ASIN.

- [ ] Update product-definition contracts so every keyword group references persisted evidence ids. Require the model output to retain `sourceMode` and `scopeLabel` for parent/category-derived claims; validate that category proxy cannot support a target traffic/rank assertion and parent evidence names `lookupAsin`.

- [ ] Update JSON/file export to include the same provenance fields and redacted quota summary. Do not export raw receipt ids, URLs, headers, tokens, provider bodies, or tenant-wide data.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-export.test.ts tests/agent/product-definition-runtime.test.ts tests/agent/postgres-keyword-analysis-snapshot-repository.test.ts
Assert-NoAffectedTypeDiagnostics @('server/services/keyword-evidence-projection-service.ts','app/launch-checklist-export.ts','app/final-product-definition.ts','app/product-definition-section.tsx','server/data/keyword-analysis-snapshot.ts','server/services/product-definition-execution-service.ts','server/services/product-definition-worker-handler.ts','server/domain/product/product-definition-contracts.ts','tests/agent/keyword-evidence-export.test.ts','tests/agent/product-definition-runtime.test.ts','tests/agent/postgres-keyword-analysis-snapshot-repository.test.ts')
```

Expected: export/product-definition tests pass and listed TypeScript paths have zero diagnostics; consumers use only bound target evidence, preserve shared lookup plus per-target provenance, and retain source limitations end-to-end.

- [ ] Commit:

```powershell
git add server/services/keyword-evidence-projection-service.ts app/launch-checklist-export.ts app/final-product-definition.ts app/product-definition-section.tsx server/data/keyword-analysis-snapshot.ts server/services/product-definition-execution-service.ts server/services/product-definition-worker-handler.ts server/domain/product/product-definition-contracts.ts tests/agent/keyword-evidence-export.test.ts tests/agent/product-definition-runtime.test.ts
git commit -m "feat(product): preserve keyword evidence provenance"
```

## Task 12: 加入 flags、terminal observability、client bundle gate 与发布回滚验收

**Files:**

- Create: `server/config/keyword-evidence-policy.ts`
- Create: `server/services/keyword-evidence-observability.ts`
- Modify: `server/config.ts`
- Modify: `server/services/sync-publication-status-service.ts`
- Modify: `server/services/sync-job-worker-handler.ts`
- Modify: `scripts/build-sif-keyword-analysis.mjs`
- Modify: `scripts/run-stable-build.mjs`
- Modify: `tests/scripts/run-stable-build.test.mjs`
- Test: `tests/agent/keyword-evidence-policy.test.ts`
- Test: `tests/agent/keyword-evidence-observability.test.ts`
- Test: `tests/agent/keyword-client-bundle.test.ts`
- Create: `tests/agent/keyword-evidence-fallback-acceptance.test.ts`
- Create: `docs/superpowers/reports/2026-08-31-sif-keyword-evidence-fallback-report.md`

**Interfaces:**

- Consumes: evidence/attempt/receipt/stage state from previous tasks.
- Produces: independently reversible feature flags, fixed terminal metrics/reasons, operator-safe diagnostics, and build-time proof that tenant keyword data is absent from client artifacts.

- [ ] Write RED policy tests for default-off, fully independent flags and a separate recommended rollout order:

```ts
const policy = KeywordEvidencePolicySchema.parse({});
assert.deepEqual(policy, {
  repositoryShadow: false,
  strictCanonical: false,
  parameterRetry: false,
  parentListing: false,
  categoryProxy: false,
  sorftimeCrossValidation: false,
});
assert.equal(KeywordEvidencePolicySchema.parse({ categoryProxy: true, parentListing: false }).categoryProxy, true);
assert.equal(KeywordEvidencePolicySchema.parse({ parameterRetry: false, parentListing: true }).parentListing, true);
assert.deepEqual(recommendedKeywordRolloutOrder, [
  "repositoryShadow", "strictCanonical", "parameterRetry",
  "parentListing", "categoryProxy", "sorftimeCrossValidation",
]);
```

- [ ] Add RED metrics tests for exact counters:

  - `sif_keyword_attempt_total{mode,result,error_code,adapter_version}`
  - `sif_keyword_fallback_depth{mode}`
  - `sif_keyword_schema_error_total`
  - `sif_keyword_quota_blocked_total`
  - `sif_keyword_cache_hit_total{mode}`
  - `sif_keyword_physical_receipt_total{provider_version,mode,result}`
  - `sif_keyword_attempt_limit_total`
  - `sorftime_keyword_verification_total{purpose,result}`

Tests must prove labels contain no organization id, credential, raw error/body, URL, query value, or keyword text.

- [ ] Add a bundle RED test that builds a sentinel fixture and scans client manifests/chunks/source maps for `sif-keyword-analysis-data`, `sif-keyword-enrichment-data`, an exact tenant organization sentinel, tenant ASIN sentinel, evidence payload sentinel, and owner-manifest content. Schema field names such as `organizationId` are allowed; concrete tenant values are not. It must fail if either static module is client-reachable.

  Extend `tests/scripts/run-stable-build.test.mjs` rather than replacing the existing stable-build contract. Preserve interprocess lock ownership, build fingerprinting, failed-build cleanup and atomic artifact publication. The final bundle gate must run both `tests/manual-alexa-voc-client-bundle.test.mjs` and `tests/agent/keyword-client-bundle.test.ts`; keyword changes cannot delete or weaken any Manual VOC tenant sentinel.

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-policy.test.ts tests/agent/keyword-evidence-observability.test.ts tests/agent/keyword-client-bundle.test.ts tests/agent/keyword-evidence-fallback-acceptance.test.ts
node --test tests/scripts/run-stable-build.test.mjs tests/manual-alexa-voc-client-bundle.test.mjs
```

Expected: policy/metrics/build-gate/acceptance modules do not yet exist; Task 10 may already have removed static imports, but no build-time sentinel regression guard exists yet.

- [ ] Implement six independent booleans with no cross-flag validation. `recommendedKeywordRolloutOrder` and the runbook describe the safe default enable order, but runtime accepts any combination: a disabled level is skipped, the orchestrator evaluates the next enabled semantic level only when that level's identity/error gate is independently satisfied, and an enabled level with no approved capability ends `capability-unknown` without HTTP. In particular, `strictCanonical=false,parentListing=true` and `strictCanonical=false,categoryProxy=true` may execute their verified level without silently enabling canonical; `parameterRetry=true` still requires an observed approved canonical parameter-compatibility error, not a config dependency. Disabling a flag affects only new runs and never relabels/deletes historical evidence.

- [ ] Once the Task 8 repository-only stage contract is active, short-circuit a new keyword job before worker/provider dispatch and persist `partial/FEATURE_DISABLED` with no evidence ids only when every evidence-producing level is disabled (`strictCanonical`, `parameterRetry`, `parentListing`, and `categoryProxy` are all false). A single disabled level never disables another enabled level. This is the full-cutover rollback behavior; generated TS remains diagnostic-only and is never restored to runtime or client hydration.

- [ ] Emit one terminal event per target with organization represented only by a keyed hash and fields `jobId,runId,targetAsin,mode,status,terminalReason,providerVersion,schemaVersion,physicalRequestCount,durationMs`. Redact all provider payload/error material. Surface counts and lag in sync publication diagnostics without exposing evidence contents.

- [ ] Extend stable build with an import-graph and emitted-chunk scan. Permit static TS imports only from explicit server-only migration/diagnostic modules. Fail the build if client output contains either module name or configured sentinel data.

  Integrate the scan into the existing locked/fingerprinted `runStableBuild` transaction after successful compilation and before atomic artifact acceptance. On keyword scan failure, use the same cleanup path and preserve the previous accepted artifact. Run the Manual bundle scan unchanged against the same candidate artifact, followed by the keyword scan; both must pass before publication.

- [ ] Implement the acceptance matrix as injected fakes: canonical ready; parameter retry; verified parent; category proxy; no identity; unknown capability; schema drift; ledger missing; three receipts exhausted; concurrent category dedupe; cross-organization GET 404; UI/export/product-definition provenance. The concurrent category case uses two requested targets with one organization/job/category/params key and proves one provider call/receipt/lookup id, two immutable evidence ids/target ASINs, exact two-target stage coverage, and rejection if either evidence id is reused for both targets. Provider-success cases use only the approved contract-test fixture injected with `allowTestFixtures:true`; a production loader with the tracked empty manifest must end `capability-unknown` with zero HTTP. Assert terminal reasons exactly and no provider call beyond policy.

- [ ] Run GREEN and full scoped verification:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-policy.test.ts tests/agent/keyword-evidence-observability.test.ts tests/agent/keyword-client-bundle.test.ts tests/agent/keyword-evidence-fallback-acceptance.test.ts
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-contract.test.ts tests/agent/postgres-keyword-evidence-repository.test.ts tests/agent/sqlite-keyword-evidence-repository.test.ts tests/agent/keyword-request-budget.test.ts tests/agent/sync-job-keyword-scope.test.ts tests/agent/keyword-evidence-route.test.ts tests/agent/keyword-evidence-browser.test.ts tests/agent/keyword-evidence-ui.test.tsx tests/agent/keyword-evidence-export.test.ts tests/agent/product-definition-runtime.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts
node --test tests/scripts/sif-keyword-strict-adapter.test.mjs tests/scripts/sif-physical-request-budget.test.mjs tests/scripts/keyword-worker-scope.test.mjs tests/scripts/sif-keyword-evidence-runner.test.mjs tests/scripts/sif-keyword-fallback-orchestrator.test.mjs tests/scripts/sorftime-keyword-boundary.test.mjs tests/scripts/sync-stage-output.test.mjs
npx eslint shared/keyword-evidence-contracts.ts server/db/keyword-evidence-repository.ts server/db/postgres/keyword-evidence-store.ts server/db/sqlite-repository.ts server/services/keyword-request-budget-service.ts server/services/keyword-evidence-read-service.ts server/services/keyword-evidence-projection-service.ts server/services/keyword-evidence-observability.ts server/config/keyword-evidence-policy.ts server/routes/keyword-evidence.ts app/lib/keyword-evidence-browser.ts app/keyword-evidence-view.ts app/keyword-demand-analysis.ts app/keyword-fetch-status.tsx app/keyword-demand-section.tsx app/page.tsx
npm run build
node --test tests/scripts/run-stable-build.test.mjs tests/manual-alexa-voc-client-bundle.test.mjs
npx tsx --conditions=react-server --test tests/agent/keyword-client-bundle.test.ts
Assert-NoAffectedTypeDiagnostics @('shared/keyword-evidence-contracts.ts','server/db/keyword-evidence-repository.ts','server/db/postgres/keyword-evidence-store.ts','server/db/sqlite-repository.ts','server/services/keyword-request-budget-service.ts','server/services/keyword-evidence-read-service.ts','server/services/keyword-evidence-projection-service.ts','server/services/keyword-evidence-observability.ts','server/config/keyword-evidence-policy.ts','server/routes/keyword-evidence.ts','app/lib/keyword-evidence-browser.ts','app/keyword-evidence-view.ts','app/lib/stage-output-view.ts','app/keyword-demand-analysis.ts','app/keyword-demand-conclusions.ts','app/keyword-fetch-status.tsx','app/keyword-demand-section.tsx','app/product-launch-analysis.ts','app/product-launch-recommendation.tsx','app/voc-positioning-section.tsx','app/product-definition-section.tsx','app/launch-checklist-section.tsx','app/page.tsx')
git diff --check -- shared/keyword-evidence-contracts.ts server scripts app tests docs/superpowers/reports/2026-08-31-sif-keyword-evidence-fallback-report.md
```

Expected: focused/regression suites, changed-path TypeScript gate, listed-file ESLint, stable-build regression, production build, Manual bundle gate, Keyword bundle gate, category lookup/evidence fences and scoped diff check pass. This is not a claim that full-tree TypeScript or full-tree lint is green.

- [ ] Run the full compiler and full lint once, then classify rather than suppress their known baseline failures. Normalize compiler diagnostics by repository-relative path + TS code + message (ignore line/column drift), compare with the Batch 0 capture of 306 diagnostics, and record `retainedBaseline`, `resolvedBaseline`, and `introduced`. Require `introduced=0` and final total `<=306`; if the compiler still exits 2, write that exact result. Run `npm run lint`, record its actual exit/count against the Batch 0 lint capture, and do not call it green unless it really exits 0. Put commands, counts, categories, build fingerprint, bundle results and commits in `docs/superpowers/reports/2026-08-31-sif-keyword-evidence-fallback-report.md`.

- [ ] Perform rollback verification without modifying historical rows: with all flags off after repository cutover, new keyword stages finish explicit `partial/FEATURE_DISABLED`, make no provider request, publish no evidence ids and never read generated TS. Enable flags in the recommended order and verify each mode; then disable each flag independently—including out of order—and verify only new runs change. Repository evidence, receipts, and existing run bindings remain readable through their authenticated run-scoped API.

- [ ] Commit:

```powershell
git add server/config/keyword-evidence-policy.ts server/services/keyword-evidence-observability.ts server/config.ts server/services/sync-publication-status-service.ts server/services/sync-job-worker-handler.ts scripts/build-sif-keyword-analysis.mjs scripts/run-stable-build.mjs tests/scripts/run-stable-build.test.mjs tests/agent/keyword-evidence-policy.test.ts tests/agent/keyword-evidence-observability.test.ts tests/agent/keyword-client-bundle.test.ts tests/agent/keyword-evidence-fallback-acceptance.test.ts docs/superpowers/reports/2026-08-31-sif-keyword-evidence-fallback-report.md
git commit -m "test(keywords): gate scoped evidence rollout"
```

## Final Self-Review Checklist

- [ ] **Strict provider schema/version:** registry entries name exact operation, parameter keys, query variant, schema/provider version and compatibility; unknown capability is fail-closed.
- [ ] **Repository authority:** both database engines implement the same `KeywordEvidenceRepository`; runtime never reads global TS or ASIN-latest data.
- [ ] **Scope completeness:** organization/project/run/stage/job/target/lookup/category identities are persisted and verified at worker, shared lookup, target materialization, binding, API, UI/export and product-definition boundaries.
- [ ] **Physical request accounting:** every actual SIF fetch has one receipt; all network retries count; no initiating target exceeds three; category requests dedupe transactionally at shared lookup scope, waiters send no request, sent failures consume and only proven-unsent requests release.
- [ ] **Fallback semantics:** alternate is explicit and single-use; parent/main identity is trusted and separately labeled; category is proxy-only; Sorftime remains verification/cross-validation only.
- [ ] **Category lookup/evidence fence:** one organization/job/category/params lookup has one target-less `lookupId`; every requested target materializes a separate immutable evidence id referencing it, and one evidence id can never satisfy multiple targets.
- [ ] **Evidence immutability/read authorization:** evidence id and binding are immutable; GET is run-scoped, exact-set, organization-authorized, all-or-nothing 404.
- [ ] **Provenance propagation:** status/mode/terminal reason/lookup identity/category lookup id/content hash/operation/query variant/params hash/schema/provider version/window/fetchedAt/evidence id survive adapter → shared lookup → target evidence → stage → API → UI/export/product-definition.
- [ ] **Terminal behavior:** `ready`, `empty`, `unavailable`, `schema-error`, and `quota-blocked` obey the exact keywords/reason matrix and render explicit gaps.
- [ ] **Client security:** no client import or emitted chunk contains static tenant keyword datasets, owner manifests, credentials, raw response or receipt ids.
- [ ] **Migration allocation/parity:** Plan 01 owns `0019`/`0020`, Plan 02 owns `0021`, this plan owns SQLite/PostgreSQL `0022`; SQLite never references absent sync tables and its service-verified subject contract has independent migration/repository tests.
- [ ] **Capability proof:** production alternate/category operations and versions resolve only from official/saved sanitized fixture hashes; the empty manifest and unknown descriptors fail closed without HTTP.
- [ ] **Task dependency direction:** every RED names only the task's declared tests and existing outputs of earlier numbered tasks; no task imports implementation first created by a higher-numbered task.
- [ ] **Quota/failure/rollback/observability:** default-off independent flags, recommended rollout order, fixed redacted metrics, typed source errors, forward-only migrations and independent rollback are all tested.
- [ ] **No placeholders:** `rg -n "[T]BD|[T]ODO|[F]IXME|[l]ater|[s]imilar to|待[定]|后续[补]|占[位]" docs/superpowers/plans/2026-08-31-sif-keyword-evidence-fallback.md` returns no matches.
- [ ] **Type consistency:** every Task GREEN includes the changed-path TypeScript gate; Task 12 additionally runs full-tree `tsc`, classifies the 306-diagnostic baseline and requires zero introduced diagnostics. Shared Zod contracts, lookup/evidence repository records, stage output, API response, browser view, export and product-definition use the same enum literals, lookup ids and immutable target evidence ids.
- [ ] **Manual/Keyword client convergence:** `manualVocByAsin` and run-scoped keyword evidence reach every launch/positioning/definition/checklist consumer through one explicit source object; all direct/indirect static keyword imports and stage fallback merges are absent from the client graph.
- [ ] **Combined build safety:** existing stable-build lock/fingerprint/cleanup behavior, Manual VOC bundle sentinels and Keyword bundle sentinels all gate the same candidate artifact; neither bundle gate replaces the other.
- [ ] **Commit isolation:** each task commit contains only its listed files; generated data, publication state, provider credentials and user WIP remain unstaged; no push is performed.
