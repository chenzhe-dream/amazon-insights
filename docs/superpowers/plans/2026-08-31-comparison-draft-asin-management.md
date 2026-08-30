# Comparison Draft ASIN Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用唯一的 `comparisonDraft` 管理 0–10 个可编辑 ASIN；只在保存或运行时冻结并校验 3–10 个合法、唯一 ASIN。所有新组合创建为 Agent PostgreSQL 中不可变项目，历史项目/运行不被修改或删除。

**Architecture:** 浏览器 reducer 持有短生命周期草稿，`CommittedComparisonScope` 单独持有已验证的 Agent project/run 快照。Web 同源 API 从 session principal 代理到 31901；31901 从 principal 推导 organization，事务内写入项目与 project-create 幂等记录。文件系统只保留按 organization 分区的收藏引用和只读 legacy 适配，不再是新项目 ASIN scope 的权威源。

**Tech Stack:** TypeScript, React/Vinext, Zod, Fastify, PostgreSQL/SQLite repositories, Node `tsx --test`, React test renderer/harness, ESLint.

## Global Constraints

- 基线是规格提交 `882487a` 和 `docs/superpowers/specs/2026-08-31-realtime-voc-asin-draft-keyword-fallback-design.md` 的第 8、10.3、13.2、14.3 节；仅实施切片二，不修改 Manual Alexa VOC 发布、`ProjectableSyncStageSchema`、SIF adapter/evidence/预算或 provider。
- `comparisonDraft` 是唯一编辑真相。不得以 effect、localStorage 迁移或镜像 state 重新引入 `inputs`、`asinDraft`、`activeAsins` 三个可变业务真相；可以保留只读派生变量作为展示兼容层。
- 草稿允许 0–10 个 raw slots；少于 3 是可编辑状态而不是输入错误。`>10` 的 add/paste/replace action 整体拒绝、保留上一草稿、显示 `too-many`，不得截断、部分写入或静默丢 ASIN。
- 新项目权威源只能是 Agent DB `projects`；项目 marketplace 与 ordered ASIN 永远不可 PATCH。所有创建、列表、读取、运行均从认证 principal 推导 organization，跨组织一律按 404 处理，不能根据 request/query/body 选择组织。
- 保存和运行均先调用 `snapshotValidComparisonDraft()`，读取一次 revision 并返回冻结 `{ marketplace, asins, draftRevision }`。任何异步成功仅可更新同 revision；旧请求可以产生其旧 snapshot 的项目/运行，但绝不可把更新后的 draft 标记为 clean。
- 默认“另存为新组合”：dirty draft 的保存或运行总是新建 project；clean 已加载 project 可在该 project 下新建 run；同 ASIN 组合只显示可点击的“打开已有组合”，永不自动复用。项目、run、snapshot、报告不会被此切片更新或删除。
- `Idempotency-Key` 只接受 16–128 位 ASCII `[A-Za-z0-9._:-]`；缺失/非法 400，同 organization + key + canonical payload 回放原 project，payload 不同 409 `IDEMPOTENCY_KEY_REUSED`，不同 organization 可使用相同 key。
- 文件收藏只保存 `{ organizationId, agentProjectId, kind, slug, labels }`，删除收藏只删除此引用。legacy 文件项目仅在 owner gate 成功时只读展示；无 owner 只能由部署迁移一次绑定到有效 `LEGACY_PROJECT_DEFAULT_ORGANIZATION_ID`，不得由访问者自动认领。
- 实现和测试不得启动、停止、重启或访问 31900/31901/58258，不运行真实 build、provider、connector 或 Chrome；测试使用依赖注入、内存/临时目录和 Fastify inject。每任务只 stage 该任务列出的文件，不使用 `git add .`、reset、checkout、clean、stash、rebase、amend 或 push。

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `app/lib/comparison-draft.ts` | Client-safe types, reducer, normalize/validation and immutable action snapshot. No I/O or React imports. |
| `app/lib/comparison-project-client.ts` | Typed same-origin fetch client; attaches an action-local idempotency key and verifies echoed project scope before callers accept it. |
| `app/comparison-project-library-panel.tsx` | Favorite/legacy read-only library UI and explicit “导入为新组合” action; cannot edit ASIN scope. |
| `app/page.tsx` | Replaces parallel ASIN states/actions, URL hydrate fencing, committed scope binding, save/run UI, and clear state copy. |
| `app/api/comparison-projects/route.ts` | Session-authenticated list/create proxy to 31901 and favorite creation only after Agent project verification. |
| `app/api/comparison-projects/[projectId]/route.ts` | Principal-scoped Agent project GET and metadata-only PATCH proxy. |
| `app/api/comparison-favorites/[projectId]/route.ts` | Delete only the current organization’s favorite reference. |
| `app/lib/comparison-project-server.ts` | Server-only composition of session, Agent client, favorite store, legacy gate and response schemas. |
| `scripts/lib/project-favorite-store.mjs` | Organization-partitioned favorite reference I/O; no ASIN, marketplace, run, report or mutable project fields. |
| `server/db/migrations/0011_comparison_project_scope.sql` | SQLite project-create idempotency and legacy owner-binding tables/indexes. |
| `server/db/migrations/postgres/0019_comparison_project_scope.sql` | PostgreSQL equivalent of the SQLite migration. |
| `server/db/repository.ts`, `server/db/sqlite-repository.ts`, `server/db/postgres-repository.ts` | Transactional project idempotency, principal-scoped list/read, metadata patch, and legacy binding repository contracts. |
| `server/services/analysis-run-service.ts` | Immutable create/list/read/metadata patch semantics and project/run snapshot verification. |
| `server/routes/analysis-runs.ts`, `shared/agent-contracts.ts` | Header/body/response contracts for project list/create/read/PATCH and strict run creation. |
| `tests/web/comparison-draft.test.ts` | Reducer and snapshot unit tests. |
| `tests/agent/comparison-project-contract.test.ts` | Fastify/service/repository contract tests using injected clock/id/temporary SQLite. |
| `tests/app/comparison-project-api.test.ts` | Same-origin proxy, favorite and legacy owner-gate tests with injected Agent/favorite adapters. |
| `tests/agent/comparison-page-state.test.tsx` | Page reducer/hydrate/action-race harness; no real browser or server ports. |

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

