# Comparison Draft ASIN Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用唯一的 `comparisonDraft` 管理 0–10 个可编辑 ASIN；只在保存或运行时冻结并校验 3–10 个合法、唯一 ASIN。所有新组合创建为 Agent PostgreSQL 中不可变项目，历史项目/运行不被修改或删除。

**Architecture:** 浏览器 reducer 持有短生命周期草稿，`CommittedComparisonScope` 单独持有已验证的 Agent project/run 快照。Web 同源 API 从 session principal 代理到 31901；31901 从 principal 推导 organization，事务内写入项目与 project-create 幂等记录。文件系统只保留按 organization 分区的收藏引用和只读 legacy 适配，不再是新项目 ASIN scope 的权威源。

**Tech Stack:** TypeScript, React/Vinext, Zod, Fastify, PostgreSQL/SQLite repositories, Node `tsx --test`, React test renderer/harness, ESLint.

## Global Constraints

- 规划/预检基线固定为 `a5d233bdfe977fb33d814b79a89352d567d3d6c5`（Plan 01 migrations `0019`/`0020` 已完成）；本计划开始执行前还必须先完成主恢复计划 Batch 0 的独立 acceptance commit，修复 Manual VOC 产品分析透传、普通 Node composition root 和陈旧 migration 断言。执行者必须在该 acceptance commit 上重新确认 `0021` 不存在、Plan 02 仍为 `0/8` tasks implemented，然后才可开始 Task 1。
- 批准规格为 `docs/superpowers/specs/2026-08-31-realtime-voc-asin-draft-keyword-fallback-design.md` 的第 8、10.3、13.2、14.3 节；仅实施切片二，不修改 Manual Alexa VOC 发布、`ProjectableSyncStageSchema`、SIF adapter/evidence/预算或 provider。
- `comparisonDraft` 是唯一编辑真相。不得以 effect、localStorage 迁移或镜像 state 重新引入 `inputs`、`asinDraft`、`activeAsins` 三个可变业务真相；可以保留只读派生变量作为展示兼容层。
- 草稿允许 0–10 个 raw slots；少于 3 是可编辑状态而不是输入错误。`>10` 的 add/paste/replace action 整体拒绝、保留上一草稿、显示 `too-many`，不得截断、部分写入或静默丢 ASIN。
- 新项目权威源只能是 Agent DB `projects`；项目 marketplace 与 ordered ASIN 永远不可 PATCH。所有创建、列表、读取、运行均从认证 principal 推导 organization，跨组织一律按 404 处理，不能根据 request/query/body 选择组织。
- 保存和运行均先调用 `snapshotValidComparisonDraft()`，读取一次 revision 并返回冻结 `{ marketplace, asins, draftRevision }`。任何异步成功仅可更新同 revision；旧请求可以产生其旧 snapshot 的项目/运行，但绝不可把更新后的 draft 标记为 clean。
- 默认“另存为新组合”：dirty draft 的保存或运行总是新建 project；clean 已加载 project 可在该 project 下新建 run；同 ASIN 组合只显示可点击的“打开已有组合”，永不自动复用。项目、run、snapshot、报告不会被此切片更新或删除。
- `Idempotency-Key` 只接受 16–128 位 ASCII `[A-Za-z0-9._:-]`；缺失/非法 400，同 organization + key + canonical payload 回放原 project，payload 不同 409 `IDEMPOTENCY_KEY_REUSED`，不同 organization 可使用相同 key。
- 每个用户 create/run action 的 idempotency key 只能由 `comparison-project-client.ts` 在 action 开始时生成一次；同一 action 的网络重试必须复用原 key。31900 只用 `IdempotencyKeySchema` 验证 header 后原样转发给 31901，绝不生成、替换或将 key 写回 body。
- 文件收藏只保存 `{ organizationId, agentProjectId, kind, slug, labels }`，删除收藏只删除此引用。legacy 文件项目仅在 owner gate 成功时只读展示；无 owner 只能由部署迁移一次绑定到有效 `LEGACY_PROJECT_DEFAULT_ORGANIZATION_ID`，不得由访问者自动认领。
- migration 顺序固定为 Plan 01 Manual VOC `0019` + VOC provenance `0020` → 本计划 SQLite/PostgreSQL `0021` → Plan 03 KeywordEvidence `0022`。本计划所有共享 `shared/agent-contracts.ts`、`app/page.tsx`、repository 与 migration 改动必须从已提交的 Plan 01 开始；Plan 03 只能从本计划已提交版本继续，保留 `comparisonDraft`、`committedScope`、Manual VOC overlay 与 session epoch 逻辑。
- Batch 0 会让 `app/page.tsx` 把同一份 `manualVocByAsin` 与页面已解析的 keyword source 传给 launch、VOC positioning、product definition 和 checklist 消费者。Task 5–8 修改共享页面时必须保留该 source owner、Manual VOC session/org epoch fence、overlay 合并顺序和所有消费组件 props；Plan 02 不得恢复静态 VOC、删掉 keyword source，或让草稿 ASIN 驱动历史 run 数据。
- 当前全树 `npx tsc --noEmit --incremental false --pretty false` 是已确认的非零基线：exit 2、306 diagnostics。逐 Task GREEN 只要求 focused tests、changed-path TypeScript diagnostics=0、列出文件的 ESLint 和 diff-check；不得把 full-tree `tsc` 写成 expected PASS。全树 compiler 只在统一恢复计划 Batch 7 重跑，并按基线已有、已解决、实现新增三类记录；实现新增必须为 0。
- 外部 preflight `771cbaa test(sync): align stage output owner contract` 已单独提交，修复的是无关的 stage-output 测试合同；它不是本计划的任务、文件或提交的一部分，不得混入任一 Task。
- 实现和测试不得启动、停止、重启或访问 31900/31901/58258，不运行真实 build、provider、connector 或 Chrome；测试使用依赖注入、内存/临时目录和 Fastify inject。每任务只 stage 该任务列出的文件，不使用 `git add .`、reset、checkout、clean、stash、rebase、amend 或 push。

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `app/lib/comparison-draft.ts` | Client-safe types, reducer, normalize/validation and immutable action snapshot. No I/O or React imports. |
| `app/lib/comparison-project-client.ts` | Typed same-origin fetch client; is the sole creator and retry owner of action-local idempotency keys, and verifies echoed project scope before callers accept it. |
| `app/lib/comparison-draft-policy.ts` | Strict default-off `COMPARISON_DRAFT_UI_ENABLED` policy and client-visible rollback capability; disabling it restores the legacy editor only, never mutable project/run storage. |
| `app/comparison-project-library-panel.tsx` | Favorite/legacy read-only library UI and explicit “导入为新组合” action; cannot edit ASIN scope. |
| `app/page.tsx` | Replaces parallel ASIN states/actions, URL hydrate fencing, committed scope binding, save/run UI, and clear state copy. |
| `app/api/comparison-projects/route.ts` | Session-authenticated list/create proxy to 31901 and favorite creation only after Agent project verification. |
| `app/api/comparison-projects/[projectId]/route.ts` | Principal-scoped Agent project GET and metadata-only PATCH proxy. |
| `app/api/comparison-favorites/[projectId]/route.ts` | Delete only the current organization’s favorite reference. |
| `app/api/comparison-projects/config/route.ts` | Same-origin, non-sensitive runtime UI flag response; it exposes no organization, project or ASIN data. |
| `app/lib/comparison-project-server.ts` | Server-only composition of session, `createAgentServiceClient`, favorite store and Agent-returned legacy eligibility; it never imports a repository or queries Agent DB directly. |
| `scripts/lib/project-favorite-store.mjs` | Organization-partitioned favorite reference I/O; no ASIN, marketplace, run, report or mutable project fields. |
| `scripts/lib/project-store.mjs` | Task 3 adds the side-effect-free UUID-file reader `readProjectReadonly`; existing list/create/update/delete behavior remains legacy-only. |
| `server/db/migrations/0021_comparison_project_scope.sql` | SQLite project-create idempotency and legacy owner-binding tables/indexes, after Plan 01 migrations 0019/0020. |
| `server/db/migrations/postgres/0021_comparison_project_scope.sql` | PostgreSQL equivalent of SQLite migration 0021. |
| `server/db/repository.ts`, `server/db/sqlite-repository.ts`, `server/db/postgres-repository.ts` | Transactional project idempotency, principal-scoped list/read, metadata patch, and legacy binding repository contracts. |
| `server/services/analysis-run-service.ts` | Immutable create/list/read/metadata patch semantics and project/run snapshot verification. |
| `server/services/legacy-project-ownership-service.ts`, `server/routes/legacy-project-ownership.ts`, `server/cli/bind-legacy-project-owner.ts` | Authenticated Agent 31901 read/bind contract and operator CLI for one-time ownerless legacy binding; Web callers have no database shortcut. |
| `server/routes/analysis-runs.ts`, `shared/agent-contracts.ts`, `server/app.ts` | Header/body/response contracts for project list/create/read/PATCH, legacy ownership and strict run creation. |
| `tests/web/comparison-draft.test.ts` | Reducer and snapshot unit tests. |
| `tests/agent/comparison-project-contract.test.ts` | Fastify/service/repository contract tests using injected clock/id/temporary SQLite. |
| `tests/app/comparison-project-api.test.ts` | Same-origin proxy, favorite and legacy owner-gate tests with injected Agent/favorite adapters. |
| `tests/agent/comparison-page-state.test.tsx` | Page reducer/hydrate/action-race harness; no real browser or server ports. |

