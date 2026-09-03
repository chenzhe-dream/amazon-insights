# 图片 AI 备注自动运行实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 在 Traffic 到达终态后自动分析全部有效静态主图和辅图，以全局并发 4、单图总超时 120 秒、0 自动重试运行，并保证图片失败不阻断核心分析。

**架构：** 复用现有 `image_remarks` 阶段、图片队列、OpenAI 兼容适配器、资源治理器和构建发布链。生成器输出不含图片地址的安全进度事件，生产运行器流式读取并更新现有 stage detail；图片队列结束后按既有逐 ASIN 状态聚合，再进入构建发布。

**技术栈：** Node.js ESM、TypeScript/React、Node test runner、Playwright 浏览器 harness、现有 PostgreSQL resource governor、OpenSpec。

## 全局约束

- 只在 `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\image-remarks-auto-run` / `codex/image-remarks-auto-run` 实施，基线为 `1a68a47c5abb3a005c959334876c135a1497118c`，设计提交为 `5345797eb04dca5dd132c6c2c0c4d13090bb32e9`。
- 不触碰 live `stabilize-resumable-sync-pipeline`、PostgreSQL、Web/Agent 服务和其 28 项运行 WIP；实现阶段禁止部署、真实图片模型请求、浏览器业务 POST、新 job/run/stage 和 push。
- 分析全部有效静态图册槽位，不设数量上限；视频缩略图跳过；已有同槽位非空备注复用。
- 全任务全局最多 4 个图片请求；单图有效总截止时间固定 `120_000` ms；每图最多 1 次真实调用；0 自动重试。
- `image_remarks` 只在 Traffic 全部终态后自动运行，结束后才进入 build/publication；图片 partial 不得降低已经完成的核心模块。
- 不新增数据库迁移、第二套任务生命周期、Provider、依赖或 ASIN 特例；SellerSprite、Sorftime、SIF、Alexa、认证和项目身份行为不变。
- 密钥、基础地址、图片 URL、请求头、请求体、Provider 响应体不得进入进度事件、错误文案、日志或持久化诊断。

---

### Task 1：固定队列并发、总超时与安全逐图进度

**文件：**
- 修改：`scripts/lib/image-remark-queue.mjs:1-68`
- 修改：`scripts/lib/image-remark-request.mjs:1-74`
- 修改：`scripts/build-listing-image-remarks.mjs:1-223`
- 测试：`tests/scripts/image-remarks-concurrency.test.mjs`
- 测试：`tests/scripts/image-remark-request.test.mjs`
- 测试：`tests/scripts/build-listing-image-remarks-source.test.mjs`

**接口：**
- 输入：`runImageRemarkQueue(items, worker, options)`；现有 `governExternalRequest()`；现有图册槽位任务 `{ asin, slotIndex, url }`。
- 输出：`IMAGE_REMARK_CONCURRENCY = 4`、`IMAGE_REMARK_TIMEOUT_MS = 120_000`、`DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS = 120_000`；新增可选 `onSettled(event)`，事件仅包含 `{ completed, total, status }`。
- 供 Task 2 消费：标准输出行 `IMAGE_REMARK_PROGRESS {"completed":n,"total":m,"status":"ready|upstream-empty|timeout|connector-failed"}`。

- [ ] **Step 1：新增队列与请求超时 RED。**

在现有测试中加入以下行为断言：

```js
assert.equal(IMAGE_REMARK_CONCURRENCY, 4);
assert.equal(IMAGE_REMARK_TIMEOUT_MS, 120_000);
assert.equal(DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS, 120_000);

let active = 0;
let peak = 0;
const settled = [];
await runImageRemarkQueue([0, 1, 2, 3, 4, 5], async () => {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise(resolve => setTimeout(resolve, 10));
  active -= 1;
  return { status: "ready" };
}, { onSettled: event => settled.push(event) });
assert.equal(peak, 4);
assert.deepEqual(settled.map(item => item.completed), [1, 2, 3, 4, 5, 6]);
assert.equal(settled.every(item => item.total === 6), true);
```

- [ ] **Step 2：运行 RED。**

运行：

```powershell
node --test tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/image-remark-request.test.mjs
```

预期：因当前常量仍为 `2 / 90_000 / 20_000` 且没有 `onSettled` 事件而失败；不得因 fixture 或计时器未清理失败。

- [ ] **Step 3：实现最小队列 GREEN。**

将队列常量、固定文案和回调实现为：

