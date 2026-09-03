# VOC Runtime and Stage Output Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make VOC state truthful, gate VOC submission on complete Manual Alexa input, show ASIN-level partial gaps, and refresh generated analysis data in the running Web process without rebuilds or page reload loops.

**Architecture:** Keep PostgreSQL run/stage state authoritative for execution state, and add one authenticated, project-scoped Web read endpoint for the generated runtime projections that are otherwise frozen in the production bundle. The browser loads that snapshot on workspace hydration and once after sync convergence, then merges real stage output over the snapshot. Manual Alexa remains the required VOC source in this slice.

**Tech Stack:** TypeScript, React, Next/Vinext route handlers, Zod contracts, Node test runner, PostgreSQL-backed Agent APIs.

## Global Constraints

- 不新建分析任务，不自动重试 Provider，不更改 SellerSprite/SIF/Sorftime 合同。
- 不把 Sorftime 自动替代 Manual Alexa；该能力另设切片。
- 运行时接口必须复用现有认证，普通用户只能读取自身可访问项目；不得返回 cookie、token、凭据、原始 Alexa 报告或文件系统路径。
- 保留当前 15 个 generated app 文件与项目 JSON WIP，不纳入功能提交。
- 基础同步 `runId` 不得恢复成 VOC 任务。
- 请求失败时保留当前已验证数据并显示一次中文提示，不清空页面、不循环刷新。
- `done` stage 的权威 output 优先于运行时生成快照；`partial` stage 使用生成快照中的成功子集，同时保留 ASIN 级缺口提示。
- traffic 继续使用既有 PostgreSQL snapshot 接口。

---

### Task 1: Truthful VOC Run Classification

**Files:**
- Modify: `app/lib/voc-run-browser.ts:18-125`
- Test: `tests/agent/voc-run-browser.test.ts`

**Interfaces:**
- Consumes: `observeVocRun(runId: string, fetchImpl?: BrowserFetch)`.
- Produces: `VocRunObservation.kind` including `"not-started"`; only real `queued | running` VOC stages return `"active"`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a sync-only run without voc-positioning is not started and never active", async () => {
  const observed = await observeVocRun(runId, async (input) => String(input).endsWith("/reports")
    ? Response.json({ reports: [] })
    : Response.json({ stages: [{ stage: "traffic-analysis", status: "partial" }] }));
  assert.equal(observed.kind, "not-started");
  assert.equal(observed.stage, null);
});

