# SIF Traffic Regression Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将遗漏的 SIF 格式和明细修复安全适配到当前集成版本，覆盖历史精简数据，并防止再次合并遗漏。

**Architecture:** 复用已验证的完整白名单投影；消费者进行字段级合并，但只能接收当前 owner 已核验的明细。动态摘要不默认读取全局缓存，显示层明确区分完整、权威空结果和明细缺失。

**Tech Stack:** Node.js >=22.13.0、TypeScript、React 19、tsx、Node test runner、Vite / Playwright 本地 fixture。

## Global Constraints

- 用户已在修订后明确“开始修复一下”：执行本地代码、测试与审查任务；完成一项才更新对应勾选。
- 不发起新的 SIF、SellerSprite、Sorftime 或 LLM 请求，不创建真实分析任务。
- 不修改既有任务、run、stage、snapshot 或业务数据库记录；测试只能用 fixture，隔离数据库测试另列。
- 只补来自当前授权范围、站点、ASIN、run / job 与采集批次可核验的证据；无法核验就保留缺失。
- 原始数据不因显示精度而改写；0–1 比例与 0–100 百分数不混用。
- 明确 `[]`、`0`、`null` 不等于缺字段；畸形输入不伪装成有效空数据。
- 保留现有西柚、登录权限、其他窗口工作和新增测试；不整体替换旧版本文件。
- 不修改已有月度流量图的算法或布局，不新增月度交互。
- 发布、重启、真实任务重跑不属于本轮修复授权。开发验证与正式验证分别记录。

设计依据：[修订设计](../specs/2026-09-09-sif-traffic-regression-repair-design.md)。旧提交 `123c261 / 6280800 / 3e4d594` 是参考，不是整组 cherry-pick 指令。

## Task 1: 新任务保留完整投影，补回生产端回归测试

**Files:**
- Modify: `scripts/lib/sync-stage-output.mjs`
- Test: `tests/scripts/sync-stage-output.test.mjs`
- Regression: `tests/scripts/asin-sync-job-postconditions.test.mjs`

**Interfaces:**
- Consumes: 现有 `projectStageOutput("traffic", asins, options)` 和 `{ overview, structure }` 原始记录。
- Produces: 现有 `listingByAsin` 中的白名单完整明细；精简输入仍兼容，不修改外层 stage 协议。

- [ ] 记录实际源码 / 集成 HEAD 与 `git status --short`，核对并行 owner；在隔离工作树执行，不在正式目录跑构建。
- [ ] 用以下命令读取精确旧补丁和测试，逐段复用测试，不恢复整个历史测试文件：

```powershell
git show 123c261 -- scripts/lib/sync-stage-output.mjs tests/scripts/sync-stage-output.test.mjs
```

- [ ] 先移植完整输入测试，并增加四个广告渠道、推荐阈值 / 排序 / 前六项、多个子体索引对应、未知 Provider 字段排除、缺失与畸形 `structure` 用例。在当前坏代码上运行 RED：

```powershell
node --test tests/scripts/sync-stage-output.test.mjs
```

预期：完整明细相关断言失败，失败原因必须是字段丢失而非依赖或环境问题。

- [ ] 选择性移植 `123c261` 的 `normalizedTrafficListing` 与纯 helper。原始明细缺失时不得输出伪权威空数组；真实空数组则保留。过滤畸形子体时先按原索引取渠道，再过滤，避免错配。
- [ ] 测试中保留以下精度断言；以下数值为本次故障的回放样本，不写入生产分支业务常量：

```js
assert.equal(Math.round(128266.49784446), 128266);
assert.equal(Math.round(141360.96935435), 141361);
assert.equal(Math.round(0.47571747 * 1000) / 10, 47.6);
assert.equal(Math.round(47.571747577185825 * 10) / 10, 47.6);
```

这些辅助断言不能替代对 `draft.data.listingByAsin[asin]` 完整输出的断言。

- [ ] 运行 GREEN，再审查此任务的全部 diff：