```js
export const IMAGE_REMARK_CONCURRENCY = 4;
export const IMAGE_REMARK_TIMEOUT_MS = 120_000;

function timeoutResult() {
  return { status: "timeout", reason: "图片分析超过 120 秒" };
}

export async function runImageRemarkQueue(items, worker, {
  concurrency = IMAGE_REMARK_CONCURRENCY,
  timeoutMs = IMAGE_REMARK_TIMEOUT_MS,
  onSettled = () => undefined,
  resourceGovernor,
  requireResourceGovernor,
  organizationId,
  jobId,
  env = process.env,
} = {}) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(IMAGE_REMARK_CONCURRENCY, Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await runOne(items[index], worker, timeoutMs, {
        resourceGovernor, requireResourceGovernor, organizationId, jobId, env,
      });
      completed += 1;
      await onSettled(Object.freeze({
        completed,
        total: items.length,
        status: results[index]?.status ?? "upstream-empty",
      }));
    }
  }));
  return results;
}
```

同时把请求默认值改成：

```js
export const DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS = 120_000;
```

- [ ] **Step 4：让生成器输出安全进度并保持全图/缓存行为。**

调用队列时传入：

```js
const imageResults = await runImageRemarkQueue(imageTasks, async (task, { signal }) => {
  const result = await analyzeWithOpenAI(task.url, task.slotIndex, task.asin, signal);
  if (!result?.remark) return { status: "upstream-empty" };
  remarks[task.asin][task.slotIndex] = result;
  analyzed += 1;
  return { status: "ready" };
}, {
  timeoutMs: imageRemarkRequestTimeoutMs(),
  onSettled: ({ completed, total, status }) => {
    console.log(`IMAGE_REMARK_PROGRESS ${JSON.stringify({ completed, total, status })}`);
  },
});
```

保留现有 `gallery.length` 全量循环、视频跳过、已有非空备注跳过和 `--force` 手工行为。进度 JSON 不得包含 ASIN、slot、URL、模型、响应或错误正文。

- [ ] **Step 5：运行 GREEN 与安全源检查。**

运行：

```powershell
node --test tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/image-remark-request.test.mjs tests/scripts/build-listing-image-remarks-source.test.mjs
```

预期：全部通过；新增源测试证明进度事件只有 `completed/total/status`，视频与已有备注不进入任务队列。

- [ ] **Step 6：提交 Task 1。**

```powershell
git add scripts/lib/image-remark-queue.mjs scripts/lib/image-remark-request.mjs scripts/build-listing-image-remarks.mjs tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/image-remark-request.test.mjs tests/scripts/build-listing-image-remarks-source.test.mjs
git commit -m "feat: bound automatic image remark queue"
```

---

### Task 2：接入生产自动阶段并流式投影进度

**文件：**
- 新增：`scripts/lib/image-remark-process.mjs`
- 修改：`scripts/run-asin-sync-job.mjs:1-176, 812-858`
- 测试：`tests/scripts/image-remark-process.test.mjs`
- 测试：`tests/scripts/asin-sync-job-postconditions.test.mjs`
- 测试：`tests/scripts/sync-pipeline-ordering.test.mjs`
- 测试：`tests/agent/sync-job-production-main-resume.test.ts`

**接口：**
- 输入：Task 1 的 `IMAGE_REMARK_PROGRESS` 行；`readImageRemarkStatuses()`；现有 `setStage()`、`patchSyncJob()`、`applyPersistedStagePostcondition()`。
- 输出：`parseImageRemarkProgress(line)` 和 `runImageRemarkProcess(options): Promise<{ succeeded: boolean; exitCode: number | null }>`。
- 供 Task 3 消费：运行中 stage detail 固定为 `图片 AI 备注：已完成 n/m 张`；终态继续使用权威 per-ASIN module status。

- [ ] **Step 1：新增子进程协议 RED。**

测试安全解析和 0 重试：

```js
assert.deepEqual(
  parseImageRemarkProgress('IMAGE_REMARK_PROGRESS {"completed":3,"total":20,"status":"ready"}'),
  { completed: 3, total: 20, status: "ready" },
);
assert.equal(parseImageRemarkProgress('IMAGE_REMARK_PROGRESS {"completed":3,"total":20,"status":"ready","url":"secret"}'), null);

const progress = [];
const result = await runImageRemarkProcess({
  command: process.execPath,
  args: [fixturePath],
  cwd: fixtureRoot,
  env: {},
  onProgress: event => progress.push(event),
});
assert.equal(result.succeeded, true);
assert.deepEqual(progress.map(item => item.completed), [1, 2]);
assert.equal(spawnCount, 1);
```

- [ ] **Step 2：运行子进程与生产顺序 RED。**

运行：

```powershell
node --test tests/scripts/image-remark-process.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs
```

