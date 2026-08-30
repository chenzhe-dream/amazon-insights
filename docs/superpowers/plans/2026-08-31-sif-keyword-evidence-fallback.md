# SIF Keyword Evidence Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 SIF 关键词同步从全局生成文件改造成组织隔离、run-scoped、可审计且最多三次物理请求的 PostgreSQL evidence 流水线，并按 target canonical、等价参数重试、已验证父体/主 Listing、类目代理的固定顺序有界降级。

**Architecture:** 共享 strict contracts 定义 evidence、provider adapter 和 run-scoped API；PostgreSQL/SQLite repository 持久化不可变 evidence、logical attempts、物理 request receipts、stage binding 与 enrichment revision。同步 worker 只接受并反查完整 committed scope，经版本化 capability registry 选择严格 adapter，在每次网络 dispatch 前原子 reserve receipt，成功写库后才发布 evidence ids。浏览器、导出和 product-definition 统一调用认证的 run-scoped read service，不再读取按 ASIN latest cache 或 client-side 生成 TS。

**Tech Stack:** TypeScript 5.9、Node.js 22、Zod 4、Fastify 5、PostgreSQL/SQLite、React 19、Node test runner（`tsx --test`）、现有 MCP connector 与 sync-job/stage-output 基础设施。

## Global Constraints

- 基线为规格提交 `882487a`；本计划只覆盖 Phase 3，并只依赖 Plan 02 已提交的 immutable project/run committed scope。不得把 Manual VOC 或 comparison draft 工作塞入本计划。
- 首发 marketplace 只有 `US`。organization 从认证 principal 或 repository 中的 committed scope 取得；Web body、环境默认组织、全局 catalog ASIN、全局 TS 数据都不能补齐缺失 scope。
- `app/sif-keyword-analysis-data.ts` 与 `app/sif-keyword-enrichment-data.ts` 只能由 server-only migration/diagnostic reader 使用；禁止进入浏览器依赖图，也不是运行时 fallback。
- 所有新增表只做向前 migration；回滚不 drop、不 delete、不重写 evidence mode。feature flags 默认关闭，按 canonical → parameter retry → parent/main → category/cross-validation 顺序开启，按反向顺序关闭。
- 不调用 provider “余额查询”。每个 target 的所有 SIF 物理 HTTP dispatch（含 connector 网络 retry）合计硬上限为 3；每次 dispatch 必须有独立 receipt。reserve 后交给网络栈即 consume，成功、4xx、5xx、timeout、结果未知都不退；仅证明从未发送时 release。
- Sorftime 只能验证 relationship/category 或形成销售、评论、价格、趋势 cross-validation；不得生成、覆盖或补齐 SIF target traffic share、rank、keyword count 或关键词列表。
- `ready` 必须有非空 keywords 且 `terminalReason=null`；`empty` 只能是 strict-valid 空响应及 `valid-empty`；`unavailable`、`schema-error`、`quota-blocked` 必须是空 keywords，并使用与状态匹配的 terminal reason。
- 日志、metrics、API、stage output、export 不得包含 credential、header、endpoint、raw response、provider error body、内部 receipt id 或 tenant-wide dataset。
- 每个任务先 RED、再最小 GREEN、再 scoped regression；只有列出的文件可加入该任务 commit。不要 stage 用户已有 WIP、生成数据、publication state 或服务配置，不启动/重启正式服务，不调用真实 provider，不 push。
- 测试中的 provider 响应全部使用 inline fixture 或本地 fake transport。所有时间、UUID、hash、capability descriptor 和 receipt settlement 均注入确定性依赖。

---

## Task 1: 定义 strict evidence contracts 与版本化 SIF capability registry

**Files:**

- Create: `shared/keyword-evidence-contracts.ts`
- Create: `scripts/lib/sif-keyword-capability-registry.mjs`
- Create: `scripts/lib/sif-keyword-strict-adapter.mjs`
- Modify: `scripts/lib/sif-keyword-sync-config.mjs`
- Test: `tests/scripts/sif-keyword-strict-adapter.test.mjs`
- Test: `tests/agent/keyword-evidence-contract.test.ts`

**Interfaces:**

- Consumes: current `market_get_asin_keyword_signals` payload and `SIF_KEYWORD_QUERY_WINDOW`.
- Produces: `SifKeywordEvidenceSchema`, `KeywordEvidenceApiResponseSchema`, `KeywordAttemptSummarySchema`, `KeywordEnrichmentReferenceSchema`, `CrossValidationFactSchema`, strict adapter result, and a fail-closed registry resolver.
- Constants: `KEYWORD_EVIDENCE_SCHEMA_VERSION="1.0.0"`, discovered-and-validated provider capability version `sif-market-keywords-v1`, canonical query variant `asin-keywords-camel-v1`, alternate variant `asin-keywords-snake-v1`, category variant `category-keywords-v1`.

