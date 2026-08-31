# Realtime Manual Alexa VOC Task 8 Brief

## 固定执行上下文

- Worktree: `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\stabilize-resumable-sync-pipeline`
- Baseline / HEAD: `e8272b4c21bda58c5e9ef68529b4c3cf4b3c00fe`
- Branch: `codex/stabilize-resumable-sync-pipeline`
- Repository `AGENTS.md`: none found.
- Existing user WIP recorded before Task 8 and excluded from staging/commit.

## Implementation plan 原文：Task 8

Source: `docs/superpowers/plans/2026-08-31-realtime-manual-alexa-voc.md`, lines 688–760.

> ### Task 8: Make run creation, cutoff, snapshot, and replay one transaction
>
> **Files:**
> - Modify: `shared/agent-contracts.ts:942-952,1470-1480`
> - Modify: `server/db/manual-alexa-voc-repository.ts`
> - Modify: `server/db/sqlite-repository.ts`
> - Modify: `server/db/postgres/manual-alexa-voc-store.ts`
> - Modify: `server/services/analysis-run-service.ts:58-230`
> - Modify: `server/services/voc-data-snapshot-service.ts:35-180`
> - Modify: `server/routes/analysis-runs.ts`
> - Modify: `tests/agent/analysis-run-lifecycle.test.ts`
> - Modify: `tests/agent/contracts.test.ts`
> - Create: `tests/agent/manual-alexa-voc-run-atomicity.test.ts`
>
> **Interfaces:**
> - Consumes: Task 7's async organization-scoped `RepositoryVocSourceReader.read`, `createRunWithVocSnapshot` exact signature, repository transaction/locks/clock, and existing project/run/stage/job/snapshot methods.
> - Produces: persistent `(organizationId,idempotencyKey)` replay with original run/snapshot/stages/jobs/cutoff and linearized import/run visibility.
>
> Change `AnalysisRunServiceOptions.repository` from bare `AgentRepository` to `AgentRepository & ManualAlexaVocRepositoryCapability`; production `RuntimeAgentRepository` already satisfies it after Task 5, while unrelated repository consumers keep the narrower base interface.
>
> - [ ] **Step 1: Add RED tests for strict cutoff ownership and persistent replay**
>
> ```ts
> const first = await service.createRunWithVocSnapshot({ principal, projectId, mode: "existing-data", idempotencyKey: "run-1" });
> const replay = await service.createRunWithVocSnapshot({ principal, projectId, mode: "existing-data", idempotencyKey: "run-1" });
> assert.deepEqual(replay, first);
> assert.equal(databaseClockSpy.calls, 1);
> await assert.rejects(() => service.createRunWithVocSnapshot({ principal, projectId: otherProjectId, mode: "existing-data", idempotencyKey: "run-1" }), /IDEMPOTENCY_KEY_REUSED/);
> assert.equal(CreateRunRequestSchema.safeParse({ mode: "existing-data", idempotencyKey: "run-1", dataCutoffAt: "2026-08-31T00:00:00.000Z" }).success, false);
> ```
>
> Add two barrier-controlled PostgreSQL tests: import commits before run scope locks release and appears in the snapshot; run fixes cutoff before import commits and excludes it until the next run. Assert old snapshots never mutate and concurrent same-key losers replay the winner.
>
> - [ ] **Step 2: Run RED**
>
> Run: `npx tsx --conditions=react-server --test tests/agent/analysis-run-lifecycle.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts`
>
> Expected: FAIL because current service takes application time/client cutoff and snapshot creation is separate.
>
> - [ ] **Step 3: Implement idempotency-before-clock transaction order**
>
> ```ts
> return this.#repository.transaction(async repository => {
>   const project = await requireOwnedImmutableProject(repository, input.principal, input.projectId);
>   const fingerprint = sha256(stableJson({ projectId: project.id, mode: input.mode, immutableProjectScopeHash: scopeHash(project) }));
>   const claim = await repository.manualAlexaVoc.claimRunCreation({ organizationId: project.organizationId, idempotencyKey: input.idempotencyKey, fingerprint });
>   if (claim.kind === "conflict") throw new IdempotencyKeyReusedError();
>   if (claim.kind === "replay") return readOriginalRunAndSnapshot(repository, claim.runId, claim.snapshotId);
>   await repository.manualAlexaVoc.lockScopes({ organizationId: project.organizationId, marketplace: "US", asins: [...project.asins].sort() });
>   const dataCutoffAt = await repository.manualAlexaVoc.readDatabaseClock();
>   const source = await this.#vocSourceReader.read({ organizationId: project.organizationId, marketplace: project.marketplace, asins: project.asins, dataCutoffAt });
>   const created = await createRunStagesSnapshotAndFirstJob(repository, { project, input, dataCutoffAt, source });
>   await repository.manualAlexaVoc.completeRunCreation({ organizationId: project.organizationId, idempotencyKey: input.idempotencyKey, fingerprint, runId: created.run.id, snapshotId: created.snapshot.id, completedAt: dataCutoffAt });
>   return Object.freeze({ run: created.run, snapshot: created.snapshot });
> });
> ```
>
> `claimRunCreation` first takes an org+key advisory lock. Fingerprint excludes cutoff/run/snapshot IDs. Same fingerprint replays without calling the clock or reader; different fingerprint throws 409. Adapt old core-store records by reconstructing fingerprint once from immutable project/mode; ambiguous reconstruction rejects rather than creates another run.
>
> - [ ] **Step 4: Make existing `createRun` route call only this method**
>
> Only after the atomic method compiles, replace the public contract with `CreateRunRequestSchema = strictObject({ mode: RunModeSchema, idempotencyKey: z.string().trim().min(1).max(200) })`, remove `input.dataCutoffAt ?? createdAt`, and retain no compatibility branch that accepts browser cutoff. Existing `createRun(projectId,input)` delegates to `createRunWithVocSnapshot`, then loads the already-committed stages to preserve the HTTP response `{run,stages}`; repository tests verify that replay points to the original snapshot and job rows.
>
> - [ ] **Step 5: Run GREEN and commit**
>
> Run: `npx tsx --conditions=react-server --test tests/agent/contracts.test.ts tests/agent/analysis-run-lifecycle.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts tests/agent/postgres-analysis-run-lifecycle-store.test.ts && npx tsc --noEmit`
>
> Expected: PASS for replay, conflict, old-record adapter, both import/run commit orders, and strict 400 client cutoff.
>
> ```bash
> git add shared/agent-contracts.ts server/db/manual-alexa-voc-repository.ts server/db/sqlite-repository.ts server/db/postgres/manual-alexa-voc-store.ts server/services/analysis-run-service.ts server/services/voc-data-snapshot-service.ts server/routes/analysis-runs.ts tests/agent/contracts.test.ts tests/agent/analysis-run-lifecycle.test.ts tests/agent/manual-alexa-voc-run-atomicity.test.ts
> git commit -m "feat: atomically snapshot manual voc runs"
> ```

