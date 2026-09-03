# MCP 降级运行实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 保留唯一“开始全自动分析”入口，在至少一个所需 MCP 可用时运行全部可用数据源，并把不可用数据源对应模块如实标记为部分缺口。

**架构：** 后端把“全部就绪才放行”改为“生成按数据源划分的执行计划”；任务创建时把不可用数据源对应阶段预置为 `partial`，Worker 根据该状态跳过真实调用并写入每个目标 ASIN 的固定缺口。前端复用 `/v1/capabilities` 与当前 ASIN 缺失模块，在提交前显示中文警告，不增加新按钮。

**技术栈：** TypeScript、Node.js、Fastify、React、Zod、Node test runner、Playwright。

## 全局约束

- 哪个 MCP 可用就运行哪个；只有本次待执行阶段所需 MCP 全部不可用时才拒绝创建任务。
- 已知不可用的 MCP 不得发起网络调用，不得伪造数据。
- 结果只允许覆盖用户提交的站点与 ASIN，不得用关联 ASIN 替换目标 ASIN。
- 任何数据源缺口都必须使任务终态为 `completed-with-gaps`，不得显示为完整完成。
- 保留现有唯一按钮；提交前显示不可用数据源及受影响模块。
- 图片 AI 与人工 Alexa 流程保持现状。
- 单次点击只能产生一次提交、一个任务和一个 Worker claim。
- 不调用真实 MCP、不进行浏览器 POST、不创建 live job；部署与真实验收另行审批。
- 保护工作区现有 16 个 modified WIP 与 6 个 untracked project JSON；不得 stage、覆盖或格式化这些文件。

---

### Task 1：后端按数据源生成降级执行计划

**文件：**
- 修改：`server/services/sync-provider-readiness-service.ts`
- 修改：`server/services/sync-job-service.ts`
- 测试：`tests/agent/sync-provider-readiness-gate.test.ts`
- 测试：`tests/agent/local-data-bridge.test.ts`

**接口：**
- 产出：`SyncProviderReadinessPlan`，包含 `requiredConnectorIds`、`readyConnectorIds`、`unavailable`。
- 产出：`SyncProviderReadinessService.plan(input): Promise<SyncProviderReadinessPlan>`。
- 供 Task 2 使用：不可用数据源对应阶段初始状态持久化为 `partial`。

- [ ] **Step 1：写 RED，锁定部分可用仍创建任务**

在 `sync-provider-readiness-gate.test.ts` 增加真实 `SyncJobService.start` 用例：SellerSprite unavailable，SIF/Sorftime available；断言 `admit=1`、Worker launch=1、catalog partial，其他 provider 阶段 pending。

```ts
assert.equal(started.job.stages.find(stage => stage.id === "catalog")?.status, "partial");
assert.match(started.job.stages.find(stage => stage.id === "catalog")?.detail ?? "", /SellerSprite.*数据源不可用/);
assert.equal(started.job.stages.find(stage => stage.id === "keywords")?.status, "pending");
assert.equal(started.job.stages.find(stage => stage.id === "reviews")?.status, "pending");
assert.deepEqual(counters, { admit: 1, workerLaunch: 1, readiness: 1 });
```

- [ ] **Step 2：补 RED，锁定一家可用和全部不可用**

仅 SIF 可用时仍创建任务，SellerSprite 与 Sorftime 阶段全部为 partial；三家全部不可用时仍抛结构化错误且 `admit=0`、Worker launch=0。

```ts
assert.deepEqual(
  started.job.stages.filter(stage => stage.status === "partial").map(stage => stage.id),
  ["catalog", "reviews", "sales_trend", "child_sales", "price_strategy", "fba", "listing", "category"],
);
await assert.rejects(noneReady.start(scope()), (error: unknown) => {
  assert.ok(error instanceof SyncProviderReadinessError);
  assert.equal(error.details.length, 3);
  return true;
});
```

- [ ] **Step 3：运行 RED**

```powershell
npx tsx --test tests/agent/sync-provider-readiness-gate.test.ts tests/agent/local-data-bridge.test.ts
```

预期：新用例因当前任一 provider failure 都直接抛错而 FAIL。

- [ ] **Step 4：实现 readiness plan**