预期：缺少 helper；现有 runner 仍在 build 后调用 `markImageRemarksDisabledForRelease()`，所以自动执行和顺序断言失败。

- [ ] **Step 3：实现严格、安全、单次的流式子进程 helper。**

核心接口必须完整验证字段并只启动一个子进程：

```js
const PROGRESS_PREFIX = "IMAGE_REMARK_PROGRESS ";
const ALLOWED_STATUS = new Set(["ready", "upstream-empty", "timeout", "connector-failed"]);

export function parseImageRemarkProgress(line) {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(PROGRESS_PREFIX.length));
    if (Object.keys(value).sort().join(",") !== "completed,status,total") return null;
    if (!Number.isSafeInteger(value.completed) || !Number.isSafeInteger(value.total)) return null;
    if (value.completed < 0 || value.total < 0 || value.completed > value.total) return null;
    if (!ALLOWED_STATUS.has(value.status)) return null;
    return Object.freeze({ completed: value.completed, total: value.total, status: value.status });
  } catch {
    return null;
  }
}
```

`runImageRemarkProcess()` 使用 `spawn`、逐行读取 stdout、把合法进度交给 `onProgress`，stderr/非进度 stdout 交给调用方的脱敏输出回调；子进程关闭后只返回一次 exit 结果，不重启、不重试。

- [ ] **Step 4：用自动图片阶段替换发布停用逻辑。**

在 runner 中导入 `readImageRemarkStatuses` 和新 helper；删除主流程对 `markImageRemarksDisabledForRelease()` 的调用，并在 Traffic 处理之后、build 之前加入：

```js
if (shouldRunSyncStage(job, "image_remarks")) {
  activateStage(jobId, "image_remarks");
  patchSyncJob(jobId, { message: "正在自动生成图片 AI 备注…" });
  const imageProcess = await runImageRemarkProcess({
    command: "npm",
    args: ["run", "image-remarks:sync"],
    cwd: root,
    env: {
      ...process.env,
      REMARK_ASINS: asins.join(","),
      AGENT_SYNC_JOB_ID: jobId,
      AGENT_SYNC_STAGE_ID: "image_remarks",
      AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED: "1",
    },
    onProgress: ({ completed, total }) => {
      setStage(jobId, "image_remarks", {
        status: "active",
        detail: `图片 AI 备注：已完成 ${completed}/${total} 张`,
      });
    },
    onOutput: text => process.stdout.write(sanitizeCommandOutput(text)),
  });
  applyPersistedStagePostcondition(jobId, "image_remarks", asins, {
    commandSucceeded: imageProcess.succeeded,
    resultStatusesByAsin: readImageRemarkStatuses(),
    unavailableReason: imageProcess.succeeded ? null : "图片 AI 备注存在明确缺口",
  });
}
```

在进入该块之前测试 `trafficIsTerminalBeforeImageRemarks()` 对所有 ASIN 均成立；图片结束后才允许现有 build/publication 代码执行。图片进程非零退出只产生 `partial`/逐 ASIN 缺口，不调用 `failSyncJob()`，除非发生现有任务存储或发布完整性错误。

- [ ] **Step 5：补生产恢复与无重复调用测试。**

测试以下合同：初次运行只启动一次图片子进程；Traffic 非终态时图片启动次数为 0；已有 ready 备注由生成器复用；图片进程非零时核心模块仍 ready、最终 job 为 `completed-with-gaps`；refresh/普通 terminal GET 不启动子进程；显式 category/traffic resume 不把 `image_remarks` 偷渡进 `resumeStages`。

运行：

```powershell
node --test tests/scripts/image-remark-process.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs
npx tsx --conditions=react-server --test --test-name-pattern="image remarks|production main" tests/agent/sync-job-production-main-resume.test.ts
```

预期：全部通过，并证明图片调用次数严格为 1 个子进程、每图物理请求由 Task 1/资源治理测试限制。

- [ ] **Step 6：提交 Task 2。**

```powershell
git add scripts/lib/image-remark-process.mjs scripts/run-asin-sync-job.mjs tests/scripts/image-remark-process.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs tests/agent/sync-job-production-main-resume.test.ts
git commit -m "feat: run image AI remarks after traffic"
```

---

### Task 3：恢复自动进度展示并完成候选门禁

**文件：**
- 修改：`app/lib/sync-progress-presentation.ts:45-190`
- 修改：`app/asin-sync-funnel.tsx:590-730`
- 测试：`tests/agent/asin-sync-session.test.ts:1080-1260`
- 测试：`tests/agent/listing-images-section.test.tsx`