test("a succeeded VOC stage without a persisted report is failed, not active", async () => {
  const observed = await observeVocRun(runId, async (input) => String(input).endsWith("/reports")
    ? Response.json({ reports: [] })
    : Response.json({ stages: [{ stage: "voc-positioning", status: "succeeded" }] }));
  assert.equal(observed.kind, "failed");
  assert.match(observed.message, /报告/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-run-browser.test.ts`

Expected: the missing-stage case reports `active`, and the succeeded-without-report case does not return the required terminal failure.

- [ ] **Step 3: Implement the bounded state mapping**

```ts
export type VocRunObservation = {
  kind: "not-started" | "active" | "waiting-input" | "failed" | "succeeded" | "offline";
  runId: string | null;
  stage: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
  reports: Array<Record<string, unknown>>;
  message: string;
};

const kind: VocRunObservation["kind"] = report
  ? "succeeded"
  : !stage
    ? "not-started"
    : status === "queued" || status === "running"
      ? "active"
      : status === "waiting-input"
        ? "waiting-input"
        : "failed";
const message = kind === "not-started"
  ? "VOC 分析尚未开始"
  : kind === "succeeded"
    ? "VOC 报告已保存"
    : status === "succeeded"
      ? "VOC 阶段已结束，但报告未生成"
      : `VOC 阶段：${status}`;
```

- [ ] **Step 4: Run GREEN and regression tests**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-run-browser.test.ts tests/agent/local-data-bridge.test.ts`

Expected: all selected tests pass; no POST appears in the missing-stage test.

- [ ] **Step 5: Commit Task 1**

```bash
git add app/lib/voc-run-browser.ts tests/agent/voc-run-browser.test.ts
git commit -m "fix(voc): stop restoring absent stages as active"
```

---

### Task 2: Manual VOC Readiness Gate and Chinese Errors

**Files:**
- Create: `app/lib/voc-readiness.ts`
- Modify: `app/page.tsx:1990-2010,2630-2700,3315-3345`
- Modify: `app/api/alexa-voc/import/route.ts:76-84`
- Create: `tests/agent/voc-readiness.test.ts`
- Modify: `tests/agent/alexa-voc-mutation-routes.test.ts`

**Interfaces:**
- Consumes: current ASINs and `manualVoc.effectiveVocByAsin`.
- Produces: `summarizeVocReadiness(asins, records): { ready: number; total: number; missing: string[]; canSubmit: boolean }`.
- Produces: `submitReadyVocRun(asins, marketplace, records, submit): Promise<{ projectId: string; runId: string }>`; the callback is never invoked before full readiness.

- [ ] **Step 1: Write readiness and no-submit RED tests**

```ts
test("VOC readiness requires one normalized record for every requested ASIN", () => {
  assert.deepEqual(summarizeVocReadiness(["B000000001", "B000000002", "B000000003"], {
    B000000001: { normalizedRecord: {} },
    B000000003: { normalizedRecord: {} },
  }), {
    ready: 2,
    total: 3,
    missing: ["B000000002"],
    canSubmit: false,
  });
});
```

```ts
test("incomplete VOC readiness never invokes the submission callback", async () => {
  let calls = 0;
  await assert.rejects(() => submitReadyVocRun(
    ["B000000001", "B000000002", "B000000003"],
    "US",
    { B000000001: { normalizedRecord: {} }, B000000003: { normalizedRecord: {} } },
    async () => { calls += 1; return { projectId: runId, runId }; },
  ), /尚未录入/);
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-readiness.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/primary-admin-page.test.ts`

Expected: `summarizeVocReadiness` is missing and the current button is enabled when records are absent.

- [ ] **Step 3: Add the pure readiness helper**

```ts
type ManualVocRecordMap = Readonly<Record<string, { normalizedRecord?: unknown } | null | undefined>>;

export function summarizeVocReadiness(asins: readonly string[], records: ManualVocRecordMap) {
  const scope = [...new Set(asins.map(asin => asin.trim().toUpperCase()).filter(Boolean))];
  const missing = scope.filter(asin => !records[asin]?.normalizedRecord);
  return Object.freeze({
    ready: scope.length - missing.length,
    total: scope.length,
    missing: Object.freeze(missing),
    canSubmit: scope.length >= 3 && missing.length === 0,
  });
}

export async function submitReadyVocRun(
  asins: readonly string[],
  marketplace: string,
  records: ManualVocRecordMap,
  submit: (asins: string[], marketplace: string) => Promise<{ projectId: string; runId: string }>,
) {
  const readiness = summarizeVocReadiness(asins, records);
  if (!readiness.canSubmit) throw new Error(`以下 ASIN 尚未录入 Manual Alexa VOC：${readiness.missing.join("、")}`);
  return submit([...asins], marketplace);
}
```

- [ ] **Step 4: Wire the page gate and Chinese response**

```tsx
const vocReadiness = useMemo(
  () => summarizeVocReadiness(activeAsins, manualVoc.effectiveVocByAsin),
  [activeAsins, manualVoc.effectiveVocByAsin],
);

<p>VOC 数据已准备 {vocReadiness.ready}/{vocReadiness.total}</p>
{vocReadiness.missing.length ? <p>待录入：{vocReadiness.missing.join("、")}</p> : null}
<button
  type="button"
  className="primary-btn"
  disabled={!vocReadiness.canSubmit || vocRun?.kind === "active"}
  onClick={() => void runVocAnalysis()}
>
  {vocRun?.kind === "active" ? "VOC 分析运行中…" : "开始 VOC 独立分析"}
</button>
```

Make `runVocAnalysis` call `submitReadyVocRun(activeAsins, market, manualVoc.effectiveVocByAsin, submitVocRun)` so the callback cannot be reached when readiness is incomplete. Convert that error to a Chinese `waiting-input` observation. Change the disabled route error to:

```ts
return Response.json({ error: "Manual Alexa VOC 录入功能暂未启用，请联系管理员" }, { status: 503 });
```

- [ ] **Step 5: Run GREEN and commit Task 2**

Run: `npx tsx --conditions=react-server --test tests/agent/voc-readiness.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/primary-admin-page.test.ts`

Expected: all selected tests pass and incomplete readiness produces zero submission calls.

```bash
git add app/lib/voc-readiness.ts app/page.tsx app/api/alexa-voc/import/route.ts tests/agent/voc-readiness.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/primary-admin-page.test.ts
git commit -m "fix(voc): gate analysis on complete manual input"
```

---

### Task 3: Authenticated Runtime Analysis Snapshot

**Files:**
- Create: `app/lib/runtime-analysis-data.ts`
- Create: `app/lib/runtime-analysis-data-server.ts`
- Create: `app/api/runtime-analysis-data/route.ts`
- Modify: `app/page.tsx:1850-2070,3165-3180`
- Create: `tests/agent/runtime-analysis-data.test.ts`
- Modify: `tests/agent/primary-admin-browser.test.ts`
- Modify: `tests/agent/helpers/primary-admin-browser-harness.tsx`

**Interfaces:**
- Consumes: `GET /api/runtime-analysis-data?projectId=<uuid>&asins=<comma-list>` with the current session cookie.
- Produces: `RuntimeAnalysisDataSnapshot` containing only the authorized project's requested ASIN data and `catalog`, `keywords`, `reviews`, `salesTrend`, `fba`, `listing`, `category` projections.

- [ ] **Step 1: Write route and browser RED tests**

```ts
test("runtime snapshot preserves project authorization and filters the requested ASINs", async () => {
  const readSnapshot = (asins: readonly string[]) => ({
    catalog: asins.map(asin => ({ asin })),
    keywords: { analysisByAsin: {}, enrichmentByKeyword: {} },
    reviews: { analysisByAsin: { [asins[0]!]: { status: "ready" } }, ratingByAsin: {} },
    salesTrend: { trendByAsin: {} },
    fba: { feeByAsin: { [asins[0]!]: { status: "ready" } } },
    listing: { contentByAsin: {} },
    category: { trendByNode: {} },
  });
  const handler = createRuntimeAnalysisDataHandler({
    client: async () => ({ status: 200, headers: new Headers(), body: {
      project: { id: projectId, organizationId, name: "test", marketplace: "US", asins },
    } }),
    readSnapshot,
  });
  const result = await handler(new Request(
    `http://app.local/api/runtime-analysis-data?projectId=${projectId}&asins=${asins.join(",")}`,
    { headers: { cookie: "session=opaque" } },
  ));
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.deepEqual(body.catalog.map((item: { asin: string }) => item.asin), asins);
  assert.equal(JSON.stringify(body).includes("formal-stack.env"), false);
  assert.equal(JSON.stringify(body).includes("cookie"), false);
});

