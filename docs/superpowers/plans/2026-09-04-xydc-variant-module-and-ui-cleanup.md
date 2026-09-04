# 西柚变体模块替换与冗余入口清理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用西柚洞察 MCP 的真实父子体和商品页表现数据替换现有卖家精灵变体空模块，同时只移除“VOC 独立分析”和“高级 A+”两个冗余前端入口，不破坏自动分析、历史数据或其他 Provider 链路。

**Architecture:** Agent Worker 在 catalog 之后执行一个非阻断的西柚变体 enrichment，将经过 Zod 校验的父子体快照原子写入 `AGENT_DATA_ROOT/xydc-variants/`；Web 的既有授权 runtime GET 只读取当前项目 ASIN 对应缓存，React 小组件将同父体记录合并为紧凑行和右侧抽屉。西柚不加入全局 ConnectorId，也不从浏览器、GET 或渲染阶段调用 Provider。

**Tech Stack:** Node.js 22.13+、TypeScript 5.9、React 19、Zod 4、`@modelcontextprotocol/sdk`、tsx、Node test runner、Playwright。

## Global Constraints

- 仅在 `codex/feat-xydc-variant-module-20260904` 分支和对应隔离 worktree 实施。
- 不修改 Sorftime、SIF、SellerSprite、辅图 AI、管理员中心、共享历史、数据库 schema 或全局 `ConnectorId`。
- 不把 `XYDC_MCP_TOKEN` 写入 Git、前端 bundle、缓存、日志、错误正文或测试快照。
- Provider 调用只允许由 Agent Worker 的同步任务触发；页面刷新、runtime GET 和组件渲染必须保持只读。
- 自动测试只使用 fixture，不连接真实西柚、不消耗积分、不写正式业务数据。
- 不新增顶层同步 stage；西柚失败只使本模块显示 `partial`/`unavailable`，不得改变 catalog、VOC、关键词、图片或整个 job 的成功语义。
- 缓存只写 `AGENT_DATA_ROOT/xydc-variants/`，禁止生成或改写 `app/*.ts` 数据文件。
- 不伪造上架时间；`listingDate` 恒为 `null`，UI 固定显示“数据源未提供”。
- `productPageRatings` 只标注为“商品页当前评论数”，不得解释为子体独立评论数或评论占比。
- 不 push、不部署、不切换或重启正式服务、不发起真实业务 POST；完成代码和自动验证后再请求人工验收授权。

## File Map

- Create: `shared/xydc-variant-contract.ts` — 原始响应边界、标准化 family/child schema 和脱敏 reason code。
- Create: `scripts/lib/xydc-mcp-client.ts` — 仅开放 `get_asin_variations`、`get_asin_info` 的 MCP 客户端。
- Create: `scripts/lib/xydc-variant-cache.ts` — 24 小时缓存、恢复证据、原子替换和按请求 ASIN 读取。
- Create: `scripts/build-xydc-variant-data.ts` — 去重、20 个一批补详情、partial/旧缓存降级。
- Modify: `scripts/run-asin-sync-job.mjs` — catalog 后调用非阻断 enrichment。
- Modify: `package.json` — 新增 `variant:xydc:sync` 和 `variant:xydc:sync:force`。
- Modify: `app/lib/runtime-analysis-data.ts` — 给现有 snapshot 增加 `variants.families`。
- Modify: `app/lib/runtime-analysis-data-server.ts` — 授权和 ASIN 校验后读取 scoped JSON 缓存。
- Create: `app/xydc-variant-section.tsx` — 紧凑父体行、前三子体预览、排序和右侧抽屉。
- Modify: `app/page.tsx` — 注入新模块，移除旧变体模块和两个冗余入口。
- Modify: `app/comparison-layout.css` — 仅新增新小模块和抽屉样式；本次不扩大到历史 CSS 清理。
- Preserve: `app/listing-aplus-section.tsx`、Listing/A+/EBC/LQS schema、VOC service/route/history — 本变更不删除底层合同。
- Preserve: `app/variant-data.ts`、`app/variant-analysis-conclusion.ts` — 新页面不再消费，但本次不删除历史静态数据文件。
- Tests: `tests/scripts/xydc-mcp-client.test.ts`、`tests/scripts/xydc-variant-sync.test.ts`、`tests/scripts/asin-sync-job-postconditions.test.mjs`、`tests/agent/runtime-analysis-data.test.ts`、`tests/agent/xydc-variant-section.test.tsx`、`tests/agent/asin-sync-session.test.ts`、`tests/rendered-html.test.mjs`。

