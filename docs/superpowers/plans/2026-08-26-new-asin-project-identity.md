# New ASIN Project Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新输入的市场或规范化 ASIN 集合发生变化时，创建并登记新的项目身份，再且仅再提交一次同步；旧项目及历史结果保持不可变。

**Architecture:** 保留现有 React 页面、local project API、PostgreSQL project registration 和 sync admission 边界。页面只复用“市场与 ASIN 集合完全一致”的项目；不再 PATCH 旧项目 ASIN。登记响应必须通过 ID、租户、市场和 ASIN 精确校验，随后先切换 URL/页面所有权，再允许同步 POST；所有项目登记失败统一 fail-closed。

**Tech Stack:** TypeScript, React/Next-compatible Vinext UI, Fastify Agent API, Node test runner, Playwright Chromium harness, ESLint, OpenSpec.

## Global Constraints

- 只在 `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\new-asin-project-identity` / `codex/new-asin-project-identity` 实施，基线为设计提交 `85d2b72905c8c0cf2d6b99887fcc549041939d77`。
- 不修改 Provider、readiness、Worker、stage/output、retry、数据库 schema 或跨租户授权；不吞掉、upsert 或改写 PostgreSQL 的 `409`。
- 不触碰稳定 worktree `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\stabilize-resumable-sync-pipeline` 的 27 项业务 WIP；实现阶段禁止真实 Provider、浏览器业务 POST、job/run/stage、部署和 push。
- 现有 `tests/agent/helpers/asin-sync-funnel-browser-harness.tsx` 从项目已归属后的 admission 开始建模，本变更不修改它；项目身份测试复用 `tests/agent/asin-sync-session.test.ts` 中已存在的 `AuthenticatedAmazonOpportunityApp` 浏览器 harness。
- 最终真实验收组 `B0CZP3CDSZ/B099284SRR/B09NRG4GK3` 只在实现、复审和受控部署全部通过后由用户唯一点击；计划与实现阶段不得触发。

---

### Task 1: 只复用完全一致的项目，并在同步前切换新项目所有权

**Files:**
- Modify: `app/page.tsx:2396-2547`
- Test: `tests/agent/asin-sync-session.test.ts:644-775`（在现有真实 overview 浏览器测试附近新增 identity 场景）

**Interfaces:**
- Consume: `sameAsinSet(left, right)`、`localAgentFetch()`、`applyProject(project, { announce, replace })`、`replaceAppUrl()`、`projectWorkspacePath()`。
- Preserve: `POST /v1/local-data/projects` 创建 local project；`POST /v1/projects` 登记相同 ID 与精确 ASIN；`POST /v1/local-data/sync-asins` 只接受已登记的新 ID。
- Produce: 同市场且 ASIN 集合完全一致时复用；任一不同时创建新 ID/slug，禁止 PATCH 旧项目；登记成功后先切 URL/owner，再唯一 sync。

- [ ] **Step 1: 添加真实页面 RED 测试。** 在 `asin-sync-session.test.ts` 复用 `overviewHarnessEntry`、`page.route("**/api/agent/**")` 和输入框名称 `asin-slot-0..2`。记录每个请求的 method/path/body，并覆盖：
  1. 当前旧项目的市场或 ASIN 与输入不同；
  2. local list 中没有精确匹配；
  3. local create 返回 `new-project-id/new-slug`；
  4. PG registration 回相同 ID、当前 `organizationId`、相同市场/ASIN；
  5. sync 返回唯一 job/run。

  核心断言必须类似：

  ```ts
  await page.getByRole("button", { name: "开始全自动分析" }).dblclick();

  assert.equal(calls.filter(call => call.method === "PATCH").length, 0);
  assert.equal(calls.filter(call => call.path === "/api/agent/v1/local-data/projects" && call.method === "POST").length, 1);
  assert.equal(calls.filter(call => call.path === "/api/agent/v1/projects" && call.method === "POST").length, 1);
  assert.equal(calls.filter(call => call.path === "/api/agent/v1/local-data/sync-asins" && call.method === "POST").length, 1);
  assert.deepEqual(syncBody, { projectId: newProject.id, marketplace: "US", asins: nextAsins });
  assert.equal(new URL(page.url()).pathname, `/p/${newProject.slug}`);
  assert.deepEqual(oldProject, oldProjectBefore);
  ```

  同文件再加一个小场景：当前项目市场与规范化 ASIN 集合完全一致时，local create 为 `0`、旧项目复用、registration/sync 各 `1`。