for (const upstreamStatus of [401, 404] as const) {
  test(`runtime snapshot preserves upstream ${upstreamStatus}`, async () => {
    const handler = createRuntimeAnalysisDataHandler({
      client: async () => ({ status: upstreamStatus, headers: new Headers(), body: { error: "denied" } }),
      readSnapshot: () => { throw new Error("must not read files"); },
    });
    const result = await handler(new Request(
      `http://app.local/api/runtime-analysis-data?projectId=${projectId}&asins=${asins.join(",")}`,
    ));
    assert.equal(result.status, upstreamStatus);
  });
}

test("runtime snapshot rejects an ASIN scope mismatch before reading files", async () => {
  let reads = 0;
  const handler = createRuntimeAnalysisDataHandler({
    client: async () => ({ status: 200, headers: new Headers(), body: {
      project: { id: projectId, organizationId, name: "test", marketplace: "US", asins },
    } }),
    readSnapshot: () => { reads += 1; throw new Error("unexpected"); },
  });
  const result = await handler(new Request(
    `http://app.local/api/runtime-analysis-data?projectId=${projectId}&asins=B000000004,B000000005,B000000006`,
  ));
  assert.equal(result.status, 409);
  assert.equal(reads, 0);
});
```

```ts
let runtimeReads = 0;
let navigations = 0;
let observedJob = runningJob;
page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations += 1; });
await page.route(`**/v1/local-data/sync-asins/${jobId}`, route =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(observedJob) }),
);
await page.route("**/api/runtime-analysis-data**", route => {
  runtimeReads += 1;
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshot) });
});
const navigationsBeforeTerminal = navigations;
observedJob = terminalJob;
await page.getByText("评论数据 2/3").waitFor();
await page.getByText("$4.25").waitFor();
assert.equal(runtimeReads, 1);
assert.equal(navigations, navigationsBeforeTerminal);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/runtime-analysis-data.test.ts tests/agent/primary-admin-browser.test.ts`

Expected: the route/module is missing and the page does not request the runtime snapshot.

- [ ] **Step 3: Implement the project-scoped server handler**

Define the shared browser/server contract in `app/lib/runtime-analysis-data.ts`:

```ts
import { z } from "zod";