---

### Task 1: 增加可恢复、非阻断的西柚变体 enrichment

**Files:**
- Create: `shared/xydc-variant-contract.ts`
- Create: `scripts/lib/xydc-mcp-client.ts`
- Create: `scripts/lib/xydc-variant-cache.ts`
- Create: `scripts/build-xydc-variant-data.ts`
- Modify: `scripts/run-asin-sync-job.mjs:745-864`
- Modify: `package.json:41-45`
- Test: `tests/scripts/xydc-mcp-client.test.ts`
- Test: `tests/scripts/xydc-variant-sync.test.ts`
- Test: `tests/scripts/asin-sync-job-postconditions.test.mjs`

**Interfaces:**
- Input env: `XYDC_MCP_URL`（缺省 `https://mcp.xydc.com/mcp`）、`XYDC_MCP_TOKEN`、`XYDC_ASINS`、`XYDC_COUNTRY`、`XYDC_INFO_BATCH_SIZE`（缺省 20）、`FORCE_REFRESH`。
- Cache identity: `<dataRoot>/xydc-variants/<country>/<inputAsin>.json`。
- Output: `XydcVariantFamily`，状态只允许 `ready | partial | unavailable`；缓存来源只允许 `fresh | stale`。
- Orchestration: `runOptionalXydcVariantEnrichment()` 无论 Provider 命令成功还是失败都返回结果，不抛出导致主 job 失败。

- [ ] **Step 1: 写标准化合同和 RED 测试**

在 `shared/xydc-variant-contract.ts` 定义唯一标准化合同，Provider 原始响应只能经显式字段投影进入该合同：

```ts
import { z } from "zod";

export const XydcVariantAttributeSchema = z.strictObject({
  dimension: z.string().min(1),
  value: z.string().min(1),
});

export const XydcVariantChildSchema = z.strictObject({
  asin: z.string().regex(/^[A-Z0-9]{10}$/),
  attributes: z.array(XydcVariantAttributeSchema),
  title: z.string().min(1).nullable(),
  imageUrl: z.string().url().nullable(),
  price: z.number().nonnegative().nullable(),
  currency: z.string().min(1).nullable(),
  stars: z.number().min(0).max(5).nullable(),
  productPageRatings: z.number().int().nonnegative().nullable(),
  listingDate: z.null(),
  infoStatus: z.enum(["ready", "pending", "unavailable"]),
});

export const XydcVariantFamilySchema = z.strictObject({
  inputAsin: z.string().regex(/^[A-Z0-9]{10}$/),
  country: z.string().min(2).max(8),
  parentAsin: z.string().regex(/^[A-Z0-9]{10}$/),
  dimensions: z.array(z.string().min(1)),
  children: z.array(XydcVariantChildSchema),
  sourceUpdatedAt: z.string().min(1).nullable(),
  fetchedAt: z.string().datetime(),
  status: z.enum(["ready", "partial", "unavailable"]),
  reasonCode: z.enum([
    "NOT_CONFIGURED", "AUTH_FAILED", "TIMEOUT", "RPC_ERROR",
    "SCHEMA_INVALID", "NOT_FOUND", "PARTIAL_CHILD_INFO",
  ]).nullable(),
  cacheState: z.enum(["fresh", "stale"]),
});

export type XydcVariantFamily = z.infer<typeof XydcVariantFamilySchema>;
```

在 `tests/scripts/xydc-variant-sync.test.ts` 先断言：输入子 ASIN 可得到真实父 ASIN；子体和维度去重；数字字符串转成 number；`listingDate === null`；原始响应中的未知字段和 Provider body 不进入标准化结果。

