# 市场四模块本地规则优先实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让总览、形态/价格、关键词、买家主题四个新建任务先通过来源采集和本地规则生成一份可持久化、可重放的规则报告并完成，不调度 Agent；同时保留后续在同一份报告中追加语义解释的扩展边界。

**Architecture:** 复用现有来源采集、投影/样本池和四个规则基线适配器，在规则基线之后增加本地规则报告完成节点。新建任务使用独立的 rules-only flow identity，完成判断只依赖 `ruleStatus`。报告结构预留 `semantic` 区域和独立状态，但第一阶段固定 `semanticStatus=skipped`，不创建 `prepare-model-batches`、`model-batch` 或 synthesis 步骤。

**Tech Stack:** Next.js/React、TypeScript、Node test runner、Zod、PostgreSQL、现有 `MarketModuleService` 和市场步骤执行器。

## Global Constraints

- 规则数字、分母、缺失原因、证据引用和 `ruleStatus` 由本地 TypeScript 规则层决定，Agent 不参与第一阶段。
- 第一阶段新建任务必须在规则报告持久化后完成，不等待模型。
- 重新抓取才创建新的来源版本和规则基线；相同已接受命令只重放已保存结果。
- 保留现有页面、卡片、边框、历史入口和接口兼容性，只替换等待和完成判断所需的内部逻辑。
- 不发布、不重启正式 `31900/31901`，不修改其他 OpenSpec 的未提交改动。
- `semantic` 扩展字段只能增加解释，不能覆盖 `rule` 权威字段。

---

### Task 1: 为四个模块增加 rules-only flow identity

**Files:**
- Modify: `server/domain/market-research/overview-flow.ts`
- Modify: `server/domain/market-research/shape-price-flow.ts`
- Modify: `server/domain/market-research/keyword-flow.ts`
- Modify: `server/domain/market-research/customer-theme-flow.ts`
- Modify: `server/services/market-module-service.ts`
- Test: `tests/agent/market-overview-entry.test.ts`
- Test: `tests/agent/market-module-entry-replay.test.ts`

**Interfaces:**
- Each module exposes these versioned rules-only constants and uses them for new starts: `MARKET_OVERVIEW_RULES_FLOW_VERSION = 'market-overview-flow/rules-v1'`, `MARKET_SHAPE_RULES_FLOW_VERSION = 'market-shape-price-flow/rules-v1'`, `MARKET_KEYWORD_RULES_FLOW_VERSION = 'market-keyword-flow/rules-v1'`, and `MARKET_THEME_RULES_FLOW_VERSION = 'market-theme-flow/rules-v1'`.
- Each continuation inspector returns the persisted local-rule report as the terminal business step and never adds semantic model steps for that flow.
- Historical v1-v5 and existing semantic flows remain readable and replayable.

- [x] **Step 1: Write failing entry tests**

Add assertions that a new run's initial and continuation step definitions contain no `prepare-model-batches`, `model-batch`, `prepare-members`, or synthesis phase, and that the saved params contain the rules-only flow version.

```ts
assert.equal(saved.run.params.flow, MARKET_OVERVIEW_RULES_FLOW_VERSION);
assert.equal(view.steps.some(step => ['prepare-model-batches', 'model-batch'].includes(step.kind)), false);
```