### Task 1: Establish the pure draft reducer and immutable action snapshot

**Files:**
- Create: `app/lib/comparison-draft.ts`
- Create: `tests/web/comparison-draft.test.ts`

- [ ] **Step 1: Write RED reducer tests.** Cover exact raw-slot behavior: empty draft; add until ten; remove the only slot; input-slot replace; batch replace; clear; trim/uppercase normalization; invalid/duplicate diagnostics; 0–2 legal edit state; and all-or-nothing 11-item add/paste/replace. Include a freeze assertion and snapshot failures for invalid, duplicate, `<3`, and `>10`.

  ```ts
  const before = makeDraft(["B0AAAA0001", "B0BBBB0002"]);
  const after = reduceComparisonDraft(before, { type: "replace-all", slots: elevenAsins });
  assert.equal(after, before);
  assert.deepEqual(after.issues, [{ code: "too-many", attemptedCount: 11 }]);
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
- Create: `server/db/migrations/0011_comparison_project_scope.sql`
- Create: `server/db/migrations/postgres/0019_comparison_project_scope.sql`
- Create: `tests/agent/comparison-project-contract.test.ts`

- [ ] **Step 1: Write RED repository/contract tests.** With an injected temporary SQLite repository and deterministic IDs/clocks, prove that project create: rejects absent/malformed header keys with 400 at the route; persists same-org same-key/same-hash replay after repository re-open; returns `409 IDEMPOTENCY_KEY_REUSED` for different name, marketplace, order, or ASIN list; and allows the same key in a different organization. Add migration-up tests from the pre-0011 SQLite and pre-0019 PostgreSQL migration heads.

  ```ts
  const first = await app.inject({ method: "POST", url: "/v1/projects", headers: authAnd({ "idempotency-key": key }), payload });
  const replay = await app.inject({ method: "POST", url: "/v1/projects", headers: authAnd({ "idempotency-key": key }), payload });
  assert.equal(first.statusCode, 201);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().project.id, first.json().project.id);
  ```

- [ ] **Step 2: Run RED.**

  ```powershell
  npx tsx --conditions=react-server --test tests/agent/comparison-project-contract.test.ts
  ```

  Expected: absent list/PATCH/idempotency interfaces or replay assertions fail under the pre-change implementation.

- [ ] **Step 3: Define strict schema and storage interfaces.** Add `IdempotencyKeySchema`, `ListProjectsResponseSchema`, `UpdateProjectMetadataRequestSchema`, header parser type, `ProjectCreationIdempotencyRecord`, `findProjectCreationIdempotency`, `createProjectOnce`, `listProjectsForOrganization`, and `updateProjectMetadata`. Do not add ASIN or marketplace to the metadata patch schema. Remove externally supplied `dataCutoffAt` from `CreateRunRequestSchema`; keep `idempotencyKey` strict and have all cutoff decisions remain server-side.

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

  Use UUID/foreign-key column types and existing timestamp conventions in PostgreSQL. `createProjectOnce` must canonicalize the already Zod-normalized payload, insert `projects` and idempotency row in one transaction, resolve a uniqueness race by rereading the same organization/key, and never return another organization’s record. `updateProjectMetadata` updates only `name`/`updated_at`; a direct ASIN or marketplace patch receives `409 IMMUTABLE_SCOPE` before any write.

- [ ] **Step 5: Run GREEN and migration checks.**

  ```powershell
  npx tsx --conditions=react-server --test tests/agent/comparison-project-contract.test.ts
  npm run test:agent
  ```

  Expected: SQLite migration/reopen replay, PostgreSQL migration fixture, immutable PATCH and tenant isolation all PASS. Do not execute a real PostgreSQL container or service.

- [ ] **Step 6: Commit Task 2.**

  ```powershell
  git diff --check -- shared/agent-contracts.ts server/db/repository.ts server/db/sqlite-repository.ts server/db/postgres-repository.ts server/db/migrations/0011_comparison_project_scope.sql server/db/migrations/postgres/0019_comparison_project_scope.sql tests/agent/comparison-project-contract.test.ts
  git add -- shared/agent-contracts.ts server/db/repository.ts server/db/sqlite-repository.ts server/db/postgres-repository.ts server/db/migrations/0011_comparison_project_scope.sql server/db/migrations/postgres/0019_comparison_project_scope.sql tests/agent/comparison-project-contract.test.ts
  git diff --cached --name-only
  git commit -m "feat(projects): make comparison scopes immutable and idempotent"
  ```

### Task 3: Enforce principal-scoped Agent routes and run-scope boundaries

**Files:**
- Modify: `server/routes/analysis-runs.ts`
- Modify: `server/services/analysis-run-service.ts`
- Modify: `shared/agent-contracts.ts`
- Modify: `tests/agent/comparison-project-contract.test.ts`

- [ ] **Step 1: Extend RED API tests.** Assert `GET /v1/projects` lists only the principal organization; `GET /v1/projects/:id` and `PATCH /v1/projects/:id` return 404 cross organization; `POST /v1/projects` ignores a malicious `organizationId` body field because strict schema rejects it; and project response echoes exact `id`, `organizationId`, `marketplace`, ordered `asins`. Assert `PATCH` metadata succeeds while body attempts to include `asins` or `marketplace` returns 400 (strict schema), and a repository-level immutable-scope attempt is 409. Add a run test: body containing `dataCutoffAt` is 400, run creation validates ownership and replays only the same immutable project/mode/idempotency scope.

- [ ] **Step 2: Run RED.**

  ```powershell
  npx tsx --conditions=react-server --test --test-name-pattern="principal-scoped project|immutable project patch|run cutoff" tests/agent/comparison-project-contract.test.ts
  ```

- [ ] **Step 3: Implement routes and service methods.** `registerAnalysisRunRoutes` parses `request.headers["idempotency-key"]` before calling `createProject`, adds authenticated `GET /v1/projects` and `PATCH /v1/projects/:projectId`, and maps key reuse to typed `409 IDEMPOTENCY_KEY_REUSED`. `AnalysisRunService` derives organization only from `executionContext`; list/read/update return 404 on organization mismatch. `createRun` uses the stored project ASIN order and server clock/cutoff path from the completed Manual VOC slice; it does not accept browser cutoff or a changing page array.

- [ ] **Step 4: Run GREEN.**

  ```powershell
  npx tsx --conditions=react-server --test tests/agent/comparison-project-contract.test.ts
  npm run test:agent
  ```

- [ ] **Step 5: Commit Task 3.**

  ```powershell
  git diff --check -- server/routes/analysis-runs.ts server/services/analysis-run-service.ts shared/agent-contracts.ts tests/agent/comparison-project-contract.test.ts
  git add -- server/routes/analysis-runs.ts server/services/analysis-run-service.ts shared/agent-contracts.ts tests/agent/comparison-project-contract.test.ts
  git diff --cached --name-only
  git commit -m "feat(projects): scope immutable projects to the principal"
  ```

### Task 4: Create a favorite-only file layer and owner-gated legacy adapter

**Files:**
- Create: `scripts/lib/project-favorite-store.mjs`
- Create: `app/lib/comparison-project-server.ts`
- Modify: `scripts/lib/project-store.mjs`
- Create: `app/api/comparison-projects/route.ts`
- Create: `app/api/comparison-projects/[projectId]/route.ts`
- Create: `app/api/comparison-favorites/[projectId]/route.ts`
- Create: `tests/app/comparison-project-api.test.ts`

- [ ] **Step 1: Write RED server adapter tests.** Inject a fake authenticated Agent client and a temporary directory. Prove that create first receives/verifies `{ id, organizationId, marketplace, asins }` from Agent, then writes exactly one favorite reference with no `asins`, `marketplace`, `runId`, or report data. Simulate favorite write failure and assert Agent project remains untouched and the response tells UI to retry favorite. Prove only own organization can list/delete refs.

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

  Store references beneath `data/project-favorites/<organizationId>/<agentProjectId>.json` with traversal-safe IDs and atomic write/rename. Keep `scripts/lib/project-store.mjs` read-only for legacy lookup from this new flow: do not call its create/update/delete methods. `comparison-project-server.ts` reads session principal, calls only 31901 Agent project APIs, validates every echoed field before committing favorite state, and resolves legacy ownership through explicit file owner or repository `legacy_project_owner_bindings`. The one-time binder is deployment-only, requires a configured default organization that has an active user, and is not an HTTP endpoint.

- [ ] **Step 4: Implement same-origin routes.** `POST /api/comparison-projects` accepts `{ name, marketplace, asins, kind, labels }`, generates/forwards a new action-local `Idempotency-Key`, proxies Agent response, validates it, then attempts favorite creation. `GET` lists Agent projects plus only own favorite/eligible legacy metadata. `GET/PATCH /api/comparison-projects/:projectId` proxy principal-scoped Agent read/metadata patch; `DELETE /api/comparison-favorites/:projectId` removes only the current org’s reference. No comparison route calls `/v1/local-data/projects` or accepts an organization id.

- [ ] **Step 5: Run GREEN and route lint.**

  ```powershell
  npx tsx --conditions=react-server --test tests/app/comparison-project-api.test.ts
  npx eslint app/lib/comparison-project-server.ts app/api/comparison-projects/route.ts app/api/comparison-projects/[projectId]/route.ts app/api/comparison-favorites/[projectId]/route.ts
  ```

- [ ] **Step 6: Commit Task 4.**

  ```powershell
  git diff --check -- scripts/lib/project-favorite-store.mjs scripts/lib/project-store.mjs app/lib/comparison-project-server.ts app/api/comparison-projects/route.ts app/api/comparison-projects/[projectId]/route.ts app/api/comparison-favorites/[projectId]/route.ts tests/app/comparison-project-api.test.ts
  git add -- scripts/lib/project-favorite-store.mjs scripts/lib/project-store.mjs app/lib/comparison-project-server.ts app/api/comparison-projects/route.ts app/api/comparison-projects/[projectId]/route.ts app/api/comparison-favorites/[projectId]/route.ts tests/app/comparison-project-api.test.ts
  git diff --cached --name-only
  git commit -m "feat(projects): gate legacy favorites by organization"
  ```

### Task 5: Add typed client verification and replace page ASIN ownership state

**Files:**
- Create: `app/lib/comparison-project-client.ts`
- Modify: `app/page.tsx`
- Create: `tests/agent/comparison-page-state.test.tsx`

- [ ] **Step 1: Write RED page-state tests.** Factor the page’s ASIN state transitions behind exported test-only pure bindings or a dedicated hook harness. Test that editing an input, textarea paste, clear, URL draft, project hydrate and run hydrate all change only `comparisonDraft`; no test may set or assert a mutable `inputs`, `asinDraft`, or `activeAsins` state. Verify clear produces `slots: []`; 0–2 shows “至少填写 3 个 ASIN 后可保存或开始分析”; invalid/duplicate disables save/run; `>10` retains previous slots and tells user all pasted entries were rejected.

  Add an inspectable request assertion: draft save, keyword save, traffic save, checklist save, sync start, and run start each consume the same `ValidComparisonDraftSnapshot.asins`, not a tab-specific array. The test must fail if page code still calls `/v1/local-data/projects` or `/api/projects` for new comparison actions.

- [ ] **Step 2: Run RED.**

  ```powershell
  npx tsx --conditions=react-server --test tests/agent/comparison-page-state.test.tsx
  ```

- [ ] **Step 3: Implement typed client and state replacement.** `comparison-project-client.ts` creates one random valid key per create/run action, sends it as `Idempotency-Key` for project creation, and rejects an Agent echo unless project id, session organization, marketplace and ordered ASINs equal the frozen snapshot. In `app/page.tsx`, use `useReducer(reduceComparisonDraft, ...)` plus `committedScope: CommittedComparisonScope | null`. Derive input values, batch text, matrix preview ASINs and button eligibility from the reducer. Replace `ensureAnalysisWorkspace`, `saveKeywordCompareProject`, `saveTrafficPromoProject`, checklist save and `runAnalysis` with one `createCommittedComparisonProject(snapshot, kind)` path. Keep existing runtime/sync presentation, but bind reports, progress and history to `committedScope.asins`, never current draft preview.

- [ ] **Step 4: Run GREEN.**

  ```powershell
  npx tsx --conditions=react-server --test tests/agent/comparison-page-state.test.tsx
  npx eslint app/page.tsx app/lib/comparison-project-client.ts
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
  npm run test:agent
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
- Modify: `tests/web/comparison-draft.test.ts`
- Modify: `tests/agent/comparison-project-contract.test.ts`
- Modify: `tests/app/comparison-project-api.test.ts`
- Modify: `tests/agent/comparison-page-state.test.tsx`
- Create: `docs/superpowers/reports/2026-08-31-comparison-draft-asin-management-report.md`