- [ ] **Step 2: Run RED**

Run:

```powershell
npx tsx --test tests/scripts/xydc-variant-sync.test.ts
```

Expected: FAIL，报错为模块尚不存在。

- [ ] **Step 3: 实现受限 MCP 客户端并测试脱敏边界**

在 `scripts/lib/xydc-mcp-client.ts` 导出受限入口，拒绝名单外工具，并把 SDK、超时和 transport 创建留作依赖注入：

```ts
const ALLOWED_TOOLS = new Set(["get_asin_variations", "get_asin_info"]);

export function xydcRequestHeaders(token: string) {
  if (!token.trim()) throw new XydcProviderError("NOT_CONFIGURED");
  return Object.freeze({ Authorization: `Bearer ${token.trim()}` });
}

export async function callXydcTool(
  token: string,
  toolName: "get_asin_variations" | "get_asin_info",
  args: Readonly<Record<string, unknown>>,
  options: XydcClientOptions = {},
) {
  if (!ALLOWED_TOOLS.has(toolName)) throw new XydcProviderError("RPC_ERROR");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)])
    : AbortSignal.timeout(options.timeoutMs ?? 15_000);
  return options.callTool
    ? await options.callTool({ toolName, args, headers: xydcRequestHeaders(token), signal })
    : await callWithSdkTransport({ token, toolName, args, signal, env: options.env });
}
```

`XydcProviderError` 只能保存稳定 `reasonCode`，不得保存 token、Authorization header 或原始 body。`tests/scripts/xydc-mcp-client.test.ts` 覆盖：Bearer header、缺 token、超时、RPC error、schema-invalid、名单外工具，以及 `JSON.stringify(error)` 不包含测试 token/Provider body。

- [ ] **Step 4: Run client RED/GREEN**

Run:

```powershell
npx tsx --test tests/scripts/xydc-mcp-client.test.ts
```

Expected: PASS；测试全程使用注入的 `callTool`，网络调用次数为 0。

- [ ] **Step 5: 实现 24 小时 scoped cache 和 Windows 原子替换**

在 `scripts/lib/xydc-variant-cache.ts`：

```ts
export function xydcVariantCachePath(dataRoot: string, country: string, inputAsin: string) {
  const safeCountry = country.trim().toUpperCase();
  const safeAsin = inputAsin.trim().toUpperCase();
  if (!/^[A-Z]{2,8}$/.test(safeCountry) || !/^[A-Z0-9]{10}$/.test(safeAsin)) {
    throw new Error("Invalid Xiyou variant cache identity");
  }
  return path.join(path.resolve(dataRoot), "xydc-variants", safeCountry, `${safeAsin}.json`);
}

export function isFreshXydcVariantCache(family: XydcVariantFamily, now: Date, maxAgeMs = 86_400_000) {
  return family.status === "ready"
    && now.getTime() - Date.parse(family.fetchedAt) <= maxAgeMs;
}
```

写入使用同目录唯一临时文件、`wx`、`fsync`、rename，并仅对 Windows 的 `EPERM/EACCES/EBUSY` 做 `[10,20,40,80,160]ms` 有界重试。最终 rename 失败时删除临时文件但保留旧 target 原样。测试用临时目录和注入 file ops 验证旧缓存不丢失。

生产调用方用 `resolveRuntimeRoots({ codeRoot: getProjectRoot(), formal: Boolean(process.env.AGENT_FORMAL_WORKTREE_ROOT), env: process.env })` 获取 `dataRoot`；不得用当前工作目录拼接正式数据路径。

- [ ] **Step 6: 实现批量 enrichment、partial 和恢复证据**

在 `scripts/build-xydc-variant-data.ts` 导出纯编排函数：