- [ ] **Step 2: 运行 RED。**

  ```powershell
  npx tsx --conditions=react-server --test --test-name-pattern="new ASIN project identity" tests/agent/asin-sync-session.test.ts
  ```

  预期：失败原因明确显示旧实现执行 PATCH/复用旧 ID，或 sync 发出时 URL 尚未切换；不得因 fixture/selector 错误失败。

- [ ] **Step 3: 最小 GREEN。** 在 `ensureAnalysisWorkspace()` 删除 `overlapRatio` 与整个 PATCH 分支，仅允许完全一致复用：

  ```ts
  if (currentProjectId) {
    try {
      const response = await localAgentFetch(`/v1/local-data/projects/${encodeURIComponent(currentProjectId)}`);
      const existing = ((await response.json()) as { project?: AnalysisProject }).project;
      if (
        response.ok &&
        existing &&
        (existing.marketplace || "US") === market &&
        sameAsinSet(existing.asins, asins)
      ) return existing;
    } catch {
      // 精确复用失败后走 list/create；绝不修改旧项目。
    }
  }
  ```

  保留现有 exact-match list，只有无精确匹配时才 `POST /v1/local-data/projects`。在 registration 精确校验通过后、sync POST 之前同步切换地址并提交 React owner 状态：

  ```ts
  const ownershipParams = new URLSearchParams(cleanParams);
  ownershipParams.delete("asins");
  ownershipParams.delete("project");
  replaceAppUrl(ownershipParams, projectWorkspacePath(project.slug));
  applyProject({ ...project, marketplace: market, asins: [...values] }, { announce: false, replace: true });
  ```

  继续使用既有同步 body 中的 `registeredProject.id`；保留 `analysisStartInFlight.current` 的同步双击屏障。终态 job/run 参数仍由现有 `finalParams` 写回新 slug。

- [ ] **Step 4: 运行 GREEN 与回归。**

  ```powershell
  npx tsx --conditions=react-server --test --test-name-pattern="new ASIN project identity|real overview" tests/agent/asin-sync-session.test.ts
  ```

  预期：新场景和既有 real overview 场景全部 PASS；请求序列严格为 local create ≤1、registration 1、sync 1，旧项目无 PATCH。

- [ ] **Step 5: 检查并提交 Task 1。**

  ```powershell
  git diff --check -- app/page.tsx tests/agent/asin-sync-session.test.ts
  git add -- app/page.tsx tests/agent/asin-sync-session.test.ts
  git diff --cached --name-only
  git commit -m "fix(analysis): preserve project identity for new ASIN sets"
  ```

  staged 输出只能是上述两个文件。

### Task 2: 项目登记失败可见且 fail-closed，并冻结受控部署候选

**Files:**
- Modify: `app/page.tsx:2457-2552`
- Test: `tests/agent/asin-sync-session.test.ts`（紧邻 Task 1 identity 场景）

**Interfaces:**
- Produce fixed UI error: `项目登记失败，未创建分析任务，请重试`。
- Enforce registration contract: `response.ok` 且 response project 的 ID、`organizationId`、marketplace、ASIN set 全部精确匹配；否则 sync POST 为 `0`。
- Preserve refresh: 新 slug 的既有 hydration (`app/page.tsx:2261-2317`) 从 local project 恢复市场和 ASIN，不产生 registration/sync POST。

- [ ] **Step 1: 添加 409、租户错配和刷新 RED 测试。** 用 Task 1 同一真实页面 harness 覆盖：

  ```ts
  assert.equal(await page.getByText("项目登记失败，未创建分析任务，请重试").count(), 1);
  assert.equal(syncPosts, 0);
  assert.equal(oldProjectPatchCalls, 0);
  ```

  - registration `409`：显示固定中文错误，sync 为 `0`，旧项目不变。
  - registration 返回其他 `organizationId`：同样固定错误和 `0` sync，证明跨租户授权未放宽。
  - 刷新 `/p/new-slug`：GET local project 后恢复精确 ASIN/市场，local create、registration、sync 都为 `0`。
  - 快速双击沿用 Task 1 断言：新 local project、registration、sync 各恰好 `1`。

