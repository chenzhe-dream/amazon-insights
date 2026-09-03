# Variant 与 Category 数据缺口修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正 runner 的 Sorftime variant 命令错配，并让 category batch 对单个 ASIN/node 失败逐项落盘、继续处理和有界汇总。

**Architecture:** 保留现有同步 stage、Provider adapter、生成文件 schema 与 postcondition，只在 runner 增加一个纯 command-spec helper，并在 category builder 内把 fail-fast 两段循环改为逐项 settlement。CLI 用 collector 返回的 allowlisted diagnostics 决定非零退出，runner 继续沿用既有 diagnostic parsing 与 per-ASIN readiness reconciliation。

**Tech Stack:** Node.js 22 ESM、`node:test`、TypeScript/TSX test runner、ESLint、现有 Sorftime MCP client 与 sync-job store。

## Global Constraints

- 只实现 inventory 已证实的两个 P0；任务数固定为 2。
- 严格 TDD：每个任务先写 RED、运行确认失败、再写最小 GREEN。
- 不调用真实 Provider，不发送 POST，不部署、不 push、不重启、不生成业务数据、不读取或修改凭证。
- 不修改 MCP/Provider adapter，不新增依赖、不做架构重构。
- 不猜测 `node_id`，不从 catalog 文本类目伪造 category 趋势。
- 保护现有 WIP；每次只 stage 本任务明确列出的文件。

---

### Task 1: 对齐 Sorftime variant builder、scope 与 provenance

**Files:**
- Modify: `scripts/run-asin-sync-job.mjs:870-891`
- Test: `tests/scripts/asin-sync-job-postconditions.test.mjs`

**Interfaces:**
- Consumes: `package.json` 已有 `variant:sorftime:sync -> node ./scripts/build-sorftime-variant-data.mjs`，以及 `providers.run(input)` 现有 command contract。
- Produces: `createSorftimeVariantInvocation(asins: string[], marketplace: string)`，返回 Sorftime `child_sales` stage 的不可变 command spec。

- [ ] **Step 1: 在现有 postcondition 测试文件写 RED fake-command contract**

```js
import { createSorftimeVariantInvocation } from "../../scripts/run-asin-sync-job.mjs";

test("Sorftime variant stage invokes the Sorftime builder with the Sorftime ASIN scope", () => {
  const calls = [];
  const providers = { run(input) { calls.push(input); return { succeeded: true, diagnostics: [], statusesByAsin: {} }; } };
  const asins = ["B074QLWRDQ", "B096LRXPBW", "B0BTM28F9N"];

  providers.run(createSorftimeVariantInvocation(asins, "US"));

  assert.deepEqual(calls, [{
    connector: "sorftime",
    stage: "child_sales",
    asins,
    label: "variant:sorftime:sync",
    command: "npm",
    args: ["run", "variant:sorftime:sync"],
    env: { SORFTIME_ASINS: asins.join(","), SORFTIME_MARKETPLACE: "US" },
  }]);
  assert.equal("SELLERSPRITE_ASINS" in calls[0].env, false);
});
```

- [ ] **Step 2: 运行测试确认 RED 来自缺少 helper**

Run: `node --test tests/scripts/asin-sync-job-postconditions.test.mjs`

Expected: FAIL，报告 `createSorftimeVariantInvocation` 未导出；不得启动任何 Provider child command。

- [ ] **Step 3: 写最小 command helper 并让 production path 使用它**

在 `executeAsinStage` 之前加入：

```js
export function createSorftimeVariantInvocation(asins, marketplace) {
  return Object.freeze({
    connector: "sorftime",
    stage: "child_sales",
    asins,
    label: "variant:sorftime:sync",
    command: "npm",
    args: ["run", "variant:sorftime:sync"],
    env: {
      SORFTIME_ASINS: asins.join(","),
      SORFTIME_MARKETPLACE: marketplace,
    },
  });
}
```

把现有 `variantResult` 调用替换为：

```js
const variantResult = providers.run(
  createSorftimeVariantInvocation(childAsins, marketplace),
);
```

不要改变相邻 `childSalesResult`、diagnostic 合并或 `applyPersistedStagePostcondition`。

- [ ] **Step 4: 运行 focused GREEN 与静态错配扫描**