```ts
export async function syncXydcVariantFamilies(input: SyncXydcVariantInput) {
  const batchSize = boundedBatchSize(input.batchSize ?? 20);
  const cached = await input.cache.readMany(input.country, input.asins);
  const pending = input.asins.filter(asin => input.force || !isFreshXydcVariantCache(cached[asin], input.now));
  const drafts = await collectVariationDrafts(pending, input);
  const unresolved = uniqueChildAsins(drafts).filter(asin => !hasReadyChildInfo(drafts, cached, asin));
  for (const batch of chunk(unresolved, batchSize)) {
    await hydrateAndCheckpointBatch(batch, drafts, cached, input);
  }
  return await finalizeAndPersistFamilies(input.asins, drafts, cached, input);
}
```

实现要求：

- 每个待同步输入 ASIN 调一次 `get_asin_variations`；同父体在输出层合并，不重复展示。
- 全局子 ASIN 去重后，`get_asin_info` 每批最多 20 个。
- 每批成功后立即 checkpoint 已就绪的 child；Worker resume 只请求 `pending/unavailable` child，不重复已成功批次。
- `partial` cache 中已校验的父子关系也是可恢复证据；24 小时内的 resume 不重复 `get_asin_variations`，只补未完成的 child info。只有关系证据缺失、过期或 force 才重新请求 variations。
- 部分批次失败时保留可用 child 并写 `partial/PARTIAL_CHILD_INFO`。
- Provider 失败且有旧成功缓存时返回旧 family、原 `fetchedAt/sourceUpdatedAt` 和 `cacheState: "stale"`；无旧缓存则写 `unavailable` 安全状态。
- 未配置 token 时不建立 transport，直接写 `unavailable/NOT_CONFIGURED`。

在 `tests/scripts/xydc-variant-sync.test.ts` 覆盖 21 个 child 形成 `20+1` 两批、第二批失败为 partial、再次执行的 variations 调用为 0 且只请求未完成 child、24 小时 cache hit 零调用、force refresh 会调用、同父体合并、单品 family、旧缓存降级。

- [ ] **Step 7: Run sync GREEN**

Run:

```powershell
npx tsx --test tests/scripts/xydc-mcp-client.test.ts tests/scripts/xydc-variant-sync.test.ts
```

Expected: PASS；fixture 断言 Provider 总调用次数与分批完全一致。

- [ ] **Step 8: 把 enrichment 接到 catalog 后且保持非阻断**

在 `package.json` 增加：

```json
"variant:xydc:sync": "tsx ./scripts/build-xydc-variant-data.ts",
"variant:xydc:sync:force": "tsx ./scripts/build-xydc-variant-data.ts --force"
```

在 `scripts/run-asin-sync-job.mjs` 导出并调用：

```js
export function runOptionalXydcVariantEnrichment({ asins, marketplace, run = tryRunProviderCommand }) {
  const result = run("variant:xydc:sync", "npm", ["run", "variant:xydc:sync"], {
    XYDC_ASINS: asins.join(","),
    XYDC_COUNTRY: marketplace,
  });
  return Object.freeze({ succeeded: Boolean(result?.succeeded) });
}
```

调用点必须在 catalog 已执行或已按缓存完成之后、`const needing = asinsNeedingMcpSync(asins)` 之前。它不走 `createJobProviderController`，不写全局 degraded connector，也不抛出改变主 job 状态。

在 `tests/scripts/asin-sync-job-postconditions.test.mjs` 增加编排 fixture：catalog 有待处理、catalog 已缓存两条路径都恰好调用一次西柚；西柚 command 返回失败时后续 stage fixture 仍执行；源代码顺序断言 catalog < XiYou < keywords。

- [ ] **Step 9: Run Task 1 全部验证**

Run:

```powershell
npx tsx --test tests/scripts/xydc-mcp-client.test.ts tests/scripts/xydc-variant-sync.test.ts
node --test tests/scripts/asin-sync-job-postconditions.test.mjs
npx eslint shared/xydc-variant-contract.ts scripts/lib/xydc-mcp-client.ts scripts/lib/xydc-variant-cache.ts scripts/build-xydc-variant-data.ts scripts/run-asin-sync-job.mjs tests/scripts/xydc-mcp-client.test.ts tests/scripts/xydc-variant-sync.test.ts tests/scripts/asin-sync-job-postconditions.test.mjs
```

Expected: 全部 PASS；无真实网络请求；`git status --short` 不出现 `app/*.ts` 生成数据和 `data/` 业务文件。