- [x] **Step 2: Run the focused tests and verify they fail**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/market-overview-entry.test.ts tests/agent/market-module-entry-replay.test.ts
```

Expected: FAIL because current starts bind the existing semantic flow identities.

- [x] **Step 3: Implement the minimal flow split**

Add rules-only constants and branch the four `start*` methods to use them for new commands. Keep the existing semantic flow branches intact for historical runs. The rules-only continuation must stop after the existing rule report step and return no model children.

- [x] **Step 4: Run the focused tests and verify they pass**

Run the same command. Expected: all entry and replay assertions pass, including replay after the model identity is unavailable.

- [x] **Step 5: Commit**

```powershell
git add server/domain/market-research/overview-flow.ts server/domain/market-research/shape-price-flow.ts server/domain/market-research/keyword-flow.ts server/domain/market-research/customer-theme-flow.ts server/services/market-module-service.ts tests/agent/market-overview-entry.test.ts tests/agent/market-module-entry-replay.test.ts
git commit -m "feat: add local rules only market flows"
```

### Task 2: Persist and read one local-rule report per module

**Files:**
- Modify: `server/runtime/market-overview-report-step.ts`
- Modify: `server/runtime/market-overview-report-reader.ts`
- Modify: `server/services/market-overview-report-service.ts`
- Modify: `server/services/market-shape-read-service.ts`
- Modify: `server/services/market-keyword-read-service.ts`
- Modify: `server/services/market-theme-report-service.ts`
- Test: `tests/agent/market-overview-source-only.test.ts`
- Test: `tests/agent/market-shape-flow.test.ts`
- Test: `tests/agent/market-keyword-source-runtime.test.ts`
- Test: `tests/agent/market-theme-run-status.test.ts`

**Interfaces:**
- Each rules-only run stores one report whose numeric fields are derived from the already persisted `ruleBaseline`.
- The public response exposes separate `ruleStatus` and `semanticStatus`; rules-only runs return `semanticStatus: 'skipped'`.
- A missing rule input remains `partial` or `unavailable` with its existing reason; it is never converted to zero.

- [x] **Step 1: Write failing report completion tests**

For each module, create a run with a deterministic source fixture, drain only rule steps, and assert the saved report is readable without a model identity.

```ts
assert.equal(report.ruleStatus, 'complete');
assert.equal(report.semanticStatus, 'skipped');
assert.ok(report.ruleBaseline);
```

- [x] **Step 2: Run the four module tests and verify the rules-only path fails**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/market-overview-source-only.test.ts tests/agent/market-shape-flow.test.ts tests/agent/market-keyword-source-runtime.test.ts tests/agent/market-theme-run-status.test.ts
```

Expected: failures show that the current public completion/read path still expects semantic continuation or does not expose the separate status fields.

- [x] **Step 3: Connect the existing baseline outputs to the terminal report readers**

Use the persisted `ruleBaseline` from the catalog, source projection, keyword pool, and theme pool attempts. Do not recalculate from raw snapshots in the reader and do not add a second report shape. Set `semanticStatus` to `skipped` only for the new rules-only flow.

- [x] **Step 4: Run the four module tests and verify they pass**

Run the same command. Expected: each module returns one readable local-rule report without model calls.

- [x] **Step 5: Commit**

```powershell
git add server/runtime/market-overview-report-step.ts server/runtime/market-overview-report-reader.ts server/services/market-overview-report-service.ts server/services/market-shape-read-service.ts server/services/market-keyword-read-service.ts server/services/market-theme-report-service.ts tests/agent/market-overview-source-only.test.ts tests/agent/market-shape-flow.test.ts tests/agent/market-keyword-source-runtime.test.ts tests/agent/market-theme-run-status.test.ts
git commit -m "feat: complete market runs from local rule reports"
```

### Task 3: Close local-rule failure preservation and replay guarantees

**Files:**
- Modify: `server/domain/market-research/module-flow.ts`
- Modify: `server/services/market-module-service.ts`
- Test: `tests/agent/market-local-rule-replay.test.ts`
- Test: `tests/agent/market-module-entry-replay.test.ts`

**Interfaces:**
- Rule report persistence is independent of semantic status.
- Replaying the same accepted create command returns the same run and does not call a source connector or model.
- An explicit re-fetch command is the only path that creates a new source revision.

- [ ] **Step 1: Write failing counter-based tests**

Use connector and model stubs with counters. After the first local-rule run, replay the same command with the model identity removed and assert no counter increases.

```ts
const before = { sourceCalls, modelCalls };
const replay = await service.startKeywords(actor, studyId, params, key);
assert.equal(replay.created, false);
assert.deepEqual({ sourceCalls, modelCalls }, before);
```