- [ ] Write contract tests proving all five statuses retain a mode, invalid status/reason combinations fail, category proxy rejects listing traffic/rank, ready rejects empty keywords, and API quota summary cannot contain receipt ids.

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

- [ ] Define exact provider input mappings in the registry, without runtime guessing:

```js
export const SIF_KEYWORD_CAPABILITY_REGISTRY = Object.freeze([
  Object.freeze({
    providerVersion: "sif-market-keywords-v1",
    adapterVersion: "sif-asin-keywords-camel-v1",
    operation: "market_get_asin_keyword_signals",
    queryVariant: "asin-keywords-camel-v1",
    inputKeys: ["asin", "country", "time_type", "time_value", "listingSearch", "topN"],
    buildInput: ({ lookupAsin, marketplace, topN }) => ({
      asin: lookupAsin, country: marketplace, time_type: "lately", time_value: "30", listingSearch: true, topN,
    }),
  }),
  Object.freeze({
    providerVersion: "sif-market-keywords-v1",
    adapterVersion: "sif-asin-keywords-snake-v1",
    parameterErrorOnly: true,
    operation: "market_get_asin_keyword_signals",
    queryVariant: "asin-keywords-snake-v1",
    inputKeys: ["asin", "country", "time_type", "time_value", "listing_search", "top_n"],
    buildInput: ({ lookupAsin, marketplace, topN }) => ({
      asin: lookupAsin, country: marketplace, time_type: "lately", time_value: "30", listing_search: true, top_n: topN,
    }),
  }),
  Object.freeze({
    providerVersion: "sif-category-keywords-v1",
    adapterVersion: "sif-category-keywords-v1",
    operation: "market_get_category_keyword_signals",
    queryVariant: "category-keywords-v1",
    inputKeys: ["category_id", "country", "time_type", "time_value", "top_n"],
    buildInput: ({ categoryId, marketplace, topN }) => ({
      category_id: categoryId, country: marketplace, time_type: "lately", time_value: "30", top_n: topN,
    }),
  }),
]);
```

The resolver must match the exact normalized `tools/list` operation name, required/optional properties, primitive types, provider capability version, and internal adapter version. A registry entry may declare an explicit `compatibleProviderVersions` list; unknown descriptors may not use it and return `unavailable/capability-unknown`. It must never choose “latest”. Capability discovery is a separately governed, organization-scoped probe cached by descriptor hash; it is not repeated per target and cannot bypass the target query ledger.

- [ ] Implement strict response schemas: top-level keys, optional pagination, summary, echoed ASIN/category identity, keyword rows, finite nonnegative counts/ranks/bids, and ratios in `[0,1]`. Unknown keys, strings masquerading as numbers, identity mismatch, or malformed pagination return `schema-error/schema-invalid` and never return partial rows.

- [ ] Add fixture tests for canonical nonempty, strict empty, unknown top-level field, wrong numeric type, echoed ASIN mismatch, category rows, unknown capability, and explicitly compatible minimum registry entry. Assert only `INVALID_ARGUMENT` and `UNSUPPORTED_PARAMETER` are classified as parameter compatibility errors.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-contract.test.ts
node --test tests/scripts/sif-keyword-strict-adapter.test.mjs
```

Expected: all contract/adapter cases pass; malformed fixtures fail closed without a keyword result.

- [ ] Commit:

```powershell
git add shared/keyword-evidence-contracts.ts scripts/lib/sif-keyword-capability-registry.mjs scripts/lib/sif-keyword-strict-adapter.mjs scripts/lib/sif-keyword-sync-config.mjs tests/scripts/sif-keyword-strict-adapter.test.mjs tests/agent/keyword-evidence-contract.test.ts
git commit -m "feat(keywords): define strict SIF evidence contracts"
```

## Task 2: 新增 evidence、attempt、binding、budget 与 enrichment 向前迁移

**Files:**

- Create: `server/db/migrations/0015_keyword_evidence.sql`
- Create: `server/db/migrations/postgres/0019_keyword_evidence.sql`
- Modify: `tests/agent/sqlite-migrations.test.ts`
- Modify: `tests/agent/postgres-migrations.test.ts`

**Interfaces:**

- Consumes: existing organizations/users/projects/analysis_runs/sync_jobs/sync_stage_outputs foreign-key identities.
- Produces: `keyword_evidences`, `keyword_evidence_attempts`, `keyword_request_budget_receipts`, `keyword_stage_evidence_bindings`, `keyword_enrichment_revisions` and their uniqueness/check constraints.

- [ ] Write migration tests that upgrade from the current latest schema and fresh install, then inspect tables, FKs, composite unique indexes, immutable-update triggers, and status checks. Add a negative test that cannot bind an evidence row from another organization/job/run.

```ts
test("keyword evidence binding rejects mixed organization and job scope", async () => {
  await migrateCurrentDatabase(db);
  await seedRunAndSyncJob(db, { organizationId: "org-a", runId: "run-a", jobId: "job-a" });
  await seedRunAndSyncJob(db, { organizationId: "org-b", runId: "run-b", jobId: "job-b" });
  await insertKeywordEvidence(db, { organizationId: "org-a", jobId: "job-a", evidenceId: "ev-a" });
  await assert.rejects(() => bindKeywordEvidence(db, {
    organizationId: "org-b", runId: "run-b", jobId: "job-b", evidenceId: "ev-a",
  }));
});
```

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts
```