- [ ] **Step 10: Commit Task 1**

```powershell
git add -- shared/xydc-variant-contract.ts scripts/lib/xydc-mcp-client.ts scripts/lib/xydc-variant-cache.ts scripts/build-xydc-variant-data.ts scripts/run-asin-sync-job.mjs package.json tests/scripts/xydc-mcp-client.test.ts tests/scripts/xydc-variant-sync.test.ts tests/scripts/asin-sync-job-postconditions.test.mjs
git commit -m "feat(xydc): add cached variant enrichment"
```

---

### Task 2: 通过授权 runtime GET 渲染紧凑变体模块

**Files:**
- Modify: `app/lib/runtime-analysis-data.ts:5-19`
- Modify: `app/lib/runtime-analysis-data-server.ts:17-76`
- Create: `app/xydc-variant-section.tsx`
- Modify: `app/page.tsx:16,1946,2208-2250,3485-3523`
- Modify: `app/comparison-layout.css:4-8,37-38`
- Test: `tests/agent/runtime-analysis-data.test.ts`
- Test: `tests/agent/xydc-variant-section.test.tsx`

**Interfaces:**
- Runtime payload adds `variants: { families: XydcVariantFamily[] }`，不改变其他字段。
- 授权后的 project marketplace 是 cache country 的唯一来源；客户端 query 不能自行选择 cache country。
- `XydcVariantSection` props: `products`、`families`、`market`；组件内部只做展示和排序，不 fetch。
- 同父体 family 按 `country + parentAsin` 分组；一个分组记录全部命中的输入 ASIN。

- [ ] **Step 1: 写 runtime snapshot RED**

更新 `tests/agent/runtime-analysis-data.test.ts` 的 fixture，让每个合法 snapshot 都显式包含 `variants: { families: [] }`，并新增：

```ts
test("runtime snapshot returns only variant families bound to requested input ASINs", async () => {
  const snapshot = readGeneratedRuntimeAnalysisData(asins, "US", {
    readVariantFamilies: (requested, country) => requested.map(inputAsin => familyFixture(inputAsin, country)),
  });
  assert.deepEqual(snapshot.variants.families.map(item => item.inputAsin), asins);
  assert.equal(snapshot.variants.families.some(item => item.inputAsin === "B0OUTSIDE01"), false);
});
```

保留并复用现有 401/404 转发、project ASIN mismatch 409、cookie 只向 Agent GET 转发的测试，确保 cache reader 只在授权和 scope 校验通过后调用。再断言 handler 传给 reader 的 country 来自 `project.marketplace`，而不是 URL query。

- [ ] **Step 2: Run runtime RED**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/runtime-analysis-data.test.ts
```

Expected: FAIL，因为 snapshot schema 尚无 `variants` 且 reader 尚未注入。

- [ ] **Step 3: 扩展 runtime 合同和 scoped reader**

在 `app/lib/runtime-analysis-data.ts` 增加带旧响应兼容默认值的字段：

```ts
variants: z.strictObject({ families: z.array(XydcVariantFamilySchema) })
  .default({ families: [] }),
