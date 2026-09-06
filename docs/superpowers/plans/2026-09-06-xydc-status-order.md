# 西柚展示语义微调 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this task with TDD and independent review.

**Goal:** 让变体状态、竞品顺序及时间/原因说明与实际数据一致。

**Architecture:** 在既有 client component 内完成展示映射与行排序，不改变共享缓存合同或父子分组算法。SSR 与交互渲染共用相同呈现逻辑。

**Tech Stack:** React、TypeScript、Node test、Playwright、Vite。

## Global Constraints

- 仅展示变更；不改 Provider、缓存内容、同步状态合同、数据库、权限、VOC、历史记录或 app/page.tsx。
- 保留 14px 正文、12px 辅助文字、72px 图片、桌面 1:3 布局、三子体预览、抽屉排序规则。
- 上架时间始终“数据源未提供”，评论数保持“商品页当前评论数”，不暗示独立变体评论。
- 测试用隔离 fixture，不调用真实 Provider、不访问正式业务接口；不重启、不部署、不推送。

## Task 1: 展示状态、输入顺序与时间来源

**Files:**
- Modify: `app/xydc-variant-section.tsx`
- Optional scoped styles: `app/comparison-layout.css`
- Test: `tests/agent/xydc-variant-section.test.tsx`

**Interfaces:** Consumes existing products/families/market props; outputs unchanged public component API. `groupXydcVariantFamilies` remains deterministic and preserves existing merge semantics.

- [x] **Step 1: Isolate and baseline.** 新分支 `codex/fix-xydc-status-order-20260906` 已建立于非正式补丁工作树，基线测试 14/14。
- [ ] **Step 2: RED.** 在已有 fixture 增加下列行为断言；先运行确认语义失败而非环境错误。

```ts
const waiting = [{ ...products[0]!, brand: "等待同步", title: "等待卖家精灵与 SIF MCP 返回商品数据" }];
const html = await renderSection([familyFixture(inputAsins[0]!)], waiting);
assert.match(html, /变体数据可用/);
assert.match(html, /品牌资料待补充/);
assert.doesNotMatch(html, /等待同步|等待卖家精灵/);
```

另外：以 products=[B000000002,B000000001] 配合反序父体键验证行序和代表竞品；同父体命中两输入时验证 Brand 2 与命中顺序，不重复生成组；所有原因码中文；pending/unavailable 中文；主行与抽屉 null source time 不得回填采集时间。更新旧测试的英文原因断言和抽屉“更新时间”断言为新的精确语义，不删除旧覆盖。

Run: `node --test --import tsx tests/agent/xydc-variant-section.test.tsx`

- [ ] **Step 3: Minimal implementation.** 在组件中加入纯展示映射：

```ts
const variantStatusLabels = {
  ready: "变体数据可用",
  partial: "部分变体数据可用",
  unavailable: "变体数据暂不可用",
};
const variantReasonLabels = {
  NOT_CONFIGURED: "西柚数据源未配置",
  AUTH_FAILED: "西柚数据源认证失败",
  TIMEOUT: "西柚请求超时",
  RPC_ERROR: "西柚服务暂不可用",
  SCHEMA_INVALID: "数据源返回格式异常",
  NOT_FOUND: "数据源未返回该商品变体",
  PARTIAL_CHILD_INFO: "部分子体详情暂未返回",
};
```

在 SectionBody 的展示边界建立 Map<ASIN,index>，复制后按最早命中索引排序 groups，fallback country:parentAsin；命中 ASIN 与代表 product 也使用输入顺序，禁止修改传入数组。目录占位和空值只在此组件映射，真实品牌/标题保留。使用同一小型时间说明组件，在主行及抽屉显示 sourceUpdatedAt 与 fetchedAt 两行；不得用 `sourceUpdatedAt ?? fetchedAt`。时间原值用 React 文本渲染，保持未知上架时间说明。中文原因和 child status 映射不改变 family status。

- [ ] **Step 4: GREEN and review.** 上述全文件测试通过后，报告 RED/GREEN，提交仅涉及代码与测试。主审核执行 HTML 测试、定向 lint、生产 build，独立审查代码。

```powershell
node --test --import tsx tests/agent/xydc-variant-section.test.tsx
node --test tests/rendered-html.test.mjs
npx eslint app/xydc-variant-section.tsx tests/agent/xydc-variant-section.test.tsx
npm run build
git diff --check
```

- [ ] **Step 5: Deliver.** 保存验证记录和 commit；不合入正式分支、不切换服务。用户下一步可看本地 fixture 预览，再明确安排受控更新。