```powershell
node --test tests/scripts/sync-stage-output.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs
git diff --check
```

- [ ] 通过后按任务提交，只包含上述生产文件及相关测试，记录实际提交号到实施验证报告。

## Task 2: 修复消费者合并与来源边界，恢复可信历史明细

**Files:**
- Modify: `app/lib/stage-output-view.ts`
- Modify: `app/sif-listing-traffic-data.ts`
- Modify: `app/page.tsx`（仅 traffic 数据接线）
- Modify: `app/lib/traffic-snapshot-browser.ts`（会话与登出失效）
- Test: `tests/agent/runtime-analysis-data.test.ts`
- Regression: `tests/agent/stage-output-browser.test.ts`, `tests/agent/traffic-snapshot-browser.test.ts`
- Create: `app/lib/traffic-detail-view.ts`, `tests/agent/traffic-detail-view.test.ts`

**Interfaces:**
- Consumes: 已通过现有 owner 接受的 stage output、动态 snapshot、由该 owner 持有的上下文；不从 snapshot 正文假定存在组织或 run 字段。
- Produces: 当前任务专用 `TrafficDisplayData` 及每个 ASIN 的明细可用状态；旧摘要不清空已验证完整明细。

- [ ] 阅读 `6280800`、`3e4d594` 的精确 diff。将字段级合并与数字处理移植成纯逻辑；删除“默认全局缓存”策略，不把整个旧函数作为最终实现。

```powershell
git show 6280800 -- app/lib/stage-output-view.ts tests/agent/runtime-analysis-data.test.ts
git show 3e4d594 -- app/sif-listing-traffic-data.ts tests/agent/runtime-analysis-data.test.ts
```

- [ ] 为来源匹配定义独立纯接口。下列是新增的内部 view 类型，不是现有 API 字段；调用方只能从已授权 owner / 已验证证据构造，不接受页面参数自报的组织身份：

```ts
export type TrafficDetailScope = Readonly<{
  organizationId: string;
  projectId: string;
  runId: string;
  jobId: string;
  marketplace: string;
  asin: string;
  evidenceId: string;
}>;

export function sameTrafficDetailScope(
  expected: TrafficDetailScope,
  candidate: TrafficDetailScope | null | undefined,
): boolean {
  if (!candidate) return false;
  const keys = ["organizationId", "projectId", "runId", "jobId",
    "marketplace", "asin", "evidenceId"] as const;
  return keys.every(key => expected[key].length > 0 && expected[key] === candidate[key]);
}
```

`evidenceId` 必须是可信任务产物 / 同批证据的已有身份，不能用 ASIN、当前日期或调用方生成的随机值代替。缺少这样的关联时，不构造可用缓存参数。

- [ ] 先添加来源匹配 RED 用例：每个键单独变化均拒绝，空身份拒绝，无来源拒绝。同 ASIN 的不同 run / 站点 / 组织必须被拒绝。服务端权限继续由已有路由测试覆盖，此 helper 不充当权限校验。
- [ ] 添加消费者 RED 用例：旧精简投影覆盖可信明细、只传 `total` 不归零其他字段、显式 0、显式 `[]`、显式 `null`、无 fallback、畸形数组、完整响应与摘要响应两种先后顺序。
- [ ] 使用 own-property 检查控制覆盖，不能用 `value || fallback`。精简字段没有提供时保持已有可信字段；没有已有字段则保留未知状态，不制造 0：

```ts
const hasOwn = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);
// 分支顺序：未提供 -> 可信已有值 / 未知；提供且有效 -> 包括 0 的新值；提供但无效 -> 不可用。
```