```

同时增加一条旧 payload 不含 `variants` 时解析为 `{ families: [] }` 的回归，避免旧历史或旧测试快照失效。

把 `readGeneratedRuntimeAnalysisData` 改成可注入 reader，但生产默认值只读取 `AGENT_DATA_ROOT`：

```ts
export function readGeneratedRuntimeAnalysisData(
  asins: readonly string[],
  country: string,
  overrides: {
    readVariantFamilies?: (asins: readonly string[], country: string) => XydcVariantFamily[];
  } = {},
): RuntimeAnalysisDataSnapshot {
  const readVariantFamilies = overrides.readVariantFamilies ?? readScopedXydcVariantFamilies;
  const requestedSet = new Set(asins);
  const catalog = requestedCatalog.filter(item => {
    const asin = item && typeof item === "object" && !Array.isArray(item)
      ? (item as { asin?: unknown }).asin
      : null;
    return typeof asin === "string" && requestedSet.has(asin);
  });
  return RuntimeAnalysisDataSnapshotSchema.parse({
    catalog,
    keywords: stageData("keywords"),
    reviews: stageData("reviews"),
    salesTrend: stageData("sales_trend"),
    fba: stageData("fba"),
    listing: stageData("listing"),
    category: stageData("category"),
    childSales: stageData("child_sales"),
    priceStrategy: stageData("price_strategy"),
    imageRemarks: stageData("image_remarks"),
    variants: { families: readVariantFamilies(asins, country) },
  });
}
```

`RuntimeAnalysisDataDependencies.readSnapshot` 同步改为 `(asins, country)`；handler 完成 project 授权和 ASIN 集合校验后调用 `readSnapshot(parsed.data.asins, project.data.project.marketplace)`。现有直接调用生产 reader 的测试改为 `readGeneratedRuntimeAnalysisData(requested, "US")`。`readScopedXydcVariantFamilies` 必须逐个请求 ASIN 计算文件名、校验 JSON 中 `inputAsin` 等于文件身份，忽略非法/越界记录，不扫描其他项目目录，不返回 token、路径或原始 Provider 内容。

- [ ] **Step 4: Run runtime GREEN**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/runtime-analysis-data.test.ts
```

Expected: PASS，包括 409 时 reader 调用次数仍为 0。

- [ ] **Step 5: 写紧凑组件的静态与交互 RED**

在 `tests/agent/xydc-variant-section.test.tsx` 使用 `renderToStaticMarkup` 和一个本地 Vite/Playwright fixture，断言：

- 同父体的两个输入 ASIN 只形成一行，行内显示两个命中 ASIN。
- 默认只出现 3 个 child preview 和“查看全部 28”。
- 每个 child 显示属性、价格、评分、“商品页当前评论数”，不出现“独立评论数/评论占比”。
- 固定出现“上架时间：数据源未提供”和评论共享口径提示。
- `partial` 显示可用 children 和明确缺口；`unavailable` 显示原因而不是空白大卡片；`stale` 显示“缓存数据”与原更新时间。
- 单品 family 显示“单一商品/未发现其他变体”。
- 点击“查看全部”打开 `role="dialog"` 右侧抽屉，展示全部 child；Escape 和关闭按钮都关闭。
- 切换商品页评论数、价格、评分排序只改变抽屉顺序，绝无上架时间排序。
- 浏览器 fixture 拦截所有非 loopback 请求并断言为 0，证明组件不调用 Provider。

- [ ] **Step 6: Run component RED**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/xydc-variant-section.test.tsx
```

Expected: FAIL，因为组件尚不存在。

- [ ] **Step 7: 实现紧凑组件**

`app/xydc-variant-section.tsx` 的分组函数保持纯函数：

```ts
export function groupXydcVariantFamilies(families: readonly XydcVariantFamily[]) {
  const groups = new Map<string, XydcVariantFamily[]>();
  for (const family of families) {
    const key = `${family.country}:${family.parentAsin}`;
    groups.set(key, [...(groups.get(key) ?? []), family]);
  }
  return [...groups.values()].map(mergeVariantFamilyGroup);
}
```

渲染边界：每组一行；左侧竞品/父体摘要，中间维度 chips，右侧最多三张 child 卡；`children.length > 3` 才显示查看全部按钮。抽屉使用 button、`role="dialog"`、`aria-modal="true"`、Escape 关闭和 body portal，避免撑高原模块区域。

- [ ] **Step 8: 在 overview 中替换旧模块，不保留静态假数据 fallback**

在 `app/page.tsx`：

- 删除 `sellerSpriteVariantData/sellerSpriteVariantMeta`、`buildVariantAnalysisConclusion` import、`VariantSort` state 以及只服务旧模块的 `sortedVariants`、`VariantShareStructure`、`VariantDetailTable`、`VariantSummary`、`VariantPortfolioSummary` 调用链。
- 将参数表仍使用的 `variationTheme(product)` 改为只从 `product.format` 和 `product.variantDetails` 推导，不再读取旧卖家精灵变体 fixture。
- 从 `runtimeAnalysisData?.variants.families ?? []` 取新数据。
- 在原 `variant-section` 位置只渲染：

```tsx
<XydcVariantSection
  products={products.map(product => ({
    asin: product.asin,
    brand: product.brand,
    title: product.title,
    image: product.image,
  }))}
  families={runtimeAnalysisData?.variants.families ?? []}
  market={markets[market]}