Expected: new table/index assertions fail because migrations 0015/0019 are absent.

- [ ] Create tables with these identities and checks:

```sql
-- PostgreSQL semantic key; SQLite uses COALESCE expressions in an equivalent unique index.
UNIQUE NULLS NOT DISTINCT (
  organization_id, job_id, marketplace, target_asin, mode,
  lookup_asin, category_id, params_hash, schema_version, provider_version
)
```

`keyword_evidences` stores immutable normalized JSON only (`keywords_json`, `relationship_evidence_json`, `category_evidence_json`, `cross_validation_json`, `enrichment_revision_ids_json`, `query_window_json`) plus `status`, `terminal_reason`, `operation`, hashes/versions/timestamps. Add DB checks for target/lookup/category mode relationships and status/reason compatibility.

- [ ] Make attempt rows append-only with `(evidence_id, logical_attempt_number)` unique. Make receipt rows append-only except one legal settlement transition `reserved -> consumed|released`; fields are `organization_id,job_id,provider,operation,target_asin,category_id,mode,params_hash,reserved_at,handed_to_network_at,settled_at,state,result_code,duration_ms`. Do not store URL, request body, response body, credential, or raw error.

- [ ] Make binding identity exactly `(organization_id,project_id,run_id,stage_id,job_id,evidence_id)` with stage check `keywords`, FKs/trigger validation through project→run and sync job→run, and an immutable trigger that rejects UPDATE/DELETE. Add unique `(organization_id,run_id,stage_id,evidence_id)`.

- [ ] Add category dedupe uniqueness on `(organization_id,job_id,marketplace,category_id,params_hash,schema_version,provider_version)` and enrichment cache uniqueness on `(organization_id,marketplace,keyword,params_hash,schema_version,provider_version,window_start,window_end,revision)`.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts
```

Expected: fresh and upgrade paths pass on both engines; invalid cross-scope binding and immutable mutations are rejected.

- [ ] Commit:

```powershell
git add server/db/migrations/0015_keyword_evidence.sql server/db/migrations/postgres/0019_keyword_evidence.sql tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts
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
- Produces: one runtime authority for evidence creation/read, attempt append, category claim, stage binding, enrichment revision, budget reserve/settle/count.

- [ ] Write repository conformance tests against both engines. Cover idempotent same semantic key+same content, conflict on same key+different content, organization/job isolation, category concurrent dedupe, immutable evidence id, ordered `findBoundEvidenceForRun`, and redacted receipt aggregation.

```ts
export interface KeywordEvidenceRepository {
  createEvidence(input: CreateKeywordEvidenceInput): Promise<{ evidence: SifKeywordEvidenceRecord; created: boolean }>;
  appendAttempt(input: AppendKeywordAttemptInput): Promise<void>;
  reservePhysicalRequest(input: ReserveKeywordRequestInput): Promise<KeywordRequestReservation>;
  markRequestHandedToNetwork(input: MarkKeywordRequestSentInput): Promise<void>;
  settlePhysicalRequest(input: SettleKeywordRequestInput): Promise<void>;
  claimCategoryLookup(input: ClaimCategoryLookupInput): Promise<"owner" | "existing">;
  bindEvidenceToStage(input: BindKeywordEvidenceInput): Promise<void>;
  findBoundEvidenceForRun(input: FindBoundKeywordEvidenceInput): Promise<readonly SifKeywordEvidenceRecord[]>;
  upsertEnrichmentRevision(input: CreateKeywordEnrichmentRevisionInput): Promise<KeywordEnrichmentRevisionRecord>;
}
```

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/postgres-keyword-evidence-repository.test.ts tests/agent/sqlite-keyword-evidence-repository.test.ts
```

Expected: repository modules and RuntimeAgentRepository members are missing.

- [ ] Implement validation before SQL using shared Zod schemas. Generate `evidenceId` from injected UUID once; on unique conflict lock/read the existing row and compare canonical content hash. Same content replays the existing id; different content throws `KeywordEvidenceConflictError`.

- [ ] Implement every read with actor organization and full binding filters, never `WHERE target_asin = ? ORDER BY fetched_at DESC`. `findBoundEvidenceForRun` must join project, run, sync job, stage output binding, and evidence, then reject if the requested set differs from the bound set.

- [ ] Add the interface to `RuntimeAgentRepository`, instantiate `PostgresKeywordEvidenceStore` with the existing Postgres query context, and implement the same methods inside the repository's existing monolithic `SqliteAgentRepository` transaction boundary. Delegate each PostgreSQL method explicitly. Do not expose raw query contexts or SQLite handles to routes, UI assemblers, or export.

- [ ] Ensure returned records are deep-frozen and parsed from storage; corrupt JSON or invalid status/reason throws `KeywordEvidenceDataError`, not an empty result.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/postgres-keyword-evidence-repository.test.ts tests/agent/sqlite-keyword-evidence-repository.test.ts
```