- [ ] **Step 1: Add final RED acceptance cases before closing gaps.** The four suites together must explicitly name all 14.3 Draft assertions: 0–10 reducer behavior; all-or-nothing eleven; snapshot validity; default save-as-new; historical immutability; stale response fencing; URL formats/0–2; PATCH scope 409/metadata compatibility; Agent DB authority/favorite reference limitation; project header replay/conflict/tenant isolation; legacy owner gates; inputs/active mismatch prevention; and run uses frozen project scope.

- [ ] **Step 2: Run RED for every newly added assertion.**

  ```powershell
  npx tsx --conditions=react-server --test tests/web/comparison-draft.test.ts tests/agent/comparison-project-contract.test.ts tests/app/comparison-project-api.test.ts tests/agent/comparison-page-state.test.tsx
  ```

- [ ] **Step 3: Make only the smallest fixes required, then record verification.** The report records commands, pass counts, exact commit IDs, changed files, no-live-service guarantee, and known operational limitation: legacy ownerless records remain hidden until an audited deployment migration binds them. It must not claim real-provider, Chrome, build, or live-port verification.

- [ ] **Step 4: Run GREEN acceptance, lint and diff checks.**

  ```powershell
  npx tsx --conditions=react-server --test tests/web/comparison-draft.test.ts tests/agent/comparison-project-contract.test.ts tests/app/comparison-project-api.test.ts tests/agent/comparison-page-state.test.tsx
  npm run test:agent
  npx eslint app/lib/comparison-draft.ts app/lib/comparison-project-client.ts app/lib/comparison-project-server.ts app/comparison-project-library-panel.tsx app/page.tsx server/routes/analysis-runs.ts server/services/analysis-run-service.ts shared/agent-contracts.ts
  git diff --check
  ```

  Expected: all named suites PASS; no unscoped service, provider, browser, build or migration-container invocation.