const map = z.record(z.string(), z.unknown());
export const RuntimeAnalysisDataSnapshotSchema = z.strictObject({
  catalog: z.array(z.unknown()),
  keywords: z.strictObject({ analysisByAsin: map, enrichmentByKeyword: map }),
  reviews: z.strictObject({ analysisByAsin: map, ratingByAsin: map }),
  salesTrend: z.strictObject({ trendByAsin: map }),
  fba: z.strictObject({ feeByAsin: map }),
  listing: z.strictObject({ contentByAsin: map }),
  category: z.strictObject({ trendByNode: map }),
});
export type RuntimeAnalysisDataSnapshot = z.infer<typeof RuntimeAnalysisDataSnapshotSchema>;
```

Define the server dependencies explicitly:

```ts
type RuntimeAnalysisDataDependencies = Readonly<{
  client: AgentServiceClient;
  readSnapshot: (asins: readonly string[]) => RuntimeAnalysisDataSnapshot;
}>;
```

Define bounded query and ownership helpers in the server module:

```ts
const RuntimeAnalysisDataQuerySchema = z.strictObject({
  projectId: EntityIdSchema,
  asins: z.array(AsinSchema).min(3).max(10).refine(values => new Set(values).size === values.length),
});

function parseRuntimeQuery(url: URL) {
  return {
    projectId: url.searchParams.get("projectId"),
    asins: (url.searchParams.get("asins") ?? "").split(",").map(value => value.trim().toUpperCase()).filter(Boolean),
  };
}