在 `sync-provider-readiness-service.ts` 定义冻结结果；把现有 `assertReady` 中“读取凭证、读取健康状态、生成 failures”的代码原样提取为私有 `#unavailableDetails`，不得改变凭证时效与安全原因分类。`assertReady` 保留为兼容入口并维持“任一家失败就拒绝”的旧语义；新增 `plan` 只有在 `requiredConnectorIds.length > 0 && readyConnectorIds.length === 0` 时抛错。

```ts
export type SyncProviderReadinessPlan = Readonly<{
  requiredConnectorIds: readonly ConnectorId[];
  readyConnectorIds: readonly ConnectorId[];
  unavailable: readonly SyncProviderReadinessDetail[];
}>;

async plan(input: { organizationId: string; automaticStages: readonly string[] }) {
  const requiredConnectorIds = requiredConnectors(input.automaticStages);
  if (requiredConnectorIds.length === 0) {
    return Object.freeze({ requiredConnectorIds: [], readyConnectorIds: [], unavailable: [] });
  }
  const unavailable = await this.#unavailableDetails(input.organizationId, requiredConnectorIds);
  const blocked = new Set(unavailable.map(item => item.connectorId));
  const readyConnectorIds = requiredConnectorIds.filter(id => !blocked.has(id));
  if (readyConnectorIds.length === 0) throw new SyncProviderReadinessError(unavailable);
  return Object.freeze({ requiredConnectorIds, readyConnectorIds, unavailable });
}

async assertReady(input: { organizationId: string; automaticStages: readonly string[] }) {
  const connectorIds = requiredConnectors(input.automaticStages);
  if (connectorIds.length === 0) return;
  const unavailable = await this.#unavailableDetails(input.organizationId, connectorIds);
  if (unavailable.length > 0) throw new SyncProviderReadinessError(unavailable);
}
```

- [ ] **Step 5：任务创建时预置不可用阶段**

把 `SyncJobServiceDependencies.providerReadiness` 与对应私有字段从 `Pick<..., "assertReady">` 改为 `Pick<..., "plan">`。`SyncJobService.start` 在读取模块状态后调用 `plan`，保存返回值，并以单一映射生成 partial 阶段。若绕过 readiness 或未注入服务，则使用空的 unavailable 集合。

```ts
const CONNECTOR_STAGES = Object.freeze({
  sellerSprite: ["catalog"],
  sif: ["keywords", "traffic"],
  sorftime: ["reviews", "sales_trend", "child_sales", "price_strategy", "fba", "listing", "category"],
} as const);
```

命中阶段使用：

```ts
{
  ...stage,
  status: "partial",
  detail: `${displayName} 数据源不可用，本阶段已跳过。`,
  completedAt: createdAt,
}
```

为避免时间漂移，把 `buildInitialStages` 入参明确增加 `createdAt: string` 与 `unavailable: readonly SyncProviderReadinessDetail[]`；`start` 使用已经取得的同一个 `createdAt` 调用它。未命中阶段仍保留 `completedAt: null`，只有预置为 partial 的阶段使用 `completedAt: input.createdAt`。

`queue`、`image_remarks`、`alexa_voc`、`build` 不得变为 partial。

- [ ] **Step 6：更新路由测试并运行 GREEN**

`local-data-bridge.test.ts` 覆盖部分可用返回 202 和全部不可用结构化拒绝。运行 Step 3 命令，预期全部 PASS。

- [ ] **Step 7：提交 Task 1**

```powershell
git add server/services/sync-provider-readiness-service.ts server/services/sync-job-service.ts tests/agent/sync-provider-readiness-gate.test.ts tests/agent/local-data-bridge.test.ts
git commit -m "feat: admit sync jobs with partial MCP readiness"
```

---

### Task 2：Worker 跳过不可用数据源并形成部分终态

**文件：**
- 修改：`scripts/run-asin-sync-job.mjs`
- 测试：`tests/agent/sync-runner-failure.test.ts`
- 测试：`tests/agent/sync-job-production-main-resume.test.ts`

**接口：**
- 消费：Task 1 持久化的 provider 阶段 `status === "partial"` 与安全 `detail`。
- 产出：`markPreflightUnavailableStages(jobId, job)` 为目标 ASIN 写 `connector-failed`。
- 显式 resume 仍只运行 `resumeStages` 中已恢复的阶段。

