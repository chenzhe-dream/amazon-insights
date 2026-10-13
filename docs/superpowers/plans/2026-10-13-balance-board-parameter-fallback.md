# 平衡板参数兜底与展开交互实施计划

> For agentic workers: use subagent-driven-development to implement the independently owned tasks and review each result.

**Goal:** 修复平衡板九个 ASIN 的 Sorftime 参数适配和评分保存，再提供价格策略及侧栏展开/收起。

**Architecture:** SellerSprite 已验证商品保持优先；Sorftime product_detail 的明确字段按字段映射并保存来源。评论分析与评分分别保留成功证据，报告身份、范围、内容哈希继续验证。界面沿用 React，实现折叠交互，不引入 Vue 或整个 Art Design Pro 框架。

**Tech Stack:** Node.js、React、TypeScript、PostgreSQL、现有 node:test 与 Vite 测试设施。

**UI Reference:** [Art Design Pro](https://github.com/Daymychen/art-design-pro)，参考侧栏收起后保留入口的交互，使用当前 React 组件实现。

## Global Constraints

- 唯一验收项目为平衡板 `9bb1f579-18dc-4d3c-95c7-6dced66d8f13`，ASIN 为 B07PX9Y715、B0BT9F1F72、B0CJV11YQF、B0BDL8DZXD、B00AAXD6X0、B013YPIVB2、B096WJQ7RR、B0G5GS3XGV、B0H8XB1X9S。
- 初始基线为 f3b331ae260d3a51048f6c7c89c2cf3f555152ce；交付前对齐正式工作区新增提交 f0d56484673dbcae209d5ff1915fbc45878a854b。候选工作区为本聊天已附属的 asin-remaining-gaps-repair，分支 codex/balance-board-parameter-fallback-20261013。
- 不修改正式数据库、共享生成缓存、旧报告或生产服务；不新建正式任务；正式发布由主窗口统一执行。
- 测试使用已获取公开响应的本地裁剪 fixture，不包含凭据，运行测试不调用供应商。
- 未知值、负数未知标记不变成零；包装尺寸不得冒充产品尺寸；评论数量不得冒充评论样本。
- 保留 SellerSprite 成功数据，Sorftime 结果保持 catalogSource=sorftime-fallback、synced=false。
- 新增 `catalogFieldSources?: Record<string, "sorftime">` 记录每个已验证映射字段的来源；没有来源记录的历史兜底继续按原有缺失规则展示。
- 变体主题和完整功能规格不从标题推断；缺少对应接口证据时保持未知。

### Task 1: 参数适配与费用未知值

**Files:** scripts/lib/sorftime-catalog-fallback.mjs、scripts/lib/sorftime-fba-fee-parse.mjs、scripts/lib/scoped-sorftime-evidence.mjs、scripts/lib/scoped-sorftime-fallbacks.mjs、必要的独立 normalizer；tests/scripts/sorftime-catalog-fallback.test.mjs、sorftime-fba-fee-parse.test.mjs、scoped-sorftime-module-fallback.test.mjs，以及裁剪 fixture。

**Produces:** `buildCatalogEntryFromSorftime` 继续返回 Product 兼容对象；明确字段保存 catalogFieldSources，品牌、卖家、配送、评分、评论数、上架日期、变体数量、类目、包装尺寸/重量按当前响应契约映射。listing_date 与 online_date 区分，仅经验证的 listing_date 用作上架日期。`-1` 费用/重量为明确未知标记，其它错误类型保持拒绝；有效报价不可被整个非关键字段拒绝。

- [x] 写回归：package_size_cm=["76.2,30.48,14.61"] 映射为包装厘米尺寸；is_fba=false、fba_fee=-1 保留商品和空费用；listing_date="2026-07-13"、online_date="null" 使用 listing_date；错误 ASIN 拒绝；未知字段不持久化；不覆盖 SellerSprite 主记录。
- [x] 运行 `node --test tests/scripts/sorftime-catalog-fallback.test.mjs tests/scripts/sorftime-fba-fee-parse.test.mjs`，记录实际断言失败。
- [x] 实现集中、白名单的 profile normalizer 并在当前消费者复用，保持真实来源与未知标记。
- [x] 原 FBA 展示测试仍查 app/page.tsx 导致基线 29/30；修正该测试定位到现有 competitor-overview.tsx，继续验证真实标签。
- [x] 重跑相关回归、diff 检查并仅提交本任务文件。

### Task 2: 评分与评论分析独立保留

**Files:** scripts/lib/sync-stage-output.mjs、scripts/run-asin-sync-job.mjs、server/db/postgres/sync-job-store.ts、server/db/postgres/project-display-version-store.ts 中实际需要的校验路径；tests/scripts/sync-stage-output.test.mjs、sync-stage-cohort-recovery.test.mjs、tests/agent/sync-stage-output-persistence.test.ts、project-display-version-store.test.ts。

**Produces:** reviews 保持固定 analysisByAsin/ratingByAsin 两个分支；非 ready 评论 ASIN 的有效评分可捕获并冻结，评论阶段仍 partial，评论分析缺口继续保留，评分缺口按其自己的证据判定；无效、错 ASIN、错 marketplace、错来源/哈希数据不可被放行。

- [x] 写回归：两个 scoped ASIN，一条评论 ready，一条评论缺失但评分 ready；断言评分仍保留两条且评论仅保留成功条目。
- [x] 运行 `node --test tests/scripts/sync-stage-output.test.mjs` 记录失败。
- [x] 修改捕获及下游校验，只允许同范围、有效评分的独立证据，不改变评论 ready 判定，不扩大其它阶段数据范围。
- [x] 检查 sibling/resume/publication guards 和 gapsFor；保存缺失评论的同时不为存在评分生成虚假评分缺口。
- [x] 运行受影响 script/agent 回归，覆盖身份、哈希、非法评分及未知值拒绝；仅提交本任务文件。
- [x] 补齐直接评分采集入口的响应身份校验；新采集结果绑定当前任务来源，兼容已有无 provenance 的成功缓存。

### Task 3: 来源展示、价格策略及侧栏折叠

**Files:** app/project-report-views/competitor-overview.tsx、app/catalog-source-status.tsx、app/page.tsx、相关布局 CSS、必要的独立小组件及 scoped browser harness。

**Consumes:** Task 1 的 catalogFieldSources 元数据，历史 Product 不含元数据时行为兼容。

- [x] 已验证 SellerSprite 参数保留展示；明确 Sorftime 字段可显示并标来源；缺失仍显示缺失，不能标 SellerSprite 已同步。
- [x] 价格策略行用一处展开/收起按钮控制九列，默认紧凑摘要（当前价），展开显示定价锚点、促销、折扣心理和依据；支持键盘及 aria-expanded，导出快照保留全文。
- [x] 侧栏参考 Art Design Pro 的交互：桌面收起成保留入口的图标栏，保留当前模块高亮和可展开按钮；子菜单与飞出栏定位跟随收起宽度；窄屏不遮挡主体；用户选择跨刷新保留。
- [x] 用本地 Vite harness 和 CUA 验证 toggle、键盘、布局及刷新保持；不要求连接 Chrome 才能验证候选界面。
- [x] 运行类型检查与必要的交互回归；仅提交本任务文件。
- [x] 复用现有 product_content 请求，按明确属性表保留规格，导出读取冻结的 Listing 规格；不增加素材请求、不从正文推断。
- [x] 重复图册采集仅保留同 ASIN、站点、Sorftime 来源和当前任务的规格，单独保留原始规格采集时间；响应站点不一致时拒绝。
- [x] 修复原图片行为测试的过期 fixture（外部运行目录、生成缓存位置及图片 URL 绑定），不修改生产 runtime 契约；六项行为测试通过。

### Task 4: 合并校验与交付

- [x] 根窗口审核每个任务 diff，并核对 source/marketplace/ASIN guards 与成功数据保护。
- [x] 回放四个实际 Sorftime 响应，确认无数组/未知负数 schema 拒绝、字段来源正确、未推断规格或主题。
- [x] 运行受影响测试、tsc --noEmit --incremental false、范围 lint、git diff --check 和生产构建。
- [x] 全分支独立审查，修正可操作问题，复测相应项目。
- [x] 更新验收记录，报告候选完成与正式未发布的边界，保留当前正式报告作发布后对照。