## 最终设计原文：Task 8 权威约束

Source: `docs/superpowers/specs/2026-08-31-realtime-voc-asin-draft-keyword-fallback-design.md`.

> `captured_at` 必须来自 31901 在事务内取得的数据库 `clock_timestamp()`，并序列化为带 `Z` 的完整 ISO-8601；不能使用 `YYYY-MM-DD`、浏览器时间或文件 mtime。取得 head row lock 后读取一次 `clock_timestamp()`，同一个值写入 revision、head、outbox createdAt。JavaScript 合同至少保留毫秒精度，数据库保留其原生更高精度。

> `listAtCutoff` 对每个 ASIN 选择 `captured_at <= dataCutoffAt` 的最高 `(captured_at, revision)`。查询必须同时包含 organization 和 marketplace；没有任何方法允许只按 ASIN 全局查询。

> repository 的“0 rows”与“读取失败”必须是不同类型：只有租户限定 SQL **成功执行且返回 0 行**才是 `NotFoundInTenant` 并允许评估 legacy fallback；连接失败、timeout、permission、missing table/schema mismatch、JSON deserialize/schema validation 都分别映射 typed repository error，API 返回 503 或 snapshot source-error，绝不降级为 static。

> 新增服务端原子方法，取代“先在 route 取 now，再读 source，再分别写 run/snapshot”的顺序：
>
> ```ts
> createRunWithVocSnapshot(input: {
>   principal: RequestPrincipal;
>   projectId: string;
>   mode: "existing-data" | "collect-missing";
>   idempotencyKey: string;
> }): Promise<{ run: AnalysisRun; snapshot: DataSnapshot }>;
> ```