/>
```

- 不从 `app/variant-data.ts` 回退，不渲染演示父体、子体或上架时间。

在 `app/comparison-layout.css` 只增加 `.xydc-variant-*` 和抽屉响应式样式，不删除旧选择器；主模块高度由内容自然决定，默认三行竞品保持紧凑。

- [ ] **Step 9: Run Task 2 GREEN**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/runtime-analysis-data.test.ts tests/agent/xydc-variant-section.test.tsx
npx eslint app/lib/runtime-analysis-data.ts app/lib/runtime-analysis-data-server.ts app/xydc-variant-section.tsx app/page.tsx tests/agent/runtime-analysis-data.test.ts tests/agent/xydc-variant-section.test.tsx
```

Expected: PASS；Playwright fixture 的非 loopback 请求为 0；页面源码不再引用 `sellerSpriteVariantData`。

- [ ] **Step 10: Commit Task 2**

```powershell
git add -- app/lib/runtime-analysis-data.ts app/lib/runtime-analysis-data-server.ts app/xydc-variant-section.tsx app/page.tsx app/comparison-layout.css tests/agent/runtime-analysis-data.test.ts tests/agent/xydc-variant-section.test.tsx
git commit -m "feat(variants): render compact xiyou variant module"
```

---

### Task 3: 移除两个冗余 UI 入口并证明底层能力未被删除

**Files:**
- Modify: `app/page.tsx:73,90-97,1969,2173,2637,2877-2916,3556-3578,3610-3622`
- Preserve: `app/listing-aplus-section.tsx`
- Preserve: `app/lib/voc-readiness.ts`
- Modify: `tests/agent/asin-sync-session.test.ts:410-455`
- Modify: `tests/rendered-html.test.mjs`
- Test: existing VOC route/service/history and Listing runtime contracts

**Interfaces:**
- UI 不再提供 `overview-aplus` tab，也不再渲染“VOC 独立分析”卡片。
- 旧书签中的 `?tab=overview-aplus` 由 `tabFromParam` 安全回落到 `overview`，不得形成空白页面。
- Manual Alexa VOC 导入、自动 VOC run 状态恢复、VOC 报告查询、历史记录和 Listing/A+/EBC/LQS 数据 schema 均保持原合同。

- [ ] **Step 1: 写入口消失但底层合同保留的 RED**

在 `tests/rendered-html.test.mjs` 增加源码/构建产物断言：导航中无“高级 A+”，页面无“VOC 独立分析”和“开始 VOC 独立分析”，但仍包含“Alexa 七问 · 快速录入”和 VOC 核心主题入口。

在 `tests/agent/asin-sync-session.test.ts` 移除对 `.listing-aplus-matrix` 可见性的依赖，改为断言 listing stage output 仍被 GET、snapshot 能解析其 `hasAplus/hasEbc/hasVideo/lqs` 字段，同时页面没有 A+ tab。保留该测试原有 `calls.posts === 0`，证明轮询仍只 GET。

- [ ] **Step 2: Run UI cleanup RED**

Run:

```powershell
node --test tests/rendered-html.test.mjs
npx tsx --conditions=react-server --test tests/agent/asin-sync-session.test.ts
```

Expected: 新增的“入口不存在”断言 FAIL。

- [ ] **Step 3: 最小删除 UI，保留服务和数据文件**

在 `app/page.tsx`：