Run: `node --test tests/scripts/asin-sync-job-postconditions.test.mjs && rg -n -C 3 'variant:sorftime:sync|variant:sync|SORFTIME_ASINS|SELLERSPRITE_ASINS' scripts/run-asin-sync-job.mjs`

Expected: tests PASS；`child_sales` 的 Sorftime variant invocation 只出现 `variant:sorftime:sync` + `SORFTIME_ASINS`，SellerSprite catalog 路径仍只使用 `SELLERSPRITE_ASINS`。

- [ ] **Step 5: 提交独立 Task 1**

```bash
git add scripts/run-asin-sync-job.mjs tests/scripts/asin-sync-job-postconditions.test.mjs
git commit -m "fix(sync): route variants through Sorftime builder"
```

### Task 2: Category 按 ASIN 隔离失败并与 postcondition 汇总

**Files:**
- Modify: `scripts/build-sorftime-category-trend.mjs:28-311`
- Test: `tests/agent/sync-category-resume.test.ts`
- Test: `tests/scripts/asin-sync-job-postconditions.test.mjs`

**Interfaces:**
- Consumes: `ProviderDiagnosticError.diagnostic` 与 `formatProviderDiagnosticLine(diagnostic)` 的现有 allowlisted fields；`collectSorftimeCategoryRecords` 的 fake `callTool`/`wait` 注入点；runner 的 `diagnosticStatusesByAsin`、`finalizeProcessedStageCohort` 与 category timeout terminal rule。
- Produces: `collectSorftimeCategoryRecords(...) -> Promise<{ records, nodePlan, diagnostics }>`，其中 `diagnostics` 每个失败 ASIN 一条、仅含现有 bounded diagnostic schema；所有 output records 继续满足 `SorftimeCategoryTrendRecord`。

- [ ] **Step 1: 把现有 fail-fast 测试改成 RED 的 mixed-batch settlement 测试**

在 `tests/agent/sync-category-resume.test.ts` 保留现有 governor fake，把 reject 断言改成以下三类断言：

```ts
test("missing node_id is isolated and a later ASIN still becomes ready", async () => {
  const calls: Array<{ asin: string; tool: string }> = [];
  const result = await collectSorftimeCategoryRecords({
    key: "fixture-key",
    marketplace: "US",
    catalog: [
      { asin: "B074QLWRDQ", subRankCategory: "Do not infer this" },
      { asin: "B0BTM28F9N", subRankCategory: "Fixture category" },
    ],
    existing: {},
    fetchedAt: "2026-09-02",
    callTool: async (_key, tool, args) => {
      const asin = String(args.asin ?? "B0BTM28F9N");
      calls.push({ asin, tool });
      if (tool === "product_detail" && asin === "B074QLWRDQ") return { data: {} };
      if (tool === "product_detail") return { data: { node_id: "123456789", subcategory: "Fixture category" } };
      return { data: ["2026-08=10"] };
    },
    wait: async () => {},
  });

  assert.equal(result.records["123456789"].status, "ready");
  const failed = Object.values(result.records).find(record => record.sourceAsin === "B074QLWRDQ");
  assert.equal(failed?.nodeId, "");
  assert.equal(failed?.status, "error");
  assert.equal(failed?.statusMessage, "MCP_SCHEMA");
  assert.deepEqual(result.diagnostics.map(item => [item.asin, item.causeCode]), [["B074QLWRDQ", "MCP_SCHEMA"]]);
  assert.equal(calls.some(item => item.asin === "B0BTM28F9N" && item.tool === "category_trend"), true);
});

test("one failed node emits one bounded diagnostic per ASIN and does not abort a later node", async () => {
  const result = await collectMixedNodeFixture({ firstNodeFailure: "CONNECT_TIMEOUT" });
  assert.equal(result.records["111111111"].status, "error");
  assert.equal(result.records["111111111"].statusMessage, "CONNECT_TIMEOUT");
  assert.equal(result.records["222222222"].status, "ready");
  assert.deepEqual(result.diagnostics.map(item => [item.asin, item.failureKind, item.causeCode]), [
    ["B074QLWRDQ", "timeout", "CONNECT_TIMEOUT"],
    ["B096LRXPBW", "timeout", "CONNECT_TIMEOUT"],
  ]);
  assert.equal(result.categoryDispatchesByNode["111111111"], 2);
});

test("a successful empty trend uses the existing empty schema without an error diagnostic", async () => {
  const result = await collectEmptyCategoryFixture();
  assert.equal(result.records["123456789"].status, "empty");
  assert.equal(result.records["123456789"].statusMessage, "UPSTREAM_EMPTY");
  assert.deepEqual(result.records["123456789"].volume, []);
  assert.deepEqual(result.diagnostics, []);
});
```