> 该方法在同一个 PostgreSQL transaction 中：锁定并校验 actor/project/organization/immutable ASIN scope；按 ASIN 排序取得与 import 相同的 advisory locks；读取一次数据库 `clock_timestamp()` 作为 run `dataCutoffAt`；按该 cutoff 选择每个 ASIN revision；创建 run、stages、snapshot 和 job。外部 `CreateRunRequest` 删除 `dataCutoffAt` 字段并使用 strict schema，客户端若提交该字段直接 400，不允许浏览器控制 cutoff。共享锁协议保证 import/run 并发线性化：先取得 scope lock 并提交的 import 必须进入新 run，run 先取得锁并确定 cutoff 后才提交的 import 只能进入下一 run。

> run 创建幂等在取得 ASIN locks/DB clock **之前**串行化。事务先对 `(organizationId, idempotencyKey)` 取得 advisory lock并读取/声明 `run_creation_idempotency` 唯一行；规范 fingerprint 只含 `{projectId, mode, immutableProjectScopeHash}`，不含服务端生成的 cutoff、时间、run id 或 snapshot id。同 key + 同 fingerprint 直接读取并回放原 run、snapshot、stages、jobs 与原 cutoff，绝不重新取 clock或重选 revision；同 key + 不同 fingerprint 返回 409 `IDEMPOTENCY_KEY_REUSED`；并发 loser 等 winner 提交后走同一 replay。新 winner 才继续 ASIN locks、clock、snapshot 创建，并在同事务把 run id 写回幂等行。

> 现有 core-store 的 `idempotencyScope + idempotencyKey` 比较继续兼容：adapter 把 scope 规范为 organization-bound run-create scope，并额外比较上述 fingerprint；旧记录缺 fingerprint 时从其不可变 project/mode 只读重建一次并持久化，无法唯一重建则 409，不创建第二个 run。

> VOC 独立分析按钮每次创建**新 run**，并调用 `createRunWithVocSnapshot`。cutoff、revision selection、run 和 snapshot 必须来自同一 DB transaction/同一 DB clock，禁止 route 先取应用服务器时间再调用 reader。事务顺序保证按钮动作前已提交的 Manual Alexa revision 进入新 run；并发边界由锁顺序和 integration test 证明。

> 运行创建时冻结：organization、marketplace、ASIN 顺序、project id、dataCutoffAt 和各数据 snapshot。之后的 Alexa revision、草稿编辑、SIF cache refresh 或 Sorftime验证只影响新运行。

> - run：`(organizationId,idempotencyKey)` + cutoff-free fingerprint 持久化；同请求完整回放原 run/snapshot/stages/cutoff，冲突 409。

> 12. import 与 `createRunWithVocSnapshot` 并发的两种提交顺序均线性化：import 先提交则 snapshot 含新 revision，run 先提交则只在下一 run 可见；cutoff 与 selected revision 来自同一 DB transaction/clock。
> 13. run 同 key+同 fingerprint 串行/并发都回放相同 run、snapshot、stages 和原 cutoff，DB clock spy 不被第二次调用；同 key+不同 fingerprint 409；旧 core-store record 可兼容重建 fingerprint。

> - run cutoff、revision selection 和 snapshot 在一个 DB transaction 完成；客户端不能指定 cutoff。

> - **时间语义：** capturedAt 为 head lock 后同一 DB clock；run cutoff、revision selection 与 snapshot 同事务，旧 run 不变，外部不能提交 cutoff。
> - **Run replay：** cutoff-free fingerprint 在 DB clock 前串行；同 key replay 原 run/snapshot/stages/cutoff，不重新选择数据。

## 执行纪律原文

Source: implementation plan global constraints and execution discipline.

> `captured_at`, run `dataCutoffAt`, revision selection, run, stages, snapshot, and first job are committed from one DB transaction and one DB clock; browsers cannot submit `dataCutoffAt`.

> Every runtime read, write, cache key, advisory lock, selector, audit row, outbox row, and projection is scoped by `organizationId + marketplace + asin`; no repository method may query Manual VOC by ASIN alone.

> Legacy fallback is evaluated by 31901 only after a tenant SQL query succeeds with zero rows and `LegacyVocReadEligibilityGate` accepts the immutable owner manifest. DB, schema, permission, timeout, or deserialize failures fail closed.

> Implementation and verification must not start a second Web server, listen on port 3000, replace running 31901/58258 services, stage generated data, or include the user's current worktree WIP.

> At the start and end of every task run `git status --short`; stage only the paths named by that task. If a named file already contains unrelated user changes, split the patch and stage only this task's hunks. Do not use `git add .`, do not clean generated data, do not amend another task's commit, do not push, and do not operate existing services during this plan.