Add a failure fixture where the optional semantic path is unavailable and assert the stored rule report remains readable.

- [ ] **Step 2: Run the new replay test and verify it fails**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/market-local-rule-replay.test.ts
```

Expected: FAIL until rules-only completion and counter assertions are wired through the runtime.

- [ ] **Step 3: Implement idempotent local-rule completion**

Make continuation and public read paths use the persisted rule report before consulting any model identity. Keep command conflict checks and organization scoping unchanged.

- [ ] **Step 4: Run replay, cancellation, and history tests**

```powershell
npx tsx --conditions=react-server --test tests/agent/market-local-rule-replay.test.ts tests/agent/market-module-entry-replay.test.ts tests/agent/market-cancellation.test.ts tests/agent/market-history-contract-routing.test.ts
```

Expected: all pass and no replay creates new source or model calls.

- [ ] **Step 5: Commit**

```powershell
git add server/domain/market-research/module-flow.ts server/services/market-module-service.ts tests/agent/market-local-rule-replay.test.ts tests/agent/market-module-entry-replay.test.ts
git commit -m "test: prove local rule replay and failure preservation"
```

### Task 4: Add the frozen overview snapshot acceptance fixture

**Files:**
- Create: `tests/fixtures/market-overview-local-rule-snapshot.json`
- Modify: `tests/agent/market-overview-rule-baseline.test.ts`
- Modify: `tests/agent/market-overview-source-only.test.ts`
- Modify: `openspec/changes/split-market-rule-baselines/tasks.md`

**Interfaces:**
- The fixture contains complete distribution values, a real zero, empty demand trend, and concentration without a confirmed unit.
- Rebuilding from the fixture produces the same rule metrics, missing reasons, and evidence references without network or model access.

- [ ] **Step 1: Add the fixture-driven failing replay test**

Load the JSON fixture twice, build the overview baseline twice, and assert deep equality plus zero connector/model calls.

```ts
assert.deepEqual(first, second);
assert.equal(first.metrics.find(metric => metric.key === 'demandTrend')?.value, null);
assert.equal(first.missing.some(item => item.reason.includes('concentration')), true);
```

- [ ] **Step 2: Run the focused overview tests**

```powershell
npx tsx --conditions=react-server --test tests/agent/market-overview-rule-baseline.test.ts tests/agent/market-overview-source-only.test.ts
```

Expected: the new fixture test fails only because the fixture and replay assertion are not present.

- [ ] **Step 3: Add the fixture and documentation assertions**

Keep the existing catalog version and evidence IDs. Do not add a synthetic demand value or concentration unit. Update the OpenSpec task text with the fixture path and completion evidence.

- [ ] **Step 4: Run the overview tests and strict OpenSpec validation**

```powershell
npx tsx --conditions=react-server --test tests/agent/market-overview-rule-baseline.test.ts tests/agent/market-overview-source-only.test.ts
openspec validate split-market-rule-baselines --type change --strict --no-interactive
```

Expected: tests pass, the change validates, and task 5.1 can be checked.

- [ ] **Step 5: Commit**

```powershell
git add tests/fixtures/market-overview-local-rule-snapshot.json tests/agent/market-overview-rule-baseline.test.ts tests/agent/market-overview-source-only.test.ts openspec/changes/split-market-rule-baselines/tasks.md
git commit -m "test: add frozen overview local rule replay"
```

### Task 5: Align the existing pages with local-rule completion

**Files:**
- Modify: `app/market-overview-section.tsx`
- Modify: `app/market-shape-section.tsx`
- Modify: `app/market-keyword-section.tsx`
- Modify: `app/market-theme-section.tsx`
- Modify: `app/market-research-section.tsx`
- Test: `tests/agent/market-overview-page.test.ts`
- Test: `tests/agent/market-shape-completion-ui.test.tsx`
- Test: `tests/agent/market-keyword-report-page.test.ts`
- Test: `tests/agent/market-theme-page.test.ts`

**Interfaces:**
- Existing cards and layouts remain unchanged.
- A rules-only run leaves waiting state as soon as the rule report is persisted.
- The UI does not show “waiting for input” or a model spinner for a rules-only run.
- The `semantic` area is reserved but hidden or marked skipped until the Agent phase is explicitly enabled.

- [ ] **Step 1: Write failing page-state tests**

Assert that a completed rules-only response renders the existing report frame and does not render a model-pending state.

```tsx
expect(screen.queryByText('等待模型')).toBeNull();
expect(screen.getByText(/规则报告/)).toBeTruthy();
```

- [ ] **Step 2: Run the page tests and verify the current wait behavior fails**

```powershell
npx tsx --conditions=react-server --test tests/agent/market-overview-page.test.ts tests/agent/market-shape-completion-ui.test.tsx tests/agent/market-keyword-report-page.test.ts tests/agent/market-theme-page.test.ts
```

- [ ] **Step 3: Change only completion and status mapping**

Keep existing component layout, report cards, history controls, and error frames. Map `ruleStatus` to the current report-ready state and keep semantic status separate.

- [ ] **Step 4: Run page parity and status tests**

```powershell
npx tsx --conditions=react-server --test tests/agent/market-overview-page.test.ts tests/agent/market-shape-completion-ui.test.tsx tests/agent/market-keyword-report-page.test.ts tests/agent/market-theme-page.test.ts tests/agent/market-overview-ui-parity.test.tsx tests/agent/market-shape-ui-parity.test.tsx
```

Expected: existing layout assertions remain green and rules-only runs display one report.

- [ ] **Step 5: Commit**

```powershell
git add app/market-overview-section.tsx app/market-shape-section.tsx app/market-keyword-section.tsx app/market-theme-section.tsx app/market-research-section.tsx tests/agent/market-overview-page.test.ts tests/agent/market-shape-completion-ui.test.tsx tests/agent/market-keyword-report-page.test.ts tests/agent/market-theme-page.test.ts
git commit -m "feat: show local rule reports as completed market runs"
```

### Task 6: Local-rule release gate

**Files:**
- Modify: `openspec/changes/split-market-rule-baselines/tasks.md`
- Test: existing focused suites from Tasks 1–5

- [ ] **Step 1: Run the complete local-rule verification set**

```powershell
npm run typecheck
npx tsx --conditions=react-server --test tests/agent/market-rule-baseline-contracts.test.ts tests/agent/market-rule-baseline.test.ts tests/agent/market-rule-baseline-modules.test.ts tests/agent/market-local-rule-replay.test.ts tests/agent/market-overview-source-only.test.ts
openspec validate split-market-rule-baselines --type change --strict --no-interactive
git diff --check
```

Expected: all commands exit 0. Existing source projection call-count regression must be resolved or explicitly documented before release; it cannot be silently ignored.

- [ ] **Step 2: Mark only local-rule tasks complete**

Check 3.2, 3.3 and 5.1 only after their tests pass. Leave 4.1 and 4.2 unchecked because Agent integration is a later phase.

- [ ] **Step 3: Review the actual local entry and report page**

Verify one real rules-only run reaches the report, refresh returns the same persisted result, and no model request is emitted. Capture the waiting, success, partial and unavailable states.

- [ ] **Step 4: Commit the acceptance record**

```powershell
git add openspec/changes/split-market-rule-baselines/tasks.md
git commit -m "docs: record local rule acceptance"
```

## Agent extension after local-rule acceptance

This plan deliberately does not implement Agent calls. The existing `report.semantic` shape, separate `semanticStatus`, evidence references, and rule-version fields are the extension boundary. A later plan will implement:

1. a server-side compact Agent input builder;
2. per-module semantic output schemas;
3. evidence and numeric immutability validation;
4. semantic-only retry and the optional explanation UI.

That later plan starts only after the local-rule release gate is green.