`collectMixedNodeFixture` 与 `collectEmptyCategoryFixture` 必须留在同一 test file，复用现有 `ProviderDiagnosticError`/governor fake；它们只返回固定 `product_detail`/`category_trend` fixtures，不访问网络或文件。`categoryDispatchesByNode` 是 test helper 自己的计数器，不是 production 返回字段。

- [ ] **Step 2: 运行 RED 并确认失败点是 collector 仍然 reject/缺少 diagnostics**

Run: `npx tsx --conditions=react-server --test tests/agent/sync-category-resume.test.ts`

Expected: FAIL；第一个局部错误使旧 collector reject，且返回值没有 `diagnostics`/有界 error settlement。

- [ ] **Step 3: 在 builder 内加入固定 empty/error record 与 diagnostic normalization helper**

在 `resolveNodeFromAsin` 中将缺字段标成现有 schema failure，不携带响应值：

```js
if (!nodeId) {
  throw Object.assign(new Error("category node unavailable"), {
    kind: "schema",
    providerDiagnostic: { operation: "product_detail", boundary: "consumer-shape" },
  });
}
```

在 builder 内新增纯 helpers；reason 只能来自现有 allowlist：

```js
function categoryFailureRecord({ asin, nodeId = "", categoryName = "", topCategory = "", asins = [asin], marketplace, fetchedAt, reason }) {
  return {
    nodeId, categoryName, topCategory, sourceAsin: asin, asins, marketplace, fetchedAt,
    status: "error", statusMessage: reason,
    volume: [], avgPrice: [], amount: [],
    listingMonopoly: [], brandMonopoly: [], sellerMonopoly: [],
  };
}

function boundedCategoryFailure(error, asin, operation) {
  const normalized = finalCategoryConnectTimeout(error, asin);
  if (normalized instanceof ProviderDiagnosticError) return normalized;
  return new ProviderDiagnosticError({
    connector: "sorftime", stage: "category", asin,
    failureKind: normalized?.kind === "schema" ? "schema" : "connection",
    causeCode: normalized?.kind === "schema" ? "MCP_SCHEMA" : "UNKNOWN_TRANSPORT",
    operation,
    boundary: normalized?.providerDiagnostic?.boundary,
  }, { cause: normalized });
}

function diagnosticForAsin(error, asin, operation) {
  const bounded = boundedCategoryFailure(error, asin, operation).diagnostic;
  return { ...bounded, asin };
}
```

使用 `formatProviderDiagnosticLine` 前仍会经过现有 sanitizer；不要把 raw error message 写入 record 或 diagnostic。

- [ ] **Step 4: 把两个 fail-fast catch 改成逐项 settlement，并让 empty 明确落 reason**

在 collector 初始化 `const diagnostics = [];`。`product_detail` catch 在 scoped fallback 不存在时执行：

```js
const diagnostic = diagnosticForAsin(error, product.asin, "product_detail");
diagnostics.push(diagnostic);
records[`asin-error:${product.asin}`] = categoryFailureRecord({
  asin: product.asin,
  marketplace,
  fetchedAt,
  reason: diagnostic.causeCode,
});
console.log(`error · ${diagnostic.causeCode}`);
continue;
```

构造 `normalRecord` 时给 empty 添加固定 reason：

```js
const normalRecord = {
  // 保留现有 node/category/asins/series/source 字段
  status: volume.length ? "ready" : "empty",
  ...(volume.length ? {} : { statusMessage: "UPSTREAM_EMPTY" }),
};
```

`category_trend` catch 在 scoped fallback 不存在时执行：

```js
const nodeDiagnostics = plan.asins.map(asin => diagnosticForAsin(error, asin, "category_trend"));
diagnostics.push(...nodeDiagnostics);
records[plan.nodeId] = categoryFailureRecord({
  asin: plan.sourceAsin,
  nodeId: plan.nodeId,
  categoryName: plan.categoryName,
  topCategory: plan.topCategory,
  asins: plan.asins,
  marketplace,
  fetchedAt,
  reason: nodeDiagnostics[0].causeCode,
});
console.log(`error · ${nodeDiagnostics[0].causeCode}`);
continue;
```