Expected: both stores pass identical isolation, idempotency, immutability, dedupe, and corruption tests.

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

- [ ] Write RED tests with an injected fetch spy: two connector attempts create two consumed receipts; timeout consumes; HTTP 500 consumes; local input validation releases; fourth SIF dispatch is blocked before fetch; ledger unavailable blocks before fetch; concurrent same-category callers create one network dispatch.

```ts
test("connector network retries consume separate target receipts and stop at three", async () => {
  const fetches: string[] = [];
  const connector = createSifConnector(keywordBudgetFixture({
    fetchImpl: async () => { fetches.push("sent"); throw { kind: "http", status: 503 }; },
    maxAttempts: 4,
  }));
  await assert.rejects(() => connector.execute(scopedKeywordRequest("B0D31VY644")));
  assert.equal(fetches.length, 3);
  assert.deepEqual(await receiptStates(), ["consumed", "consumed", "consumed"]);
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
  mode: KeywordEvidenceMode; paramsHash: string; quotaPolicyId: string;
}>;
```

For keyword operations this scope is mandatory. Other existing connector operations retain their existing governor behavior.

- [ ] Move SIF keyword accounting into the wrapper immediately around each `fetchImpl(...)`. Sequence: validate local payload and initialize connector → reserve atomically → call `markRequestHandedToNetwork` immediately before invoking fetch → settle consumed in `finally` if handed off, otherwise released. A connector retry re-enters this sequence and reserves a new receipt.

- [ ] In one repository transaction, reject reserve if count of non-released target SIF receipts is already 3, if policy row is missing/disabled, or per-job/category cap is exhausted. Map these to `quota-blocked/request-budget-unavailable`, `request-budget-exhausted`, or `physical-attempt-limit`; do not call fetch after rejection.

- [ ] Reconciler may release only reservations with `handed_to_network_at IS NULL` and an expired lease. It must never release a sent/unknown receipt. Store only a fixed redacted `resultCode` enum and duration.

- [ ] Preserve generic connector timeout/retry semantics, but allow keyword admission to stop a retry. Add explicit tests that 401/403, provider quota response, schema-error, and cancellation after handoff do not create an unaccounted dispatch.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-request-budget.test.ts tests/agent/remote-mcp-connector.test.ts
node --test tests/scripts/sif-physical-request-budget.test.mjs
```

Expected: every observed fetch corresponds to exactly one consumed receipt; released receipts prove fetch was never entered; maximum SIF fetches per target is three.

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
- Modify: `server/runtime/sync-job-dispatcher.ts`
- Modify: `scripts/run-asin-sync-job.mjs`
- Create: `scripts/lib/keyword-worker-scope.mjs`
- Test: `tests/agent/sync-job-keyword-scope.test.ts`
- Test: `tests/scripts/keyword-worker-scope.test.mjs`

**Interfaces:**

- Consumes: committed project/run/sync-job scope from Plan 02 and provider capability selection.
- Produces: frozen `KeywordWorkerScope` containing `organizationId,jobId,projectId,runId,stageId:"keywords",marketplace,orderedTargetAsins,dataCutoffAt,providerVersion,schemaVersion,quotaPolicyId`.

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

- [ ] Require exact ordered ASIN equality, organization/project/run/stage/job equality, `stageId === "keywords"`, `US`, exact `dataCutoffAt`, selected provider/schema versions, and an enabled quota policy. Reject missing DB connectivity as configuration failure; never continue with local defaults. Every produced evidence then fixes `targetAsin` from this list and `lookupAsin/categoryId` from the verified query step; neither may be supplied by an untrusted provider payload.

- [ ] Change the keywords stage command from generic `npm run keywords:sync` data-file behavior to `node scripts/build-sif-keyword-analysis.mjs --job-scope`; keep the legacy command available only behind `AGENT_KEYWORD_LEGACY_DIAGNOSTIC=1` and disallow it for a run-bound job.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-job-keyword-scope.test.ts
node --test tests/scripts/keyword-worker-scope.test.mjs
```

Expected: all missing/mismatched fields fail before external side effects; matching scope preserves ASIN order.

- [ ] Commit:

```powershell
git add server/db/sync-job-repository.ts server/db/postgres/sync-job-store.ts server/services/sync-job-worker-handler.ts server/runtime/sync-job-dispatcher.ts scripts/run-asin-sync-job.mjs scripts/lib/keyword-worker-scope.mjs tests/agent/sync-job-keyword-scope.test.ts tests/scripts/keyword-worker-scope.test.mjs
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
    execute: async request => {
      calls.push(request.input);
      if (calls.length === 1) throw providerError("INVALID_ARGUMENT");
      return canonicalFixture({ asin: "B0D31VY644", keywords: [keywordFixture()] });
    },
  }));
  assert.equal(result.mode, "target-parameter-retry");
  assert.deepEqual(calls.map(Object.keys), [
    ["asin", "country", "time_type", "time_value", "listingSearch", "topN"],
    ["asin", "country", "time_type", "time_value", "listing_search", "top_n"],
  ]);
});
```

- [ ] Run RED:

```powershell
node --test tests/scripts/sif-keyword-evidence-runner.test.mjs
```

Expected: current builder writes generated TS and has neither strict evidence runner nor parameter-error gate.

- [ ] Implement a state machine with no recursive fallback:

```js
const TARGET_STEPS = Object.freeze([
  { mode: "target-canonical", queryVariant: "asin-keywords-camel-v1" },
  { mode: "target-parameter-retry", queryVariant: "asin-keywords-snake-v1" },
]);
```

Canonical executes first. Alternate executes exactly once only when `isParameterCompatibilityError(error)` is true and registry resolution returned the explicit equivalent entry. A valid empty alternate is persisted as `empty/valid-empty` before the caller considers parent fallback.

- [ ] Compute `paramsHash` from canonical JSON of the exact provider arguments, not target identity aliases. Persist an attempt before/after each logical call with mode, provider/operation/schema versions, query variant, params hash, duration, redacted result/error code, and associated quota receipt count.

- [ ] Persist evidence before returning it. Repository failure means stage failure; do not keep a memory-only result and do not write `app/sif-keyword-analysis-data.ts`. Preserve the old file-generation path only under the explicit diagnostic flag from Task 5.

- [ ] Convert terminal errors deterministically: unknown capability → `unavailable/capability-unknown`; auth/5xx/timeout after connector policy → `unavailable/provider-unavailable`; malformed strict response → `schema-error/schema-invalid`; ledger rejection → matching `quota-blocked` reason. All carry the attempted mode and empty keywords.

- [ ] Run GREEN:

```powershell
node --test tests/scripts/sif-keyword-evidence-runner.test.mjs
```

Expected: the exact fallback matrix passes, alternate never runs for valid empty or non-parameter errors, and every returned evidence id exists in repository.

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
- Produces: `parent-listing`, `category-proxy`, or explicit unavailable evidence with verifiable relationship/category provenance and separate cross-validation facts.

- [ ] Write RED fixtures for: catalog parent, catalog main listing, Sorftime verified parent, target mismatch, inferred relationship, invalid/same ASIN, verified category, missing category, concurrent same-category targets, and Sorftime numeric cross-validation attempting to overwrite SIF fields.

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

- [ ] Implement Level 4 only after prior levels have no usable strict result. Resolve category from persisted catalog or strict same-target Sorftime detail, save `CategoryEvidence`, then atomically claim the per-job/category lookup. The owner sends one allowlisted `market_get_category_keyword_signals` request; waiters reuse the committed category evidence id rather than a process `Map`.

- [ ] Category adapter only emits keyword/category fields (`keyword`, `searchVolume`, `abaRank`, bid/trend facts). Its type contains no target listing traffic, organic rank, or advertising rank. Missing or unverified category ends as `unavailable/category-unverified`.

- [ ] Build `CrossValidationFact` only from Sorftime sales/review/price/trend metrics with `provider,metric,window,observedValue,direction,comparison`. Merge these facts after SIF normalization without mutating SIF keywords or status. Cap Sorftime verification with its own operation policy and budget receipts.

- [ ] After the final usable evidence mode is selected, enrich only its normalized, de-duplicated top 50 display keywords. Cache each result by `organizationId,marketplace,normalizedKeyword,paramsHash,schemaVersion,providerVersion,windowStart,windowEnd`; every cache miss uses the same reserve/consume/release ledger under separate operations `market_get_keyword_history` and `market_assess_keyword_promotion` with independent configured caps. Persist only immutable `enrichmentRevisionIds` on the job evidence. An enrichment error produces an explicit partial enrichment fact and cannot change the selected SIF mode/status or trigger a deeper identity fallback.

- [ ] Add an explicit three-receipt test across canonical + parent + category or canonical network retry + parent: whichever sequence reaches three first prevents a fourth physical SIF send. Add a concurrent category test proving one receipt and one provider call per job/category.

- [ ] Run GREEN:

```powershell
node --test tests/scripts/sif-keyword-fallback-orchestrator.test.mjs tests/scripts/sorftime-keyword-boundary.test.mjs tests/scripts/sif-physical-request-budget.test.mjs
```