- [ ] **Step 1：写 RED，证明 partial 阶段零调用**

构造 catalog partial、SIF/Sorftime pending 的任务，断言 SellerSprite 调用为 0，其他 connector 仍调用。

```ts
assert.equal(calls.filter(call => call.connector === "sellerSprite").length, 0);
assert.ok(calls.some(call => call.connector === "sif"));
assert.ok(calls.some(call => call.connector === "sorftime"));
```

- [ ] **Step 2：写 RED，锁定 ASIN 缺口与终态**

三个目标 ASIN 的 catalog 都必须是固定 `connector-failed`，最终 `completed-with-gaps`，catalog stage 保持 partial。

```ts
for (const asin of requestedAsins) {
  assert.equal(job.asinProgress[asin].catalog.status, "connector-failed");
  assert.equal(job.asinProgress[asin].catalog.reason, "SellerSprite 数据源不可用，本阶段已跳过。");
}
assert.equal(job.status, "completed-with-gaps");
assert.equal(job.stages.find(stage => stage.id === "catalog")?.status, "partial");
```

- [ ] **Step 3：运行 RED**

```powershell
npx tsx --test tests/agent/sync-runner-failure.test.ts tests/agent/sync-job-production-main-resume.test.ts
```

预期：当前首次任务会执行所有阶段，新用例 FAIL。

- [ ] **Step 4：实现跳过与缺口写入**

```js
export function shouldRunSyncStage(job, stageId) {
  if (Array.isArray(job?.resumeStages)) return job.resumeStages.includes(stageId);
  const stage = job?.stages?.find(candidate => candidate?.id === stageId);
  return stage?.status !== "partial";
}

export function markPreflightUnavailableStages(jobId, job) {
  for (const stage of job.stages ?? []) {
    if (stage.status !== "partial" || !BASE_COHORT_STAGE_IDS.includes(stage.id)) continue;
    for (const asin of job.asins ?? []) {
      markAsinModule(jobId, asin, stage.id, {
        status: "connector-failed",
        reason: stage.detail ?? "数据源不可用，本阶段已跳过。",
      });
    }
  }
}
```

在读取 job 后、任何 provider 命令前调用 `markPreflightUnavailableStages`。不得把 partial 改成 skipped/done。

- [ ] **Step 5：锁定运行途中降级**

复用 provider controller 的假失败：某 connector 首次失败后停止其后续真实调用，其他 connector 继续。若当前行为已满足，只增加 characterization test。

- [ ] **Step 6：运行 GREEN 并提交**

运行 Step 3 命令，预期 PASS。

```powershell
git add scripts/run-asin-sync-job.mjs tests/agent/sync-runner-failure.test.ts tests/agent/sync-job-production-main-resume.test.ts
git commit -m "feat: skip unavailable MCP stages during sync"
```

---

### Task 3：提交前中文提示与组合门禁

**文件：**
- 修改：`app/lib/sync-job-display.ts`
- 修改：`app/asin-sync-funnel.tsx`
- 修改：`app/comparison-layout.css`
- 修改：`tests/agent/asin-sync-readiness.test.ts`
- 修改：`tests/agent/asin-sync-session.test.ts`

**接口：**
- 产出：`collectUnavailableProviderWarnings(items, capabilities)`。
- 消费：readiness GET 的缺失模块与 capabilities GET 的 connector 状态。
- 只增加提示，不增加按钮、不增加 POST。

- [ ] **Step 1：写纯函数 RED**

SellerSprite unavailable 且存在 `inCatalog=false` 时返回商品底库提示；若所有 ASIN 已有底库则不误提示。SIF 影响“关键词、竞品流量”；Sorftime 影响“评论、销量趋势、子体销量、价格策略、FBA、Listing、类目趋势”。

```ts
assert.deepEqual(collectUnavailableProviderWarnings(items, capabilities), [{
  connectorId: "sellerSprite",
  label: "SellerSprite",
  modules: ["商品底库"],
  message: "SellerSprite 当前不可用，将跳过商品底库；其他可用数据源仍会继续。",
}]);
```

- [ ] **Step 2：运行纯函数 RED**