- [ ] **Step 2: 运行 RED。**

  ```powershell
  npx tsx --conditions=react-server --test --test-name-pattern="project registration failure|new ASIN project refresh|new ASIN project identity" tests/agent/asin-sync-session.test.ts
  ```

  预期：至少固定中文错误或 fail-closed 断言在旧实现下失败。

- [ ] **Step 3: 实现固定安全错误。** 在页面模块定义并仅用于 project create/registration 边界：

  ```ts
  const PROJECT_REGISTRATION_FAILURE = "项目登记失败，未创建分析任务，请重试";
  ```

  local project 创建失败以及 registration 非 2xx/任一精确校验失败时均 `throw new Error(PROJECT_REGISTRATION_FAILURE)`；不得调用 `localAgentErrorMessage()` 暴露上游 `409` 细节，也不得继续 sync。sync 自身失败仍沿用现有固定安全投影，不改变其生命周期语义。

- [ ] **Step 4: 运行 GREEN 和完整 affected suite。**

  ```powershell
  npx tsx --conditions=react-server --test --test-name-pattern="project registration failure|new ASIN project refresh|new ASIN project identity" tests/agent/asin-sync-session.test.ts
  npx tsx --conditions=react-server --test tests/agent/asin-sync-session.test.ts
  npx eslint app/page.tsx tests/agent/asin-sync-session.test.ts
  npx tsc --noEmit --pretty false --project tsconfig.stage-results-category-retry.json
  ```

  预期：全部 PASS / ESLint 0 errors / focused affected typecheck 0 diagnostics。不得为通过检查修改无关文件。

- [ ] **Step 5: 提交 Task 2。**

  ```powershell
  git diff --check -- app/page.tsx tests/agent/asin-sync-session.test.ts
  git add -- app/page.tsx tests/agent/asin-sync-session.test.ts
  git diff --cached --name-only
  git commit -m "fix(analysis): fail closed on project registration"
  ```

- [ ] **Step 6: 运行一次且仅一次最终 build 与冻结门禁。** fixture/RED/GREEN 阶段不得运行 build；只在全部 focused/combined tests 通过后执行：

  ```powershell
  npm run build
  npx openspec validate build-standalone-agent-workflow --strict
  git diff --check 85d2b72905c8c0cf2d6b99887fcc549041939d77..HEAD
  git diff --name-only 85d2b72905c8c0cf2d6b99887fcc549041939d77..HEAD
  git status --short
  ```

  预期：production build PASS，OpenSpec strict PASS，diff-check clean，候选范围只含 `app/page.tsx`、`tests/agent/asin-sync-session.test.ts` 和已批准设计/计划文档；候选 worktree/index clean。

- [ ] **Step 7: 只读保护稳定 WIP，并做一次限定复审。** 不在稳定 worktree 执行任何写命令：

  ```powershell
  $stable = 'C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\stabilize-resumable-sync-pipeline'
  @(git -C $stable status --porcelain=v1).Count
  @(git -C $stable diff --cached --name-only).Count
  git -C $stable rev-parse HEAD
  ```

  预期：业务 WIP 仍为 `27`、index 为 `0`，稳定 HEAD/线上服务未被本分支影响。独立 reviewer 仅检查：旧项目不可变、URL/owner-before-sync、唯一 local create/registration/sync、409/租户错配 `0 sync`、刷新恢复和范围边界；门禁为 `Critical=0`、`direct business blockers=0`，非阻断建议 deferred。

- [ ] **Step 8: 停在受控部署门禁前。** 记录 exact candidate SHA、测试/lint/typecheck/build/OpenSpec/review 证据，标记 `READY_FOR_CONTROLLED_DEPLOYMENT` 后停止。后续部署必须另行 preflight（live health、active job/stage/attempt=0、migration/fake/single-supervisor、27 WIP/index），不得在本任务中部署、Provider probe 或真实提交三 ASIN。