**接口：**
- 输入：Task 2 的自动 `image_remarks` stage、`stage.detail` 安全计数和逐 ASIN module status。
- 输出：`presentSyncProgress()` 把图片阶段视为 `automatic`，显示运行计数、终态 partial 缺口和刷新恢复状态；原始 gallery 始终独立展示。

- [ ] **Step 1：新增页面 RED。**

把原“已停用”断言改为自动行为，并新增：

```ts
const imageRow = page.getByTestId("sync-stage-image_remarks");
assert.equal(await imageRow.getByText("图片 AI 备注：已完成 3/20 张").count(), 1);
assert.equal(await imageRow.getByText("拉取中").count(), 1);
assert.equal(await imageRow.getByText("已停用，待后续分析").count(), 0);
```

终态 fixture 断言 `partial` 显示“流程已结束 · 数据缺口”，gallery 图片数量不因缺少备注减少；刷新后的 GET fixture 不产生 POST。

- [ ] **Step 2：运行页面 RED。**

运行：

```powershell
npx tsx --conditions=react-server --test --test-name-pattern="image remarks|terminal disabled stages|refresh" tests/agent/asin-sync-session.test.ts
npx tsx --test tests/agent/listing-images-section.test.tsx
```

预期：第一条因 `presentStage()` 仍硬编码 `mode: "disabled"` 而失败；gallery 独立展示基线继续通过。

- [ ] **Step 3：删除图片阶段的 disabled 特例。**

保留 Alexa manual 分支，删除 `stage.id === "image_remarks"` 的 disabled 返回，让图片阶段进入现有 automatic 分支：

```ts
const terminalGap = stage.status === "partial" || stage.status === "skipped";
return {
  id: stage.id,
  label: stage.label,
  detail: stage.detail,
  status: stage.status,
  mode: "automatic",
  executionPercent: terminalGap ? 0 : automaticStagePercent(stage, now, terminal),
  statusCopy: terminalGap ? "流程已结束 · 数据缺口" : automaticStatusCopy(stage.status),
  finishAt: automaticStageFinishAt(stage),
};
```

同时让 `remainingAutomaticSeconds()` 不再排除 `image_remarks`，使全局剩余时间包含图片阶段；页面继续直接显示 `row.detail` 的安全图片计数。

- [ ] **Step 4：运行受影响回归与改动文件门禁。**

```powershell
node --test tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/image-remark-request.test.mjs tests/scripts/build-listing-image-remarks-source.test.mjs tests/scripts/image-remark-process.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs
npx tsx --conditions=react-server --test tests/agent/asin-sync-session.test.ts tests/agent/sync-job-production-main-resume.test.ts
npx tsx --test tests/agent/listing-images-section.test.tsx
npx eslint scripts/lib/image-remark-queue.mjs scripts/lib/image-remark-request.mjs scripts/lib/image-remark-process.mjs scripts/build-listing-image-remarks.mjs scripts/run-asin-sync-job.mjs app/lib/sync-progress-presentation.ts app/asin-sync-funnel.tsx tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/image-remark-request.test.mjs tests/scripts/build-listing-image-remarks-source.test.mjs tests/scripts/image-remark-process.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs tests/agent/asin-sync-session.test.ts tests/agent/sync-job-production-main-resume.test.ts tests/agent/listing-images-section.test.tsx
```

预期：测试全部通过；lint 对本次新增/改动行 0 error。若仓库已有未改行诊断，只允许记录精确基线差异，不得顺手扩大修复。

- [ ] **Step 5：执行唯一一次构建与规格门禁。**

```powershell
npm run build
npx openspec validate stabilize-resumable-sync-pipeline --strict
git diff --check 5345797eb04dca5dd132c6c2c0c4d13090bb32e9..HEAD
git status --short
git diff --cached --name-only
```

预期：生产构建成功；OpenSpec strict 有效；diff-check clean；没有生成业务数据、凭据或运行文件进入提交。

- [ ] **Step 6：提交 Task 3 并做限定复审。**

```powershell
git add app/lib/sync-progress-presentation.ts app/asin-sync-funnel.tsx tests/agent/asin-sync-session.test.ts tests/agent/listing-images-section.test.tsx
git commit -m "feat: present automatic image AI progress"
```

随后生成从 `5345797` 到候选 HEAD 的 review package，安排一次独立 whole-branch review。门禁只要求 `Critical = 0` 且当前合同直接业务阻断为 0；非阻断 Minor 和极端并发建议记录为 deferred。通过后停在 `READY_FOR_CONTROLLED_IMAGE_AI_DEPLOYMENT`，不得自行部署或调用真实模型。