Expected: trusted identities permit fallback, inferred/mismatched identities fail closed, category is deduplicated, and Sorftime never supplies SIF target fields.

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

- [ ] Write RED tests that reject raw `analysisByAsin`, duplicate/uncommitted ids, cross-job ids, mismatched organization/project/run, and evidence persistence after stage terminalization. Assert stage finalization cannot become `done` unless every requested target has one terminal evidence record committed and bound.

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
node --test tests/scripts/sync-stage-output.test.mjs
```

Expected: the current keyword stage schema requires `analysisByAsin/enrichmentByKeyword` from generated files.

- [ ] Change only the keywords branch of `StageDataSchemas` to strict `{ evidenceIds: z.array(EntityIdSchema).min(1).max(10) }`. Keep reviews/sales/FBA/listing/category/traffic unchanged.

- [ ] In the worker completion transaction, validate evidence organization/job and exact target coverage, insert immutable bindings, then persist stage output/hash/version. If any binding insert or evidence validation fails, roll back output and leave stage failed/partial with a typed reason; never publish ids before repository commit.

- [ ] Change `projectStageOutput("keywords")` to read the worker result manifest containing only evidence ids; do not parse `app/sif-keyword-analysis-data.ts` or enrichment TS. Delete the keywords entries from `projectionSources` while preserving legacy diagnostic code outside runtime projection.

- [ ] Ensure replay/resume with the same evidence ids and content hash is idempotent; a changed id set requires a higher output version and may only belong to the same job/run scope.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/stage-output-contract.test.ts tests/agent/sync-stage-output-persistence.test.ts
node --test tests/scripts/sync-stage-output.test.mjs
```

Expected: keyword stage output is id-only and scope-bound; raw tenant keyword JSON cannot enter stage output.

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

- [ ] Return each item with `evidenceId,targetAsin,lookupAsin,marketplace,status,mode,terminalReason,categoryEvidence,relationshipEvidence,keywords,enrichmentRevisionIds,crossValidation,provenance,quotaReceiptsSummary`. `provenance` contains `operation,queryVariant,paramsHash,schemaVersion,providerVersion,queryWindow,fetchedAt`; quota summary contains only `physicalRequestCount,consumedCount,releasedCount,terminalBudgetReason`.

- [ ] Register the route under existing auth/role middleware and add it to the Agent API contract allowlist. Extend 31900 generic proxy validation so GET query survives unchanged, session/proxy token/origin protections remain, and response is parsed with the strict shared schema.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-route.test.ts tests/agent/agent-api-schema.test.ts
```

Expected: valid run returns ordered evidence; all cross-scope and partial-leak attempts return indistinguishable 404.

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
- Modify: `app/keyword-demand-analysis.ts`
- Modify: `app/keyword-fetch-status.tsx`
- Modify: `app/keyword-demand-section.tsx`
- Modify: `app/page.tsx`
- Test: `tests/agent/keyword-evidence-browser.test.ts`
- Test: `tests/agent/keyword-evidence-ui.test.tsx`
- Test: `tests/agent/stage-output-browser.test.ts`

**Interfaces:**

- Consumes: accepted run/job-scoped keyword stage output ids and authenticated evidence GET.
- Produces: epoch-safe UI view model with explicit mode/status/terminal reason/provenance labels; no static keyword data defaults.

- [ ] Write RED tests proving page loads evidence only after accepting matching stage output, rejects stale run/job response, clears on organization/session epoch change, and renders all modes/statuses. Assert parent rows are separated from target ranking, category rows never enter ASIN traffic-share charts, and cross-validation cannot alter SIF values.

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
```

Expected: current UI imports and defaults to `sifKeywordAnalysisData`/`sifKeywordEnrichmentData`.

- [ ] Implement `createKeywordEvidenceOwner({organizationEpoch,projectId,runId,jobId})`. It accepts only ids from a matching accepted stage output, fetches the exact run-scoped URL, strict-parses the response, discards responses from an older owner epoch, and exposes `loading|ready|missing|source-error` without ASIN-latest fallback.

- [ ] Build a pure view mapper that preserves evidence id, target/lookup identity, mode, status, terminal reason, provider/schema versions, query window, fetchedAt, category/relationship evidence, and cross-validation. It may aggregate target-canonical and target-parameter-retry together only when query windows/schema/provider versions match.

- [ ] Render fixed labels:

  - `target-canonical`: “目标 ASIN · 标准查询”
  - `target-parameter-retry`: “目标 ASIN · 等价参数兼容查询”
  - `parent-listing`: “父体/主 Listing 关键词，非目标子 ASIN 独立流量”
  - `category-proxy`: “类目需求代理，不代表该 ASIN 流量”

Show terminal reason for empty/unavailable/schema-error/quota-blocked. Parent traffic is displayed under `lookupAsin`; category proxy can enter demand discovery but not competitor traffic share/rank.