function forwardSessionHeaders(request: Request) {
  const headers = new Headers({ origin: new URL(request.url).origin });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

function sameAsinSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && [...left].sort().every((asin, index) => asin === [...right].sort()[index]);
}
```

```ts
export function createRuntimeAnalysisDataHandler(dependencies: RuntimeAnalysisDataDependencies) {
  return async function GET(request: Request) {
    const parsed = RuntimeAnalysisDataQuerySchema.safeParse(parseRuntimeQuery(new URL(request.url)));
    if (!parsed.success) return Response.json({ error: "运行时数据请求无效" }, { status: 400 });
    const projectResult = await dependencies.client({
      method: "GET",
      path: `/v1/projects/${parsed.data.projectId}`,
      headers: forwardSessionHeaders(request),
    });
    if (projectResult.status !== 200) {
      return Response.json(projectResult.body, { status: projectResult.status });
    }
    const project = GetProjectResponseSchema.safeParse(projectResult.body);
    if (!project.success) return Response.json({ error: "项目数据暂不可用" }, { status: 502 });
    if (!sameAsinSet(project.data.project.asins, parsed.data.asins)) {
      return Response.json({ error: "当前项目与 ASIN 范围不匹配" }, { status: 409 });
    }
    return Response.json(dependencies.readSnapshot(parsed.data.asins));
  };
}
```

Use `projectStageOutput(stage, asins, { stageStatus: "done" })` only as the existing bounded generated-file reader. Copy only each projection's `data`; never return its source path.

In `app/api/runtime-analysis-data/route.ts`, bind production dependencies explicitly:

```ts
export const GET = createRuntimeAnalysisDataHandler({
  client: createAgentServiceClient(),
  readSnapshot: readGeneratedRuntimeAnalysisData,
});
```

- [ ] **Step 4: Implement one-shot browser loading and precedence**

```ts
export async function readRuntimeAnalysisData(
  projectId: string,
  asins: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeAnalysisDataSnapshot> {
  const query = new URLSearchParams({ projectId, asins: asins.join(",") });
  const response = await fetchImpl(`/api/runtime-analysis-data?${query}`);
  const payload = await response.json();
  if (!response.ok) throw new Error("最新分析数据暂未刷新，页面已保留现有结果");
  return RuntimeAnalysisDataSnapshotSchema.parse(payload);
}
```

Store the response in `runtimeAnalysisData`. Call the loader once after workspace hydration and once inside `onSyncComplete`; update `catalogItems` from its catalog and pass its module maps as the fallbacks to `buildStageOutputView`. Keep the existing `stageOutputSnapshot` merge last so real `done` stage output wins.

- [ ] **Step 5: Run GREEN and commit Task 3**

Run: `npx tsx --conditions=react-server --test tests/agent/runtime-analysis-data.test.ts tests/agent/stage-output-browser.test.ts tests/agent/primary-admin-browser.test.ts`

Expected: all selected tests pass; exactly one refresh occurs after terminal convergence; no reload loop occurs.

```bash
git add app/lib/runtime-analysis-data.ts app/lib/runtime-analysis-data-server.ts app/api/runtime-analysis-data/route.ts app/page.tsx tests/agent/runtime-analysis-data.test.ts tests/agent/primary-admin-browser.test.ts tests/agent/helpers/primary-admin-browser-harness.tsx
git commit -m "feat(web): refresh generated analysis data at runtime"
```

---

### Task 4: ASIN-Level Partial Gap Notice

**Files:**
- Create: `app/stage-output-gap-notice.tsx`
- Modify: `app/page.tsx:3185-3200,3395-3410`
- Create: `tests/agent/stage-output-gap-notice.test.tsx`
- Modify: `tests/agent/helpers/asin-sync-funnel-browser-harness.tsx`

**Interfaces:**
- Consumes: `stage`, requested `asins`, module records after runtime refresh, and the stage projection.
- Produces: a compact notice such as `评论数据 2/3；B0CSYXYWDZ 连接失败` while leaving successful rows visible.

- [ ] **Step 1: Write compact partial RED tests**

```ts
const html = JSON.stringify(StageOutputGapNotice({
  label: "评论数据",
  asins: ["B000000001", "B000000002", "B000000003"],
  records: {
    B000000001: { status: "ready" },
    B000000002: { status: "error" },
    B000000003: { status: "ready" },
  },
  reasonCode: "CONNECTOR_FAILED",
}));
assert.match(html, /评论数据 2\/3/);
assert.match(html, /B000000002/);
assert.match(html, /连接失败/);
assert.doesNotMatch(html, /当前页面保留已验证数据；此状态不代表模块成功/);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/stage-output-gap-notice.test.tsx`

Expected: `StageOutputGapNotice` does not exist.

- [ ] **Step 3: Implement the bounded notice**

```tsx
type Props = Readonly<{
  label: "评论数据" | "FBA 费用";
  asins: readonly string[];
  records: Readonly<Record<string, Readonly<{ status?: unknown }> | undefined>>;
  reasonCode: "CONNECT_TIMEOUT" | "UPSTREAM_EMPTY" | "CONNECTOR_FAILED" | "OUTPUT_UNAVAILABLE";
}>;

const reasonCopy = {
  CONNECT_TIMEOUT: "连接超时",
  UPSTREAM_EMPTY: "上游暂无记录",
  CONNECTOR_FAILED: "连接失败",
  OUTPUT_UNAVAILABLE: "结果暂不可用",
} as const;

export function StageOutputGapNotice({ label, asins, records, reasonCode }: Props) {
  const ready = asins.filter(asin => records[asin]?.status === "ready");
  const missing = asins.filter(asin => records[asin]?.status !== "ready");
  if (!missing.length) return null;
  return (
    <p className="stage-output-gap-notice" role="status">
      <strong>{label} {ready.length}/{asins.length}</strong>
      <span>{missing.join("、")} {reasonCopy[reasonCode]}</span>
    </p>
  );
}
```

Replace only the overview/VOC review and FBA full cards with this notice. Keep other stage gap cards unchanged in this slice.

- [ ] **Step 4: Run GREEN and commit Task 4**

Run: `npx tsx --conditions=react-server --test tests/agent/stage-output-gap-notice.test.tsx tests/agent/stage-output-gap-card.test.tsx tests/agent/primary-admin-page.test.ts`

Expected: all selected tests pass and successful ASIN rows remain present.

```bash
git add app/stage-output-gap-notice.tsx app/page.tsx tests/agent/stage-output-gap-notice.test.tsx tests/agent/helpers/asin-sync-funnel-browser-harness.tsx tests/agent/primary-admin-page.test.ts
git commit -m "fix(web): show partial gaps per ASIN"
```

---

### Task 5: Integrated Verification, Protected Configuration, and Controlled Deployment

**Files:**
- Do not stage: the 15 generated `app/*.ts` files and `data/projects/ae7c9926-fba6-4d50-9afe-87d9a0fd638a.json`

**Interfaces:**
- Consumes: Tasks 1-4 commits, protected `.runtime/formal-stack.env`, migrations through `0019_manual_alexa_voc.sql` or later.
- Produces: one reviewed deployment candidate and a manual-acceptance-ready page; no analysis POST is made during deployment.

- [ ] **Step 1: Run affected verification**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/voc-run-browser.test.ts tests/agent/voc-readiness.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/runtime-analysis-data.test.ts tests/agent/stage-output-browser.test.ts tests/agent/stage-output-gap-card.test.tsx tests/agent/stage-output-gap-notice.test.tsx tests/agent/primary-admin-page.test.ts tests/agent/primary-admin-browser.test.ts
npx eslint app/lib/voc-run-browser.ts app/lib/voc-readiness.ts app/lib/runtime-analysis-data.ts app/lib/runtime-analysis-data-server.ts app/api/runtime-analysis-data/route.ts app/stage-output-gap-notice.tsx app/api/alexa-voc/import/route.ts
npm run build
git diff --check
```

Expected: focused tests pass, changed-file lint exits 0, production build succeeds, diff-check exits 0.

- [ ] **Step 2: Independent review gate**

Review only Critical or direct blockers for: cross-project reads, missing-stage false-active, incomplete VOC POST, runtime refresh loops, secret/path leakage, loss of successful partial data, or staging generated WIP. Critical/direct blockers must be zero.

- [ ] **Step 3: Configure Manual Alexa according to the existing rollout runbook**

Before changing flags, verify PostgreSQL migration `0019` or later and `active job/stage/attempt/run = 0`. Generate the 32-byte KEK inside the protected operator process, persist only the JSON keyring in protected `formal-stack.env`, and never print it. Follow the documented order: keyring → write → publication prerequisites/worker → UI → dynamic read. Keep legacy fallback disabled. If publication prerequisites cannot be met, stop with UI disabled rather than weakening the runbook.

Required non-secret flag values after the rollout gate:

```text
AGENT_MANUAL_ALEXA_VOC_WRITE_ENABLED=1
AGENT_MANUAL_ALEXA_VOC_PUBLICATION_ENABLED=1
MANUAL_ALEXA_VOC_UI_ENABLED=1
AGENT_MANUAL_ALEXA_VOC_DYNAMIC_READ_ENABLED=1
AGENT_MANUAL_ALEXA_VOC_LEGACY_FALLBACK_ENABLED=0
```

- [ ] **Step 4: Controlled restart and read-only smoke**

Run the existing manager against the exact integration candidate and protected runtime root. Verify Web `31900`, Agent `31901`, PostgreSQL `58258`, port `3000` absent, served SHA exact, migration current, `fake=0`, single supervisor, active counts zero, and generated WIP unchanged. Then perform only authenticated GET checks for session, runtime snapshot, and Manual VOC list; no Provider, sync, VOC submission, retry, or browser click.

- [ ] **Step 5: Final acceptance handoff**

Report `READY_FOR_MANUAL_VOC_ACCEPTANCE`. The user may then import one Manual Alexa report per ASIN. Verify `0/3 → 1/3 → 3/3`; only at `3/3` may the user make one VOC submission. Monitor that one run to a real `voc-positioning` terminal stage and persisted report. Do not create a replacement run after failure.