- [ ] `trafficDisplayFromSnapshot` 不再从全局模块隐式补明细；完整明细显式传入且通过 scope 验证。无可信明细时保留 snapshot 的真实总量和 childCount，但不将“最大渠道”配上整个广告总分冒充渠道明细。
- [ ] 页面当前 run 接线必须同时处理“有动态 snapshot”和“snapshot 尚未返回”分支；后者也不能退回全局缓存。保留现有 owner 的权限错误、任务切换和迟到响应处理。
- [ ] 将 `authSession.sessionIdentity`、`authSession.user.organizationId`、`authSession.logoutPending` 纳入 traffic owner 绑定与显示资格。身份变化或开始登出时，在绘制旧内容前立即清空 traffic 摘要 / 明细并失效原 binding；旧请求即使稍后返回 200 也不能提交。登出期间不发刷新请求。可扩展 owner 的上下文，但不能把客户端身份字段当作服务端授权凭据。
- [ ] 增加真正只改变 sessionIdentity、只改变 organizationId（run / 站点 / ASIN 全不变），以及登出时请求未完成的 owner 和实际页面接线回归；断言旧摘要与明细同时消失、迟到响应不恢复显示、登出期间新增请求数为 0。
- [ ] 历史三款恢复前进行只读来源核验，记录 run、snapshot、关联产物、原始证据指纹和采集时间。没有同批证据则停止该恢复项，保留待补齐状态；不能为通过验收而更新业务表、伪造 provenance 或重跑 Provider。
- [ ] 运行 RED / GREEN，每次确认断言而非环境导致结果；不将隔离 PostgreSQL 测试混入此组：

```powershell
npx --no-install tsx --conditions=react-server --test tests/agent/traffic-detail-view.test.ts tests/agent/runtime-analysis-data.test.ts tests/agent/stage-output-browser.test.ts tests/agent/traffic-snapshot-browser.test.ts
```

- [ ] 独立审查消费者和来源边界后按任务提交，保留所有与本任务无关的已有测试。

## Task 3: 显示精度、真实空态与实际页面回归

**Files:**
- Modify: `app/page.tsx`（traffic 数字 / 提示框 / 空态）
- Modify: `app/sif-listing-traffic-data.ts`（仅增加 view 所需状态）
- Modify: `app/comparison-layout.css`（仅在几何断言证明需要时调整）
- Create: `tests/agent/traffic-display-regression.test.tsx`
- Extend: `app/lib/traffic-detail-view.ts`, `tests/agent/traffic-detail-view.test.ts`

**Interfaces:**
- Consumes: Task 2 的当前任务 view；明细状态按 `complete | empty | missing | invalid` 区分，已知 childCount 与已加载 rows 数分开保存。
- Produces: 原页面、原位置的整数流量分、一位小数占比、可信子体计数与非误导空态。

- [ ] 在纯 view helper 中增加以下显示函数并先写 RED 测试。非有限或负值保持不可用，不能作为合法零值：

```ts
export function formatTrafficScore(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value).toLocaleString("en-US") : "—";
}
export function formatTrafficPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? `${value.toFixed(1)}%` : "—";
}
```

- [ ] 让正文和 title 使用同一 formatter；不要修改源值或分析算法。缺明细但有 childCount 时显示“已识别 N 个子体，明细待补齐”；未知数量显示“子体数据待补齐”。
- [ ] 建立本地 Vite / Playwright fixture，挂载实际 traffic 页面路径与生产组件，而非复制一份相似 HTML。屏蔽真实外部请求，记录任务 POST / 重跑 / Provider 请求次数为 0。
- [ ] 固定三 ASIN fixture，验证子体数 11 / 2 / 6；三款自然占比 47.6% / 41.5% / 67.1%。验证广告与推荐栏目有真实行，不只检查总数字存在。
- [ ] 覆盖完整新任务、旧精简任务加可信证据、无证据旧任务、响应先后顺序、刷新、任务切换、权限错误、pending。验证不足证据不报成功，不报告错误的 0 子体。
- [ ] 在 1280 和 1920 像素宽度、100% 缩放下检查数值矩形不与下一列重叠，正文与悬浮 title 一致；仅必要时改上述 CSS。
- [ ] 运行浏览器与相关路由回归，预期 0 failures、无真实任务创建：