## Changed-path TypeScript Gate

Run this PowerShell helper in the execution shell before each Task GREEN command. It intentionally runs the real project compiler, but fails only when a diagnostic belongs to a path passed by that Task; the known full-tree exit 2 remains visible and is not mislabeled as success.

```powershell
function ConvertTo-NormalizedTscDiagnostic([string]$Line) {
  $normalized = $Line.Replace('\\', '/')
  if ($normalized -match '^([^\(]+)\(\d+,\d+\): error (TS\d+): (.*)$') {
    return "$($Matches[1])|$($Matches[2])|$($Matches[3])"
  }
  return $null
}

function Assert-NoAffectedTypeDiagnostics([string[]]$Paths) {
  $baselinePath = '.superpowers/sdd/voc-keyword-tsc-baseline.txt'
  if (-not (Test-Path -LiteralPath $baselinePath)) { throw "Missing frozen TypeScript baseline" }
  $output = @(& npx tsc --noEmit --incremental false --pretty false 2>&1)
  $normalizedPaths = @($Paths | ForEach-Object { $_.Replace('\\', '/') })
  $baseline = @(Get-Content -LiteralPath $baselinePath | ForEach-Object { ConvertTo-NormalizedTscDiagnostic "$_" } | Where-Object { $_ } | Sort-Object -Unique)
  $current = @($output | ForEach-Object { ConvertTo-NormalizedTscDiagnostic "$_" } | Where-Object { $_ } | Sort-Object -Unique)
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

## Contract to Implement

```ts
// app/lib/comparison-draft.ts
export type DraftIssue =
  | { readonly code: "invalid"; readonly slot: number; readonly value: string }
  | { readonly code: "duplicate"; readonly slot: number; readonly asin: string }
  | { readonly code: "too-many"; readonly attemptedCount: number };

export type ComparisonDraft = Readonly<{
  slots: readonly string[];
  normalizedAsins: readonly string[];
  issues: readonly DraftIssue[];
  source: "empty" | "url" | "project" | "run" | "user";
  basedOnProjectId: string | null;
  dirty: boolean;
  revision: number;
}>;

export type CommittedComparisonScope = Readonly<{
  organizationId: string;
  marketplace: Marketplace;
  projectId: string;
  runId: string | null;
  asins: readonly string[];
  committedAt: string;
}>;

export type ValidComparisonDraftSnapshot = Readonly<{
  marketplace: Marketplace;
  asins: readonly string[];
  draftRevision: number;
}>;