- [ ] **Step 5: Commit Task 8.**

  ```powershell
  git diff --check -- tests/web/comparison-draft.test.ts tests/agent/comparison-project-contract.test.ts tests/app/comparison-project-api.test.ts tests/agent/comparison-page-state.test.tsx docs/superpowers/reports/2026-08-31-comparison-draft-asin-management-report.md
  git add -- tests/web/comparison-draft.test.ts tests/agent/comparison-project-contract.test.ts tests/app/comparison-project-api.test.ts tests/agent/comparison-page-state.test.tsx docs/superpowers/reports/2026-08-31-comparison-draft-asin-management-report.md
  git diff --cached --name-only
  git commit -m "test(comparison): cover immutable draft management"
  ```

## Rollback and Acceptance

- Feature-gate only the comparison reducer UI. If disabled, restore the previous comparison input component for editing but retain immutable Agent project creation, project/run records, idempotency rows and favorite references; never merge or delete created projects/runs.
- To roll back favorite presentation, stop rendering `ComparisonProjectLibraryPanel`; do not delete `data/project-favorites`, Agent projects, owner bindings, historical file records, snapshots or reports.
- A deployment migration failure aborts before traffic; it must not partially add one of the paired project/idempotency records. Existing projects remain readable with their historical ASIN ordering.
- User acceptance is complete when: 0–10 add/remove/replace/clear works; eleven-item paste rejects as one action; valid 3–10 save/run use the displayed ordered ASINs; edited history creates a distinct project; old project/run/report remains visible; cross-org and unowned legacy records are hidden; metadata rename works; ASIN/marketplace mutation is rejected; network replay produces one project; and deleting a favorite leaves the project/run untouched.

## Self-review

- All requested semantics are covered: `comparisonDraft` 0–10; add/remove/replace/clear; eleven-item no-partial rejection; 3–10 action-time validation; no `inputs`/`activeAsins` mismatch; Agent DB authority; default save-as-new; immutable projects/runs; project header idempotency/replay/409; owner-gated read-only legacy import; cross-organization 404; visible Chinese copy; acceptance; and non-destructive rollback.
- The plan intentionally leaves Manual Alexa VOC, shared stage-output schemas, SIF evidence/fallback, provider calls, static publication and live-service orchestration outside this independently reversible slice.
- File paths, endpoint paths, request/response types, migration numbers, RED/GREEN commands, expected RED behavior, expected GREEN behavior, and one narrow commit per task are explicit; no deferred runtime contract is required.