- [ ] Remove imports of `./sif-keyword-analysis-data` and `./sif-keyword-enrichment-data` from all client-reachable files. `buildKeywordDemandAnalysis` must require explicit evidence-derived sources and return a typed missing state when absent, never default globals.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-browser.test.ts tests/agent/keyword-evidence-ui.test.tsx tests/agent/stage-output-browser.test.ts
```

Expected: run-scoped evidence hydrates correctly; stale/cross-scope responses cannot land; proxy modes remain visually and numerically separate.

- [ ] Commit:

```powershell
git add app/lib/keyword-evidence-browser.ts app/keyword-evidence-view.ts app/lib/stage-output-browser.ts app/keyword-demand-analysis.ts app/keyword-fetch-status.tsx app/keyword-demand-section.tsx app/page.tsx tests/agent/keyword-evidence-browser.test.ts tests/agent/keyword-evidence-ui.test.tsx tests/agent/stage-output-browser.test.ts
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

- [ ] Extend keyword snapshot evidence with `evidenceId,targetAsin,lookupAsin,status,mode,terminalReason,operation,queryVariant,paramsHash,schemaVersion,providerVersion,queryWindow,fetchedAt,relationshipEvidence,categoryEvidence,enrichmentRevisionIds,crossValidation`. Derive snapshot content hash from this full payload so provenance changes create a different immutable snapshot.

- [ ] Update product-definition contracts so every keyword group references persisted evidence ids. Require the model output to retain `sourceMode` and `scopeLabel` for parent/category-derived claims; validate that category proxy cannot support a target traffic/rank assertion and parent evidence names `lookupAsin`.

- [ ] Update JSON/file export to include the same provenance fields and redacted quota summary. Do not export raw receipt ids, URLs, headers, tokens, provider bodies, or tenant-wide data.

- [ ] Run GREEN:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-export.test.ts tests/agent/product-definition-runtime.test.ts tests/agent/postgres-keyword-analysis-snapshot-repository.test.ts
```

Expected: export and product definition consume only the bound run evidence and preserve source limitations end-to-end.

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
- Modify: `scripts/build-sif-keyword-analysis.mjs`
- Modify: `scripts/run-stable-build.mjs`
- Test: `tests/agent/keyword-evidence-policy.test.ts`
- Test: `tests/agent/keyword-evidence-observability.test.ts`
- Test: `tests/agent/keyword-client-bundle.test.ts`
- Create: `tests/agent/keyword-evidence-fallback-acceptance.test.ts`

**Interfaces:**

- Consumes: evidence/attempt/receipt/stage state from previous tasks.
- Produces: independently reversible feature flags, fixed terminal metrics/reasons, operator-safe diagnostics, and build-time proof that tenant keyword data is absent from client artifacts.

- [ ] Write RED policy tests for default-off flags and legal rollout dependencies:

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
assert.throws(() => KeywordEvidencePolicySchema.parse({ categoryProxy: true, parentListing: false }));
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

- [ ] Run RED:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-policy.test.ts tests/agent/keyword-evidence-observability.test.ts tests/agent/keyword-client-bundle.test.ts tests/agent/keyword-evidence-fallback-acceptance.test.ts
```

Expected: policy/metrics/build gate/acceptance harness do not yet exist and static imports remain client-reachable.

- [ ] Implement the six flags with dependency validation. `repositoryShadow` may parse/persist alongside legacy UI without changing reads; `strictCanonical` switches new jobs to repository evidence; deeper flags require every shallower flag. Disabling a flag affects only new runs and never relabels/deletes historical evidence.

- [ ] Emit one terminal event per target with organization represented only by a keyed hash and fields `jobId,runId,targetAsin,mode,status,terminalReason,providerVersion,schemaVersion,physicalRequestCount,durationMs`. Redact all provider payload/error material. Surface counts and lag in sync publication diagnostics without exposing evidence contents.

- [ ] Extend stable build with an import-graph and emitted-chunk scan. Permit static TS imports only from explicit server-only migration/diagnostic modules. Fail the build if client output contains either module name or configured sentinel data.

- [ ] Implement the acceptance matrix as injected fakes: canonical ready; parameter retry; verified parent; category proxy; no identity; unknown capability; schema drift; ledger missing; three receipts exhausted; concurrent category dedupe; cross-organization GET 404; UI/export/product-definition provenance. Assert terminal reasons exactly and no provider call beyond policy.

- [ ] Run GREEN and full scoped verification:

```powershell
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-policy.test.ts tests/agent/keyword-evidence-observability.test.ts tests/agent/keyword-client-bundle.test.ts tests/agent/keyword-evidence-fallback-acceptance.test.ts
npx tsx --conditions=react-server --test tests/agent/keyword-evidence-contract.test.ts tests/agent/postgres-keyword-evidence-repository.test.ts tests/agent/sqlite-keyword-evidence-repository.test.ts tests/agent/keyword-request-budget.test.ts tests/agent/sync-job-keyword-scope.test.ts tests/agent/keyword-evidence-route.test.ts tests/agent/keyword-evidence-browser.test.ts tests/agent/keyword-evidence-ui.test.tsx tests/agent/keyword-evidence-export.test.ts tests/agent/product-definition-runtime.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/postgres-migrations.test.ts
node --test tests/scripts/sif-keyword-strict-adapter.test.mjs tests/scripts/sif-physical-request-budget.test.mjs tests/scripts/keyword-worker-scope.test.mjs tests/scripts/sif-keyword-evidence-runner.test.mjs tests/scripts/sif-keyword-fallback-orchestrator.test.mjs tests/scripts/sorftime-keyword-boundary.test.mjs tests/scripts/sync-stage-output.test.mjs
npx eslint shared/keyword-evidence-contracts.ts server/db/keyword-evidence-repository.ts server/db/postgres/keyword-evidence-store.ts server/db/sqlite-repository.ts server/services/keyword-request-budget-service.ts server/services/keyword-evidence-read-service.ts server/services/keyword-evidence-projection-service.ts server/services/keyword-evidence-observability.ts server/config/keyword-evidence-policy.ts server/routes/keyword-evidence.ts app/lib/keyword-evidence-browser.ts app/keyword-evidence-view.ts app/keyword-demand-analysis.ts app/keyword-fetch-status.tsx app/keyword-demand-section.tsx app/page.tsx
npm run build
git diff --check
```

Expected: all focused and regression tests pass, ESLint exits 0, build scan finds no tenant/static keyword data in client output, and diff check is clean.

- [ ] Perform rollback verification without modifying historical rows: with all flags off, new jobs remain on the explicit legacy path; enable through category in order and verify each mode; disable category → parent → parameter → canonical and verify only new runs change. Repository evidence, receipts, and existing run bindings remain readable through their authenticated run-scoped API.

- [ ] Commit:

```powershell
git add server/config/keyword-evidence-policy.ts server/services/keyword-evidence-observability.ts server/config.ts server/services/sync-publication-status-service.ts scripts/build-sif-keyword-analysis.mjs scripts/run-stable-build.mjs tests/agent/keyword-evidence-policy.test.ts tests/agent/keyword-evidence-observability.test.ts tests/agent/keyword-client-bundle.test.ts tests/agent/keyword-evidence-fallback-acceptance.test.ts
git commit -m "test(keywords): gate scoped evidence rollout"
```

## Final Self-Review Checklist

- [ ] **Strict provider schema/version:** registry entries name exact operation, parameter keys, query variant, schema/provider version and compatibility; unknown capability is fail-closed.
- [ ] **Repository authority:** both database engines implement the same `KeywordEvidenceRepository`; runtime never reads global TS or ASIN-latest data.
- [ ] **Scope completeness:** organization/project/run/stage/job/target/lookup/category identities are persisted and verified at worker, binding, API, UI/export and product-definition boundaries.
- [ ] **Physical request accounting:** every actual SIF fetch has one receipt; all network retries count; no target exceeds three; category requests dedupe transactionally; sent failures consume and only proven-unsent requests release.
- [ ] **Fallback semantics:** alternate is explicit and single-use; parent/main identity is trusted and separately labeled; category is proxy-only; Sorftime remains verification/cross-validation only.
- [ ] **Evidence immutability/read authorization:** evidence id and binding are immutable; GET is run-scoped, exact-set, organization-authorized, all-or-nothing 404.
- [ ] **Provenance propagation:** status/mode/terminal reason/lookup identity/operation/query variant/params hash/schema/provider version/window/fetchedAt/evidence id survive adapter → repository → stage → API → UI/export/product-definition.
- [ ] **Terminal behavior:** `ready`, `empty`, `unavailable`, `schema-error`, and `quota-blocked` obey the exact keywords/reason matrix and render explicit gaps.
- [ ] **Client security:** no client import or emitted chunk contains static tenant keyword datasets, owner manifests, credentials, raw response or receipt ids.
- [ ] **Quota/failure/rollback/observability:** default-off dependent flags, fixed redacted metrics, typed source errors, forward-only migrations and reverse-depth rollback are all tested.
- [ ] **No placeholders:** `rg -n "[T]BD|[T]ODO|[F]IXME|[l]ater|[s]imilar to|待[定]|后续[补]|占[位]" docs/superpowers/plans/2026-08-31-sif-keyword-evidence-fallback.md` returns no matches.
- [ ] **Type consistency:** shared Zod contracts, repository records, stage output, API response, browser view, export and product-definition use the same enum literals and immutable evidence ids.
- [ ] **Commit isolation:** each task commit contains only its listed files; generated data, publication state, provider credentials and user WIP remain unstaged; no push is performed.