export function reduceComparisonDraft(
  current: ComparisonDraft,
  action: ComparisonDraftAction,
): ComparisonDraft;
export function snapshotValidComparisonDraft(
  draft: ComparisonDraft,
  marketplace: Marketplace,
): ValidComparisonDraftSnapshot | { readonly error: DraftValidationError };
```

```ts
// shared/agent-contracts.ts additions
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/);
export const UpdateProjectMetadataRequestSchema = strictObject({
  name: z.string().trim().min(1).max(200).optional(),
});
// Request ASINs and marketplace are deliberately absent from PATCH.
export const ListProjectsResponseSchema = strictObject({ projects: z.array(ProjectSchema) });
```

`POST /v1/projects` reads `Idempotency-Key` from the HTTP header, not the body. `POST /v1/projects/:projectId/runs` keeps its strict run idempotency field and rejects external `dataCutoffAt`; both project and run APIs return `409` rather than reusing a different immutable scope. Project creation canonical hash is SHA-256 of the stable serialization of `{ name, marketplace, orderedAsins }` after schema normalization.

```ts
// Agent-only legacy ownership contract in shared/agent-contracts.ts
export const LegacyProjectIdParamsSchema = strictObject({ legacyProjectId: EntityIdSchema });
export const LegacyProjectEligibilityResponseSchema = strictObject({
  legacyProjectId: EntityIdSchema,
  ownerOrganizationId: EntityIdSchema,
  readOnly: z.literal(true),
  importAllowed: z.literal(true),
});
export const BindLegacyProjectOwnerRequestSchema = strictObject({
  legacyProjectId: EntityIdSchema,
  expectedDefaultOrganizationId: EntityIdSchema,
});
// GET /v1/legacy-projects/:legacyProjectId/eligibility is principal-scoped.
// POST /v1/admin/legacy-project-owner-bindings is authenticated operator-only.
```

### Task 1: Establish the pure draft reducer and immutable action snapshot

**Files:**
- Create: `app/lib/comparison-draft.ts`
- Create: `tests/web/comparison-draft.test.ts`

- [ ] **Step 1: Write RED reducer tests.** Cover exact raw-slot behavior: empty draft; add until ten; remove the only slot; input-slot replace; batch replace; clear; trim/uppercase normalization; invalid/duplicate diagnostics; 0–2 legal edit state; and all-or-nothing 11-item add/paste/replace. Include a freeze assertion and snapshot failures for invalid, duplicate, `<3`, and `>10`.

  ```ts
  const before = makeDraft(["B0AAAA0001", "B0BBBB0002"]);
  assert.equal(Object.isFrozen(before), true);
  const after = reduceComparisonDraft(before, { type: "replace-all", slots: elevenAsins });
  assert.notStrictEqual(after, before);
  assert.deepEqual(after.slots, before.slots);
  assert.deepEqual(after.normalizedAsins, before.normalizedAsins);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.issues, [...before.issues, { code: "too-many", attemptedCount: 11 }]);
  assert.deepEqual(before.issues, []);
  assert.equal(snapshotValidComparisonDraft(makeDraft(["B0AAAA0001", "B0BBBB0002"]), "US").error.code, "minimum-asins");
  ```

- [ ] **Step 2: Run RED.**

  ```powershell
  npx tsx --conditions=react-server --test tests/web/comparison-draft.test.ts
  ```

  Expected: module-not-found or missing export failure; do not accept a fixture or runner failure as RED evidence.

- [ ] **Step 3: Implement the minimum reducer.** Define `ComparisonDraftAction` as `add-slot`, `remove-slot`, `replace-slot`, `replace-all`, `clear`, and `hydrate`. Every accepted action creates a new frozen draft with `revision + 1`; rejected `>10` returns the prior slots/revision with a `too-many` issue. `replace-all` is the common path for textarea and slots. `snapshotValidComparisonDraft` captures `revision` once, copies and freezes ordered normalized ASINs, and never closes over mutable draft state.

- [ ] **Step 4: Run GREEN and static check.**

  ```powershell
  npx tsx --conditions=react-server --test tests/web/comparison-draft.test.ts
  npx eslint app/lib/comparison-draft.ts tests/web/comparison-draft.test.ts
  Assert-NoAffectedTypeDiagnostics @('app/lib/comparison-draft.ts','tests/web/comparison-draft.test.ts')
  ```

  Expected: all reducer cases PASS; no mutation or unsafe type diagnostics.

- [ ] **Step 5: Commit Task 1.**

  ```powershell
  git diff --check -- app/lib/comparison-draft.ts tests/web/comparison-draft.test.ts
  git add -- app/lib/comparison-draft.ts tests/web/comparison-draft.test.ts
  git diff --cached --name-only
  git commit -m "feat(comparison): add immutable ASIN draft reducer"
  ```

  The staged-file output must contain only the two listed files.

### Task 2: Add transactional immutable Agent project contracts and migrations

**Files:**
- Modify: `shared/agent-contracts.ts`
- Modify: `server/db/repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/db/postgres-repository.ts`
- Create: `server/db/migrations/0021_comparison_project_scope.sql`
- Create: `server/db/migrations/postgres/0021_comparison_project_scope.sql`
- Create: `tests/agent/comparison-project-contract.test.ts`

- [ ] **Step 1: Write RED repository/migration tests.** With an injected temporary SQLite repository and deterministic IDs/clocks, prove that `createProjectOnce` persists same-org same-key/same-hash replay after repository re-open; returns `IDEMPOTENCY_KEY_REUSED` for different name, marketplace, order, or ASIN list; and allows the same key in a different organization. Verify `IdempotencyKeySchema` accepts `A_valid.key:0001` and rejects too-short/non-ASCII strings. Add migration-up tests from the pre-0021 SQLite and PostgreSQL heads. Route-level missing/malformed-header 400 assertions belong exclusively to Task 3, where their route and service exist.

  ```ts
  const first = await repository.createProjectOnce({ organizationId, idempotencyKey: key, requestHash, project });
  await reopenRepository();
  const replay = await repository.createProjectOnce({ organizationId, idempotencyKey: key, requestHash, project });
  assert.equal(first.kind, "created");
  assert.equal(replay.kind, "replay");
  assert.equal(replay.project.id, first.project.id);
  assert.equal(CreateRunRequestSchema.safeParse({ mode: "existing-data", idempotencyKey: key, dataCutoffAt: "2026-08-31T00:00:00.000Z" }).success, false);
  ```

- [ ] **Step 2: Run RED.**

  ```powershell
  npx tsx --conditions=react-server --test tests/agent/comparison-project-contract.test.ts
  ```

  Expected: missing repository methods/migration 0021 or replay assertions fail under the pre-change implementation; this Task does not require an HTTP route.

- [ ] **Step 3: Define strict schema and storage interfaces.** Add `IdempotencyKeySchema`, `ListProjectsResponseSchema`, `UpdateProjectMetadataRequestSchema`, `ProjectCreationIdempotencyRecord`, `findProjectCreationIdempotency`, `createProjectOnce`, `listProjectsForOrganization`, and `updateProjectMetadata`. The HTTP header parser is introduced with route/service integration in Task 3. Do not add ASIN or marketplace to the metadata patch schema. Plan 01 Task 8 already owns removal of external `dataCutoffAt`: this Task must not modify `CreateRunRequestSchema`; it only retains a regression assertion that `CreateRunRequestSchema.safeParse({ mode: "existing-data", idempotencyKey: key, dataCutoffAt: NOW }).success` is `false`.

- [ ] **Step 4: Implement forward-only migrations and repositories.** Both migrations create:

  ```sql
  CREATE TABLE project_creation_idempotency (
    organization_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    project_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (organization_id, idempotency_key)
  );
  CREATE TABLE legacy_project_owner_bindings (
    legacy_project_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    bound_by TEXT NOT NULL,
    bound_at TEXT NOT NULL
  );
  ```

  Use UUID/foreign-key column types and existing timestamp conventions in PostgreSQL. `createProjectOnce` must canonicalize the already Zod-normalized payload, insert `projects` and idempotency row in one transaction, resolve a uniqueness race by rereading the same organization/key, and never return another organization’s record. `updateProjectMetadata` updates only `name`/`updated_at`; a direct ASIN or marketplace patch receives `409 IMMUTABLE_SCOPE` before any write. The migration filenames and migration test expectations must be exactly `0021_comparison_project_scope`, never 0011, 0019, or 0020.

- [ ] **Step 5: Run GREEN and migration checks.**

  ```powershell
  npx tsx --conditions=react-server --test tests/agent/comparison-project-contract.test.ts
  Assert-NoAffectedTypeDiagnostics @('shared/agent-contracts.ts','server/db/repository.ts','server/db/sqlite-repository.ts','server/db/postgres-repository.ts','tests/agent/comparison-project-contract.test.ts')
  ```

  Expected: SQLite migration/reopen replay, PostgreSQL migration fixture, schema validation and tenant isolation all PASS. Do not execute a real PostgreSQL container or service.

- [ ] **Step 6: Commit Task 2.**

  ```powershell
  git diff --check -- shared/agent-contracts.ts server/db/repository.ts server/db/sqlite-repository.ts server/db/postgres-repository.ts server/db/migrations/0021_comparison_project_scope.sql server/db/migrations/postgres/0021_comparison_project_scope.sql tests/agent/comparison-project-contract.test.ts
  git add -- shared/agent-contracts.ts server/db/repository.ts server/db/sqlite-repository.ts server/db/postgres-repository.ts server/db/migrations/0021_comparison_project_scope.sql server/db/migrations/postgres/0021_comparison_project_scope.sql tests/agent/comparison-project-contract.test.ts
  git diff --cached --name-only
  git commit -m "feat(projects): make comparison scopes immutable and idempotent"
  ```

### Task 3: Enforce principal-scoped Agent routes and run-scope boundaries

**Files:**
- Modify: `server/routes/analysis-runs.ts`
- Modify: `server/services/analysis-run-service.ts`
- Create: `server/routes/legacy-project-ownership.ts`
- Create: `server/services/legacy-project-ownership-service.ts`
- Create: `server/cli/bind-legacy-project-owner.ts`
- Modify: `scripts/lib/project-store.mjs`
- Modify: `server/app.ts`
- Modify: `shared/agent-contracts.ts`
- Modify: `tests/agent/comparison-project-contract.test.ts`
- Create: `tests/scripts/project-store-readonly.test.mjs`

- [ ] **Step 1: Extend RED API tests.** Assert `POST /v1/projects` returns 400 before service invocation when `Idempotency-Key` is absent, too short, non-ASCII or contains a space; accepts a valid header and exposes the same exact key to the service. Assert `GET /v1/projects` lists only the principal organization; `GET /v1/projects/:id` and `PATCH /v1/projects/:id` return 404 cross organization; and project response echoes exact `id`, `organizationId`, `marketplace`, ordered `asins`. Assert `PATCH` metadata succeeds while body attempts to include `asins` or `marketplace` returns 400 (strict schema), and a repository-level immutable-scope attempt is 409. Add a run test: body containing `dataCutoffAt` is 400, run creation validates ownership and replays only the same immutable project/mode/idempotency scope.

  Add Agent legacy contract cases: a same-org explicit owner or existing binding gets `GET /v1/legacy-projects/:id/eligibility` with `readOnly/importAllowed`; foreign/missing owner gets 404; only the authenticated operator endpoint or `bind-legacy-project-owner` CLI can create an ownerless binding, validates `LEGACY_PROJECT_DEFAULT_ORGANIZATION_ID` against an active user organization, records `bound_by/bound_at`, and replays the same binding without changing it. A member-facing route must never bind as a side effect. In `tests/scripts/project-store-readonly.test.mjs`, use a temporary `directory` and assert a missing UUID returns `null` without creating that directory, while an existing JSON file is parsed to a frozen value without changing its mtime or adding a slug.

- [ ] **Step 2: Run RED.**

  ```powershell
  npx tsx --conditions=react-server --test --test-name-pattern="principal-scoped project|immutable project patch|run cutoff|legacy" tests/agent/comparison-project-contract.test.ts
  node --test tests/scripts/project-store-readonly.test.mjs
  ```

- [ ] **Step 3: Implement routes and service methods.** `registerAnalysisRunRoutes` parses `request.headers["idempotency-key"]` with `IdempotencyKeySchema` before calling `createProject`, returns 400 on missing/invalid values, passes the exact header value to `AnalysisRunService.createProject`, adds authenticated `GET /v1/projects` and `PATCH /v1/projects/:projectId`, and maps key reuse to typed `409 IDEMPOTENCY_KEY_REUSED`. `AnalysisRunService` derives organization only from `executionContext`; list/read/update return 404 on organization mismatch. `createRun` uses the stored project ASIN order and server clock/cutoff path from the completed Manual VOC slice; it does not accept browser cutoff or a changing page array.

  Add this sole file-system reader to `scripts/lib/project-store.mjs`:

  ```js
  export function readProjectReadonly(id, { directory = projectsDir } = {}) {
    const key = String(id ?? "").trim();
    if (!/^[a-f0-9-]{36}$/i.test(key)) return null;
    const file = path.join(directory, `${key}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      const project = normalizeProject(JSON.parse(fs.readFileSync(file, "utf8")));
      return project ? Object.freeze({ ...project, asins: Object.freeze([...(project.asins ?? [])]) }) : null;
    } catch {
      return null;
    }
  }
  ```

  `readProjectReadonly` must never call `ensureProjectsDir`, `readProject`, `listProjects`, `ensureProjectSlug`, `writeProject`, `createProject`, `updateProject`, or `deleteProject`; it accepts only a UUID, never resolves a slug, never enumerates a directory, and returns no project when the file is absent or malformed.

  Register `legacy-project-ownership.ts` from `server/app.ts`. `LegacyProjectOwnershipService` receives `readLegacyProject: typeof readProjectReadonly` by dependency injection and calls it exactly once for an eligibility request before consulting `legacy_project_owner_bindings`; its authenticated read returns only the principal-scoped, read-only import mapping. Its operator-only bind route and `server/cli/bind-legacy-project-owner.ts --legacy-project-id <uuid> --default-organization-id <uuid>` call the same `LegacyProjectOwnershipService.bindOnce`; the service reads/writes `legacy_project_owner_bindings` through `AgentRepository`, verifies the configured default organization has an active user, and refuses a different existing binding. Neither route accepts an organization selected by a member body/query parameter.

- [ ] **Step 4: Run GREEN.**

  ```powershell
  npx tsx --conditions=react-server --test tests/agent/comparison-project-contract.test.ts
  node --test tests/scripts/project-store-readonly.test.mjs
  Assert-NoAffectedTypeDiagnostics @('server/routes/analysis-runs.ts','server/services/analysis-run-service.ts','server/routes/legacy-project-ownership.ts','server/services/legacy-project-ownership-service.ts','server/cli/bind-legacy-project-owner.ts','server/app.ts','shared/agent-contracts.ts','tests/agent/comparison-project-contract.test.ts')
  ```

- [ ] **Step 5: Commit Task 3.**

  ```powershell
  git diff --check -- server/routes/analysis-runs.ts server/services/analysis-run-service.ts server/routes/legacy-project-ownership.ts server/services/legacy-project-ownership-service.ts server/cli/bind-legacy-project-owner.ts scripts/lib/project-store.mjs server/app.ts shared/agent-contracts.ts tests/agent/comparison-project-contract.test.ts tests/scripts/project-store-readonly.test.mjs
  git add -- server/routes/analysis-runs.ts server/services/analysis-run-service.ts server/routes/legacy-project-ownership.ts server/services/legacy-project-ownership-service.ts server/cli/bind-legacy-project-owner.ts scripts/lib/project-store.mjs server/app.ts shared/agent-contracts.ts tests/agent/comparison-project-contract.test.ts tests/scripts/project-store-readonly.test.mjs
  git diff --cached --name-only
  git commit -m "feat(projects): scope immutable projects to the principal"
  ```

### Task 4: Create a favorite-only file layer and owner-gated legacy adapter

**Files:**
- Create: `scripts/lib/project-favorite-store.mjs`
- Create: `app/lib/comparison-project-server.ts`
- Create: `app/api/comparison-projects/route.ts`
- Create: `app/api/comparison-projects/[projectId]/route.ts`
- Create: `app/api/comparison-favorites/[projectId]/route.ts`
- Create: `tests/app/comparison-project-api.test.ts`

- [ ] **Step 1: Write RED server adapter tests.** Inject a fake `createAgentServiceClient` and a temporary directory. Prove that comparison create requires an incoming valid `Idempotency-Key`, forwards its byte-for-byte value to `/v1/projects`, first receives/verifies `{ id, organizationId, marketplace, asins }` from Agent, then writes exactly one favorite reference with no `asins`, `marketplace`, `runId`, or report data. A retry with the same incoming key must result in the same forwarded key, never a generated replacement. Simulate favorite write failure and assert Agent project remains untouched and the response tells UI to retry favorite. Prove only own organization can list/delete refs.

  Add legacy fixtures for (a) explicit owner equal principal, (b) explicit foreign owner, (c) ownerless with an audited binding to valid default org, and (d) ownerless with missing/invalid default. Assert (a)/(c) are read-only, expose “导入为新组合” data, (b) and (d) return 404, and no route writes a binding on a visitor request.

- [ ] **Step 2: Run RED.**

  ```powershell
  npx tsx --conditions=react-server --test tests/app/comparison-project-api.test.ts
  ```

- [ ] **Step 3: Implement storage and server composition.** `project-favorite-store.mjs` serializes only:

  ```ts
  type ProjectFavoriteRef = Readonly<{
    organizationId: string;
    agentProjectId: string;
    kind: "analysis" | "keyword-compare" | "traffic-promo" | "checklist";
    slug: string;
    labels: readonly string[];
  }>;
  ```

  Store references beneath `data/project-favorites/<organizationId>/<agentProjectId>.json` with traversal-safe IDs and atomic write/rename. `comparison-project-server.ts` reads session principal and calls only `createAgentServiceClient` for `POST/GET/PATCH /v1/projects` and `GET /v1/legacy-projects/:id/eligibility`; it validates Agent response fields before committing favorite state. It imports neither `AgentRepository`, a DB store, nor `scripts/lib/project-store.mjs`, and never reads `legacy_project_owner_bindings` directly. The only binding writer is Task 3's authenticated operator Agent endpoint/CLI.

- [ ] **Step 4: Implement same-origin routes.** `POST /api/comparison-projects` accepts `{ name, marketplace, asins, kind, labels }` plus the client-supplied header, rejects an absent/malformed `Idempotency-Key` with 400, then forwards that exact header unchanged to 31901. It does not call `randomUUID`, create a substitute key, or place the key in request JSON. After a verified Agent response it attempts favorite creation. `GET` lists Agent projects plus only own favorite/eligible legacy metadata returned by Agent. `GET/PATCH /api/comparison-projects/:projectId` proxy principal-scoped Agent read/metadata patch; `DELETE /api/comparison-favorites/:projectId` removes only the current org’s reference. No comparison route calls `/v1/local-data/projects`, accepts an organization id, imports a repository, or queries a DB table.

- [ ] **Step 5: Run GREEN and route lint.**

  ```powershell
  npx tsx --conditions=react-server --test tests/app/comparison-project-api.test.ts
  npx eslint app/lib/comparison-project-server.ts app/api/comparison-projects/route.ts app/api/comparison-projects/[projectId]/route.ts app/api/comparison-favorites/[projectId]/route.ts
  Assert-NoAffectedTypeDiagnostics @('app/lib/comparison-project-server.ts','app/api/comparison-projects/route.ts','app/api/comparison-projects/[projectId]/route.ts','app/api/comparison-favorites/[projectId]/route.ts','tests/app/comparison-project-api.test.ts')
  ```

- [ ] **Step 6: Commit Task 4.**

  ```powershell
  git diff --check -- scripts/lib/project-favorite-store.mjs app/lib/comparison-project-server.ts app/api/comparison-projects/route.ts app/api/comparison-projects/[projectId]/route.ts app/api/comparison-favorites/[projectId]/route.ts tests/app/comparison-project-api.test.ts
  git add -- scripts/lib/project-favorite-store.mjs app/lib/comparison-project-server.ts app/api/comparison-projects/route.ts app/api/comparison-projects/[projectId]/route.ts app/api/comparison-favorites/[projectId]/route.ts tests/app/comparison-project-api.test.ts
  git diff --cached --name-only
  git commit -m "feat(projects): gate legacy favorites by organization"
  ```

### Task 5: Add typed client verification and replace page ASIN ownership state

**Files:**
- Create: `app/lib/comparison-project-client.ts`
- Modify: `app/page.tsx`
- Create: `tests/agent/comparison-page-state.test.tsx`

- [ ] **Step 1: Write RED page-state tests.** Factor the page’s ASIN state transitions behind exported test-only pure bindings or a dedicated hook harness. Test that editing an input, textarea paste, clear, URL draft, project hydrate and run hydrate all change only `comparisonDraft`; no test may set or assert a mutable `inputs`, `asinDraft`, or `activeAsins` state. Verify clear produces `slots: []`; 0–2 shows “至少填写 3 个 ASIN 后可保存或开始分析”; invalid/duplicate disables save/run; and an eleven-item add/paste/replace is wholly rejected: slots, normalized ASINs and revision remain from the preceding draft while the only new issue is `too-many` with `attemptedCount: 11`.

  Add an inspectable request assertion: draft save, keyword save, traffic save, checklist save, sync start, and run start each consume the same `ValidComparisonDraftSnapshot.asins`, not a tab-specific array. The test must fail if page code still calls `/v1/local-data/projects` or `/api/projects` for new comparison actions.

- [ ] **Step 2: Run RED.**

  ```powershell
  npx tsx --conditions=react-server --test tests/agent/comparison-page-state.test.tsx
  ```

- [ ] **Step 3: Implement typed client and state replacement.** `comparison-project-client.ts` exposes `beginComparisonAction(snapshot)` which creates and freezes one valid key with that action's snapshot, and `retryComparisonAction(action)` which reuses the identical key. It sends the key only as `Idempotency-Key` for project creation and rejects an Agent echo unless project id, session organization, marketplace and ordered ASINs equal the frozen snapshot. In `app/page.tsx`, retain this action object through pending/retry UI; neither the page nor any 31900 route generates a key. Use `useReducer(reduceComparisonDraft, ...)` plus `committedScope: CommittedComparisonScope | null`. Derive input values, batch text, matrix preview ASINs and button eligibility from the reducer. Replace `ensureAnalysisWorkspace`, `saveKeywordCompareProject`, `saveTrafficPromoProject`, checklist save and `runAnalysis` with one `createCommittedComparisonProject(snapshot, kind, action)` path. Keep existing runtime/sync presentation, but bind reports, progress and history to `committedScope.asins`, never current draft preview.

- [ ] **Step 4: Run GREEN.**

  ```powershell
  npx tsx --conditions=react-server --test tests/agent/comparison-page-state.test.tsx
  npx eslint app/page.tsx app/lib/comparison-project-client.ts
  Assert-NoAffectedTypeDiagnostics @('app/page.tsx','app/lib/comparison-project-client.ts','tests/agent/comparison-page-state.test.tsx')
  ```

- [ ] **Step 5: Commit Task 5.**

  ```powershell
  git diff --check -- app/lib/comparison-project-client.ts app/page.tsx tests/agent/comparison-page-state.test.tsx
  git add -- app/lib/comparison-project-client.ts app/page.tsx tests/agent/comparison-page-state.test.tsx
  git diff --cached --name-only
  git commit -m "feat(comparison): use one draft state for all ASIN actions"
  ```

### Task 6: Bind save/run operations to revision-fenced immutable scopes

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/lib/comparison-project-client.ts`
- Modify: `tests/agent/comparison-page-state.test.tsx`
- Modify: `tests/app/comparison-project-api.test.ts`

- [ ] **Step 1: Write RED race and history tests.** Simulate delayed project create while user changes slot 0. Assert the response may exist server-side for old snapshot but cannot clear/currently commit revision N+1. Simulate delayed run response while draft changes and assert it only attaches `runId` if project ID and draft revision still match. Cover: clean loaded project starts a new run under same project; dirty draft creates a fresh project first; a same-ASIN existing project is merely offered as an explicit navigation option; all failure paths retain current draft and show a retryable error.

- [ ] **Step 2: Run RED.**

  ```powershell
  npx tsx --conditions=react-server --test --test-name-pattern="revision fence|dirty draft|clean project|run scope" tests/agent/comparison-page-state.test.tsx tests/app/comparison-project-api.test.ts
  ```

- [ ] **Step 3: Implement action ownership rules.** At action start, retain one `snapshot`, `actionId`, `draftRevision`, and idempotency key. On project success, verify echo then set `committedScope` only if the reducer revision still equals `draftRevision`; otherwise retain the newer draft and show “已保存提交时的组合，当前输入还有未保存修改”. On run success, write `runId` only for its committed project and unchanged action revision. Loading a historical project/run first sets immutable scope, then hydrates a clean draft copied from its ASINs; first user edit marks `dirty: true` and displays “将另存为新组合”. Never PATCH scope and never set current scope from a stale response.

- [ ] **Step 4: Run GREEN and regressions.**

  ```powershell
  npx tsx --conditions=react-server --test tests/agent/comparison-page-state.test.tsx tests/app/comparison-project-api.test.ts
  Assert-NoAffectedTypeDiagnostics @('app/page.tsx','app/lib/comparison-project-client.ts','tests/agent/comparison-page-state.test.tsx','tests/app/comparison-project-api.test.ts')
  ```

- [ ] **Step 5: Commit Task 6.**

  ```powershell
  git diff --check -- app/page.tsx app/lib/comparison-project-client.ts tests/agent/comparison-page-state.test.tsx tests/app/comparison-project-api.test.ts
  git add -- app/page.tsx app/lib/comparison-project-client.ts tests/agent/comparison-page-state.test.tsx tests/app/comparison-project-api.test.ts
  git diff --cached --name-only
  git commit -m "fix(comparison): fence project and run responses by draft revision"
  ```

### Task 7: Implement hydrate precedence, URL separation and owner-gated project library UI

**Files:**
- Create: `app/comparison-project-library-panel.tsx`
- Modify: `app/page.tsx`
- Modify: `app/lib/comparison-project-client.ts`
- Modify: `tests/agent/comparison-page-state.test.tsx`

- [ ] **Step 1: Write RED hydrate/library tests.** Cover exact precedence `project/run > draftAsins > legacy asins > empty`; preserve 0–2 `draftAsins`; retain invalid/duplicate legacy values as diagnostics without triggering run; and reject an old project hydration response after navigation token or draft revision changes. Test library UI exposes legacy records as read-only with only “导入为新组合”, deletes only favorite ref, and labels dirty/history states separately.

  Required visible text assertions:

  ```ts
  assert.match(renderedText, /正在编辑的新组合/);
  assert.match(renderedText, /当前打开的历史运行/);
  assert.match(renderedText, /将另存为新组合/);
  assert.match(renderedText, /删除收藏不会删除项目、运行或报告/);
  ```

- [ ] **Step 2: Run RED.**

  ```powershell
  npx tsx --conditions=react-server --test --test-name-pattern="hydrate precedence|legacy library|navigation token" tests/agent/comparison-page-state.test.tsx
  ```

- [ ] **Step 3: Implement URL and UI semantics.** Parse `project`, `run`, `draftAsins`, and legacy `asins` separately. Encode only temporary uncommitted values in `draftAsins`; remove legacy `asins` after migration-style replacement. Each navigation increments a token; project/run fetches apply only when token matches current navigation. Replace comparison-family usage of `ProjectLibraryPanel` with `ComparisonProjectLibraryPanel`; retain the old panel/API for unrelated legacy features without routing comparison saves through it. UI must make matrix preview’s draft state distinct from sync/report/run data linked to committed scope.

- [ ] **Step 4: Run GREEN.**

  ```powershell
  npx tsx --conditions=react-server --test tests/agent/comparison-page-state.test.tsx
  npx eslint app/comparison-project-library-panel.tsx app/page.tsx app/lib/comparison-project-client.ts
  Assert-NoAffectedTypeDiagnostics @('app/comparison-project-library-panel.tsx','app/page.tsx','app/lib/comparison-project-client.ts','tests/agent/comparison-page-state.test.tsx')
  ```

- [ ] **Step 5: Commit Task 7.**

  ```powershell
  git diff --check -- app/comparison-project-library-panel.tsx app/page.tsx app/lib/comparison-project-client.ts tests/agent/comparison-page-state.test.tsx
  git add -- app/comparison-project-library-panel.tsx app/page.tsx app/lib/comparison-project-client.ts tests/agent/comparison-page-state.test.tsx
  git diff --cached --name-only
  git commit -m "feat(comparison): separate draft URLs from committed history"
  ```

### Task 8: Execute acceptance matrix and document reversible rollout

**Files:**
- Create: `app/lib/comparison-draft-policy.ts`
- Create: `app/api/comparison-projects/config/route.ts`
- Modify: `app/page.tsx`
- Modify: `tests/web/comparison-draft.test.ts`
- Modify: `tests/agent/comparison-project-contract.test.ts`
- Modify: `tests/app/comparison-project-api.test.ts`
- Modify: `tests/agent/comparison-page-state.test.tsx`
- Create: `docs/superpowers/reports/2026-08-31-comparison-draft-asin-management-report.md`

- [ ] **Step 1: Add final RED acceptance and rollback cases before closing gaps.** The four suites together must explicitly name all 14.3 Draft assertions: 0–10 reducer behavior; all-or-nothing eleven; snapshot validity; default save-as-new; historical immutability; stale response fencing; URL formats/0–2; PATCH scope 409/metadata compatibility; Agent DB authority/favorite reference limitation; project header replay/conflict/tenant isolation; legacy owner gates; inputs/active mismatch prevention; and run uses frozen project scope. Add exact default-off/explicit-on tests for `COMPARISON_DRAFT_UI_ENABLED`, and prove UI-off renders the legacy editor while project creation remains immutable/idempotent and existing `comparisonDraft`, committed project, run and report data are neither deleted nor rewritten. The config response is strict `{ comparisonDraftUiEnabled: boolean }` and contains no session, organization, project, ASIN or environment details.

- [ ] **Step 2: Run RED for every newly added assertion.**

  ```powershell
  npx tsx --conditions=react-server --test tests/web/comparison-draft.test.ts tests/agent/comparison-project-contract.test.ts tests/app/comparison-project-api.test.ts tests/agent/comparison-page-state.test.tsx
  ```

- [ ] **Step 3: Make only the smallest fixes required, then record verification.** The report records commands, pass counts, exact commit IDs, changed files, no-live-service guarantee, and known operational limitation: legacy ownerless records remain hidden until an audited deployment migration binds them. It must not claim real-provider, Chrome, build, or live-port verification.

  Implement `loadComparisonDraftUiPolicy(env)` as an exact parser: only the string `"1"` enables the new editor; missing, empty, `"0"`, and every other value disable it. `app/api/comparison-projects/config/route.ts` calls that parser server-side. The page starts from the safe legacy editor state, accepts only the strict config response for its current navigation/session epoch, and never uses UI rollback to select a different project/run storage path.

- [ ] **Step 4: Run GREEN acceptance, lint and diff checks.**

  ```powershell
  npx tsx --conditions=react-server --test tests/web/comparison-draft.test.ts tests/agent/comparison-project-contract.test.ts tests/app/comparison-project-api.test.ts tests/agent/comparison-page-state.test.tsx
  npx eslint app/lib/comparison-draft.ts app/lib/comparison-draft-policy.ts app/lib/comparison-project-client.ts app/lib/comparison-project-server.ts app/comparison-project-library-panel.tsx app/api/comparison-projects/config/route.ts app/page.tsx server/routes/analysis-runs.ts server/services/analysis-run-service.ts shared/agent-contracts.ts
  Assert-NoAffectedTypeDiagnostics @('app/lib/comparison-draft.ts','app/lib/comparison-draft-policy.ts','app/lib/comparison-project-client.ts','app/lib/comparison-project-server.ts','app/comparison-project-library-panel.tsx','app/api/comparison-projects/config/route.ts','app/page.tsx','server/routes/analysis-runs.ts','server/services/analysis-run-service.ts','shared/agent-contracts.ts','tests/web/comparison-draft.test.ts','tests/agent/comparison-project-contract.test.ts','tests/app/comparison-project-api.test.ts','tests/agent/comparison-page-state.test.tsx')
  git diff --check -- app/lib/comparison-draft-policy.ts app/api/comparison-projects/config/route.ts app/page.tsx tests/web/comparison-draft.test.ts tests/agent/comparison-project-contract.test.ts tests/app/comparison-project-api.test.ts tests/agent/comparison-page-state.test.tsx docs/superpowers/reports/2026-08-31-comparison-draft-asin-management-report.md
  ```

  Expected: all named suites PASS; no unscoped service, provider, browser, build or migration-container invocation.

- [ ] **Step 5: Commit Task 8.**

  ```powershell
  git diff --check -- app/lib/comparison-draft-policy.ts app/api/comparison-projects/config/route.ts app/page.tsx tests/web/comparison-draft.test.ts tests/agent/comparison-project-contract.test.ts tests/app/comparison-project-api.test.ts tests/agent/comparison-page-state.test.tsx docs/superpowers/reports/2026-08-31-comparison-draft-asin-management-report.md
  git add -- app/lib/comparison-draft-policy.ts app/api/comparison-projects/config/route.ts app/page.tsx tests/web/comparison-draft.test.ts tests/agent/comparison-project-contract.test.ts tests/app/comparison-project-api.test.ts tests/agent/comparison-page-state.test.tsx docs/superpowers/reports/2026-08-31-comparison-draft-asin-management-report.md
  git diff --cached --name-only
  git commit -m "test(comparison): cover immutable draft management"
  ```

## Rollback and Acceptance

- Feature-gate only the comparison reducer UI with `COMPARISON_DRAFT_UI_ENABLED` (default off; exact enabled value `1`). If disabled, restore the previous comparison input component for editing but retain immutable Agent project creation, project/run records, idempotency rows and favorite references; never merge or delete created projects/runs. The same-origin config route is the only client flag source and returns no tenant data.
- To roll back favorite presentation, stop rendering `ComparisonProjectLibraryPanel`; do not delete `data/project-favorites`, Agent projects, owner bindings, historical file records, snapshots or reports.
- A deployment migration failure aborts before traffic; it must not partially add one of the paired project/idempotency records. Existing projects remain readable with their historical ASIN ordering.
- User acceptance is complete when: 0–10 add/remove/replace/clear works; eleven-item paste rejects as one action; valid 3–10 save/run use the displayed ordered ASINs; edited history creates a distinct project; old project/run/report remains visible; cross-org and unowned legacy records are hidden; metadata rename works; ASIN/marketplace mutation is rejected; network replay produces one project; and deleting a favorite leaves the project/run untouched.

## Self-review

- All requested semantics are covered: `comparisonDraft` 0–10; add/remove/replace/clear; eleven-item action wholly rejected while prior draft values/revision remain; 3–10 action-time validation; no `inputs`/`activeAsins` mismatch; Agent DB authority; default save-as-new; immutable projects/runs; client-owned project header idempotency/replay/409; owner-gated read-only legacy import; cross-organization 404; visible Chinese copy; acceptance; and non-destructive rollback.
- Every task has its own RED/GREEN command plus the changed-path TypeScript gate; the known 306-diagnostic full-tree baseline is not mislabeled as green. Task 2 is repository/migration complete without a route and only asserts Plan 01's inherited cutoff rejection, while Task 3 owns all 31901 route-header 400 assertions, the side-effect-free legacy file reader, and the reachable authenticated legacy read/bind endpoint/CLI.
- Task 8 owns the declared default-off `COMPARISON_DRAFT_UI_ENABLED` policy, strict same-origin config route, independent UI-only rollback test and acceptance report; rollback never changes immutable project/run persistence.
- Shared ownership/order is explicit: Plan 01 contributes migrations 0019/0020 and its `agent-contracts/page` behavior; this plan contributes both 0021 files and preserves that behavior; Plan 03 starts after this plan, contributes 0022, and preserves `comparisonDraft/committedScope`. External preflight `771cbaa` remains outside this plan.
- The plan intentionally leaves Manual Alexa VOC, shared stage-output schemas, SIF evidence/fallback, provider calls, static publication and live-service orchestration outside this independently reversible slice.
- Self-check before commit must return zero matches and zero whitespace errors:

  ```powershell
  rg -n "[T]BD|[T]ODO|[F]IXME|[l]ater|[s]imilar to|待[定]|后续[补]|占[位]" docs/superpowers/plans/2026-08-31-comparison-draft-asin-management.md
  git diff --check -- docs/superpowers/plans/2026-08-31-comparison-draft-asin-management.md
  ```