```powershell
npx tsx --test tests/agent/asin-sync-readiness.test.ts
```

预期：函数不存在，FAIL。

- [ ] **Step 3：实现提示计算与页面加载**

`sync-job-display.ts` 使用闭合固定映射，不显示 provider 原始错误。`AsinSyncProgressSection.refreshStatus` 并行请求：

```ts
const [statusResponse, capabilitiesResponse] = await Promise.all([
  localAgentFetch(`/v1/local-data/sync-asins?asins=${encodeURIComponent(asins.join(","))}`),
  localAgentFetch("/v1/capabilities"),
]);
```

readiness 失败保持既有错误；capabilities 失败只隐藏提示，不阻止启动。渲染：

```tsx
{providerWarnings.length > 0 ? (
  <div className="sync-provider-warning" role="status" data-provider-warning="true">
    <strong>部分数据源不可用，仍可继续分析</strong>
    {providerWarnings.map(warning => <p key={warning.connectorId}>{warning.message}</p>)}
  </div>
) : null}
```

CSS 只增加清晰警示背景/边框，不改变按钮布局。

- [ ] **Step 4：写浏览器测试，锁定一次 POST**

在 `asin-sync-session.test.ts` harness 补 `/v1/capabilities` 响应。SellerSprite unavailable 时提示可见；点击现有按钮后 sync POST 恰好一次，payload ASIN 与页面三项一致。

```ts
await expect(page.getByText("部分数据源不可用，仍可继续分析")).toBeVisible();
await page.getByRole("button", { name: "拉取缺失数据" }).click();
assert.equal(syncPosts.length, 1);
assert.deepEqual(syncPosts[0].asins, expectedAsins);
```

- [ ] **Step 5：运行 Task 3 测试**

```powershell
npx tsx --test tests/agent/asin-sync-readiness.test.ts tests/agent/asin-sync-session.test.ts
```

预期：全部 PASS。

- [ ] **Step 6：运行唯一组合 affected suite**

```powershell
npx tsx --test tests/agent/sync-provider-readiness-gate.test.ts tests/agent/local-data-bridge.test.ts tests/agent/sync-runner-failure.test.ts tests/agent/sync-job-production-main-resume.test.ts tests/agent/asin-sync-readiness.test.ts tests/agent/asin-sync-session.test.ts
```

预期：0 fail、0 unexpected skip。

- [ ] **Step 7：changed-file lint、diff-check、一次 build**

```powershell
npx eslint server/services/sync-provider-readiness-service.ts server/services/sync-job-service.ts scripts/run-asin-sync-job.mjs app/lib/sync-job-display.ts app/asin-sync-funnel.tsx tests/agent/sync-provider-readiness-gate.test.ts tests/agent/local-data-bridge.test.ts tests/agent/sync-runner-failure.test.ts tests/agent/sync-job-production-main-resume.test.ts tests/agent/asin-sync-readiness.test.ts tests/agent/asin-sync-session.test.ts
git diff --check $env:IMPLEMENTATION_BASE..HEAD
npm run build
```

预期：lint 无 error，diff-check exit 0，build exit 0；build 恰好运行一次。

- [ ] **Step 8：提交并核对 WIP**

```powershell
git add app/lib/sync-job-display.ts app/asin-sync-funnel.tsx app/comparison-layout.css tests/agent/asin-sync-readiness.test.ts tests/agent/asin-sync-session.test.ts
git commit -m "feat: warn before degraded MCP sync"
git status --short
git diff --name-only $env:IMPLEMENTATION_BASE..HEAD
```

原 16 个 modified WIP 和 6 个 untracked project JSON 必须仍存在且不在提交内。

---

## 最终审查门禁

- Task 1 开始前把计划提交后的 `git rev-parse HEAD` 记为 `IMPLEMENTATION_BASE`；独立 reviewer 只读审查 `$IMPLEMENTATION_BASE..HEAD`。
- 必须确认：Critical=0、直接阻断=0、无真实 MCP/POST、ASIN 精确、全部不可用仍 0 admit/0 worker、部分可用只有一个 job/claim。
- Critical/Important 由实现窗口修复并重新限定复审；本指令窗口不直接写代码。
- 审查通过后停止在“待受控部署”，不得自动部署或提交真实 ASIN。