collector 最终返回 `return { records, nodePlan, diagnostics };`。不得把 catalog `subRankCategory` 写成 node、不得为失败记录生成趋势点。

- [ ] **Step 5: 让 CLI 先持久化 settlement，再用 diagnostics 汇总退出**

将 main 的 collector 解构与结尾改为：

```js
const { records, nodePlan, diagnostics } = await collectSorftimeCategoryRecords({
  key, marketplace, catalog, existing, fetchedAt, jobId,
});

// 保留现有 stale-node cleanup、body 和 fs.writeFileSync。
for (const diagnostic of diagnostics) {
  process.stderr.write(`${formatProviderDiagnosticLine(diagnostic)}\n`);
}
if (diagnostics.length) process.exitCode = 1;
```

删除顶层 catch 中依赖 collector reject 才输出单条 diagnostic 的路径；不可在写文件之前因局部 category 失败返回或抛出。真实编程错误仍由顶层 catch 非零退出。

- [ ] **Step 6: 运行 category、postcondition 和 bounded-diagnostic GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/sync-category-resume.test.ts && node --test tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/provider-bounded-diagnostics.test.mjs tests/scripts/sorftime-category-input.test.mjs tests/scripts/sorftime-category-retry.test.mjs`

Expected: PASS；mixed category batch 保留 ready ASIN，失败 ASIN 只有 allowlisted diagnostic/statusMessage，永久 timeout 每个 node 仍最多两次 physical dispatch，runner 的 ready/timeout/connector-failed postcondition 不回归。

- [ ] **Step 7: 提交独立 Task 2**

```bash
git add scripts/build-sorftime-category-trend.mjs tests/agent/sync-category-resume.test.ts tests/scripts/asin-sync-job-postconditions.test.mjs
git commit -m "fix(sync): isolate category results by ASIN"
```

## Final build and review gates

- [ ] Run the complete focused regression batch:

```powershell
node --test tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/provider-bounded-diagnostics.test.mjs tests/scripts/provider-degradation.test.mjs tests/scripts/sorftime-category-input.test.mjs tests/scripts/sorftime-category-retry.test.mjs
npx tsx --conditions=react-server --test tests/agent/sync-category-resume.test.ts tests/agent/sync-job-production-main-resume.test.ts
```

Expected: all tests PASS with no network listener, Provider call, POST, generated-data rewrite, deployment or restart.

- [ ] Run changed-file lint and the one production build:

```powershell
npx eslint scripts/run-asin-sync-job.mjs scripts/build-sorftime-category-trend.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/agent/sync-category-resume.test.ts
npm run build
```

Expected: both commands exit 0. The build is the final compile/bundle gate only; no sync/generator command is run.

- [ ] Run scope/WIP gate and request independent review:

```powershell
git diff --check
git status --short
git diff --stat HEAD~2..HEAD
```

Expected: no whitespace errors; implementation commits contain only the four files named by Tasks 1-2, while pre-existing `.superpowers/sdd/*` WIP remains unstaged and unmodified. Reviewer must separately return PASS for (a) exact spec coverage and (b) code quality before merge/push; this plan does not merge or push.

## Plan Self-Review

- Spec coverage: Task 1 covers the exact Sorftime builder/scope/provenance mismatch with a fake command contract. Task 2 covers node resolution and trend-call isolation, success continuation, existing error/empty schema, bounded per-ASIN reasons, aggregate exit behavior and runner postcondition compatibility.
- Scope: exactly two implementation tasks; no Provider adapter, dependency, schema migration, live operation, data generation, deployment, restart, push or architectural extension.
- Type consistency: `createSorftimeVariantInvocation`, `{ records, nodePlan, diagnostics }`, `ProviderDiagnosticError.diagnostic`, `statusMessage`, `SORFTIME_ASINS`, `child_sales`, and `variant:sorftime:sync` use the same names across test and implementation steps.
- Placeholder scan: no unresolved marker, deferred implementation instruction, vague error-handling step or unspecified test remains.
- Verdict: ready for task-by-task TDD execution after this docs-only planning commit.