```powershell
npx --no-install tsx --conditions=react-server --test tests/agent/traffic-display-regression.test.tsx tests/agent/traffic-detail-view.test.ts tests/agent/asin-sync-session.test.ts tests/agent/stage-output-route.test.ts tests/agent/traffic-snapshot-read-route.test.ts
```

- [ ] 独立审查与按任务提交；若只验证了 fixture，报告不得写“正式页面已恢复”。

## Task 4: 固化最终集成回归门槛，防止重复遗漏

**Files:**
- Modify: `package.json`（新增下面的本地测试入口，不改默认构建流程）
- Create: `docs/verification/2026-09-09-sif-traffic-regression-repair.md`（仅实施时创建并填写实际结果）

**Interfaces:**
- Consumes: Tasks 1–3 实际提交、测试结果、最终集成候选 commit。
- Produces: 可重复执行的 `test:traffic-regression` 入口和来源 / 集成 / 构建 / 发布证据清单。

- [ ] 添加本地回归入口，精确包含生产投影、消费者与真实页面测试；缺少上述任一测试文件时命令必须失败：

```json
"test:traffic-regression": "node --test tests/scripts/sync-stage-output.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs && tsx --conditions=react-server --test tests/agent/traffic-detail-view.test.ts tests/agent/runtime-analysis-data.test.ts tests/agent/stage-output-browser.test.ts tests/agent/traffic-snapshot-browser.test.ts tests/agent/traffic-display-regression.test.tsx"
```

- [ ] 在开发分支运行以下完整检查，保存命令、退出码、测试数量与失败数量。已有 lint / type 问题分别与相同基线对比，不以历史记录代替本次检查。

```powershell
npm run test:traffic-regression
npx --no-install tsx --conditions=react-server --test tests/agent/asin-sync-session.test.ts tests/agent/stage-output-route.test.ts tests/agent/traffic-snapshot-read-route.test.ts
npx --no-install eslint scripts/lib/sync-stage-output.mjs app/lib/stage-output-view.ts app/lib/traffic-detail-view.ts app/lib/traffic-snapshot-browser.ts app/sif-listing-traffic-data.ts app/page.tsx tests/scripts/sync-stage-output.test.mjs tests/agent/runtime-analysis-data.test.ts tests/agent/traffic-detail-view.test.ts tests/agent/traffic-snapshot-browser.test.ts tests/agent/traffic-display-regression.test.tsx
npx --no-install tsc --noEmit
npm run build
git diff --check
```

- [ ] 集成前与并行 owner 记录文件交集；选择性移植全部必需行为及测试，禁止只挑生产文件、只挑 UI 或覆盖其他窗口修改。
- [ ] 在最终集成候选的隔离工作树再运行上面同一套命令和构建。记录最终候选 HEAD；代码修复、测试、入口三者同时存在才算通过合并门槛。
- [ ] 验证报告必须逐项列出：三个旧提交的对应新实现；三组明细的行为证据；字段精度；无来源缓存拒绝；旧任务来源核验；开发 / 集成两套结果。将 VOC 事务与耗时列为本方案未处理。
- [ ] 未获得发布窗口授权时停在已验证候选，不操作正式服务。进入已授权窗口后只使用 `scripts/manage-formal-stack.ps1` 现有受控流程，不手工杀进程或重置目录。
- [ ] 发布后核对 supervisor 的实际 codeRoot / commit、构建与应用产物身份、健康接口及用户所用页面；再次确认三款明细和无额外分析任务。只有完成此步才能写“正式服务已修复”。
- [ ] 若发布验收失败，保留诊断证据，在授权范围内回到前一可验证构建；不恢复旧业务数据库或删除缓存。未发布时只撤回本次代码补丁。

## 当前完成边界

设计与计划修订已完成，用户已授权本地修复。执行顺序为 Task 1 → Task 2 → Task 3 → Task 4；每项实施后独立评审。正式集成与发布仍为独立授权门槛，不因本地检查通过而自动执行。