- 从 `overview-group.children` 删除 `{ id: "overview-aplus" }`。
- 从 `TabId`、`tabFromParam` 和 overview family 判断中删除 `overview-aplus`；旧 URL 因此自动走既有默认 `overview`。
- 删除 `activeTab === "overview-aplus"` 渲染分支和 `ListingAplusSection` import，但不删除 `app/listing-aplus-section.tsx` 或 listing 数据字段。
- 删除“VOC 独立分析”`launch-block`。
- 仅当确认无其他调用时，删除只服务该按钮的 `runVocAnalysis`、`vocStartInFlight`、`vocReadinessPresentation`、`submitReadyVocRun`、`presentVocReadiness`、`summarizeVocReadiness` import。
- 保留 `waitForVocRun`、现有 VOC run 恢复 effect、Manual Alexa import、报告查询和历史恢复代码。

不要删除 `app/lib/voc-readiness.ts` 及其测试，因为其提交前校验仍可被自动 VOC 流程和后续消费者复用。

- [ ] **Step 4: 跑定向兼容回归**

Run:

```powershell
node --test tests/rendered-html.test.mjs
npx tsx --conditions=react-server --test tests/agent/asin-sync-session.test.ts tests/agent/voc-readiness.test.ts tests/agent/voc-run-browser.test.ts tests/agent/saved-analysis-reports.test.ts tests/agent/runtime-analysis-data.test.ts
```

Expected: 全部 PASS；页面无两个冗余入口；VOC 导入、自动运行状态、历史报告和 Listing snapshot 仍通过。

- [ ] **Step 5: 运行 changed-file lint**

Run:

```powershell
npx eslint app/page.tsx tests/rendered-html.test.mjs tests/agent/asin-sync-session.test.ts
```

Expected: lint PASS；CSS 和完整类型由 Final Verification 中唯一一次 production build 校验，禁止改 ESLint 配置绕过。

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- app/page.tsx tests/rendered-html.test.mjs tests/agent/asin-sync-session.test.ts
git commit -m "refactor(ui): remove redundant voc and a-plus entries"
```

---

## Final Verification

- [ ] **Step 1: 运行全部受影响自动测试**

```powershell
npx tsx --test tests/scripts/xydc-mcp-client.test.ts tests/scripts/xydc-variant-sync.test.ts
node --test tests/scripts/asin-sync-job-postconditions.test.mjs tests/rendered-html.test.mjs
npx tsx --conditions=react-server --test tests/agent/runtime-analysis-data.test.ts tests/agent/xydc-variant-section.test.tsx tests/agent/asin-sync-session.test.ts tests/agent/voc-readiness.test.ts tests/agent/voc-run-browser.test.ts tests/agent/saved-analysis-reports.test.ts
```

Expected: 全部 PASS，无 skipped 的本功能用例。

- [ ] **Step 2: 扫描越界改动和 secret 泄露**

```powershell
git diff --check 3e4d5943f9331a22cac250d9dfc7b0008ce3f90c...HEAD
git diff --name-only 3e4d5943f9331a22cac250d9dfc7b0008ce3f90c...HEAD
rg -n 'Bearer\s+[A-Za-z0-9._~-]{16,}' shared scripts app tests
git grep -n 'XYDC_MCP_TOKEN=' -- ':!docs/**'
git status --short
```

Expected: 只出现 File Map 内文件和两份批准文档；secret 扫描无真实值；无 `data/`、`.runtime/`、生成数据或其他 WIP。

- [ ] **Step 3: 运行一次最终 build**

```powershell
npm run build
```

Expected: production build PASS，构建期间不调用西柚或其他 Provider。

- [ ] **Step 4: 独立代码审查**

审查重点：Provider 是否只从 Worker 触发；cache identity 是否严格绑定 country+inputAsin；partial/resume 是否避免重复批次；runtime GET 是否先授权后读文件；UI 是否没有伪造上架时间或独立评论语义；两个入口删除是否误伤自动 VOC/历史/Listing 合同。Important 以上问题必须返修后才能进入候选。

- [ ] **Step 5: 人工验收前停机点**

只回报三个 commit、自动测试、build 和审查结果。不得启动正式服务或真实同步。等待用户单独批准候选受控启动后，再用一个全新无缓存 ASIN 组进行人工验收：一次同步、刷新零 Provider 调用、抽屉完整、partial 明确、两个入口消失且历史正常。
