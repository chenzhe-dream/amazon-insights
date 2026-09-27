# HTML 快照一级导航与子页面实施计划

> **For agentic workers:** 用户 2026-09-27 已确认父子勾选含义并批准执行。使用 executing-plans / subagent-driven-development 按任务执行，每项先验证再提交；本次实施不包含正式发布。

**Goal:** 在一个 HTML 文件内还原原系统的六个一级导航和十个内容页面，按子页面切换阅读，预览和下载一致。

**Architecture:** 保留现有冻结来源、原页面展示组件和安全序列化。在导出入口增加页面级选择，将页面映射到既有八种数据来源；在净化后的业务正文外生成受控的导航外壳。页面切换仅使用本地 HTML/CSS，不挂载应用路由或访问分析接口。

**Tech Stack:** 现有 React/TypeScript、HTML 原生 radio 和 details/summary、作用域 CSS、SVG 图标、sandbox iframe、现有 node:test/Playwright。无新依赖、后端服务或数据库迁移。

## 1. 状态与范围

- 规划工作区：`C:/Users/EDY/.codex/worktrees/favorite-html-export-ui/feat-voc-positioning-skill-execution`，分支 `codex/favorite-html-export-ui`，规划开始 HEAD `e19a7f23`。
- 上轮已发布实现：`f4646fd6`。它完成八种来源的原页面快照，但所选模块仍纵向排列。本计划是其呈现层增量，不重新实现导出后端。
- 当前导航事实取自 `app/page.tsx` 的 `allNav` 和对应页面分支。实施前再次核对分支、正式基线、未提交内容及并行窗口，不能用旧计划 SHA 覆盖新正式版本。
- 本轮只改导出预览、导出选择和下载文件；在线应用导航、市场调研、收藏夹、管理员页面、分析规则、权限配置、连接池和数据持久化不变。
- 前述聊天将“变体 / 订单”列成独立导航子页面，现核实在线系统没有该入口：它属于竞品参数总览正文。本计划以真实导航为准，并保留其已有导出能力。

## 2. 完整导航与来源对照

| 一级入口 | 独立内容页面 / SnapshotPageId | 在线入口 | 沿用的快照来源与展示 |
| --- | --- | --- | --- |
| 竞品概览 | 竞品参数总览 / overview | overview | competitor-overview；页面内可包含 variants-orders |
| 竞品概览 | 主辅图 / images | overview-images | listing-images；保留全部主副图、图册与备注 |
| VOC | 竞品 VOC 汇总 / voc-summary | voc | voc：七维矩阵、智能评论、综合展示 |
| VOC | 竞品 VOC 洞察 / voc-insight | launch | voc：ProductLaunchRecommendationSection |
| VOC | 产品定义结论 / voc-positioning | voc-positioning | voc：VocPositioningSection |
| 关键词调研 | 竞品关键词分析 / keyword-analysis | keywords | keywords：KeywordDemandSection mode=analysis |
| 关键词调研 | 关键词洞察 / keyword-insight | keyword-insight | keywords：KeywordDemandSection mode=insight |
| 新品定义 | 新品定义 / definition | definition | definition：LocalProductDefinitionSection，完整九部分 |
| 立项前确认清单 | 立项前确认清单 / checklist | checklist | checklist：LaunchChecklistSection，完整十部分 |
| 竞品流量分析 | 竞品流量分析 / traffic | traffic | traffic：TrafficReportView |

- 共六个一级入口、十个内容页面。前三个一级入口包含子菜单，后三个直接打开页面，不增加一层同名菜单。
- 市场调研、收藏夹及其所有子页面、用户管理都不出现在导出导航或文件正文中。关键词分析里本身已有的流量词矩阵仍保留，不能因收藏夹也有“流量词对比”而误删。
- VOC 的“产品定义结论”与独立“新品定义”是两个不同页面，不合并、不混用来源。
- 变体 / 订单放回参数总览页原位置；在导出选择区保留“包含变体 / 订单”内容选项，默认勾选，不制造第十一个页面。选项关闭时不读取该缓存，也不导出其正文。参数总览未选时该选项不生效。
- 表格、章节、依据、规则说明仍是页面内部内容，不把每个表格扩成新的导航页。已选页面无结果时保留该页面并明确说明缺失，不静默删入口。

## 3. 用户流程与阅读规则

1. 已收藏项目 → 点击导出 → 原悬浮预览窗。
2. 左侧选择区按上述一级/二级分组勾选。父项支持全选、全不选和部分选中；只作用于有权限且已接入的子页面。首次默认全选这些页面。
3. 右侧预览内显示成品导航。选择区决定“文件包含什么”，成品导航决定“当前看哪页”，两者不互相代替。
4. 预览生成后默认显示按导航顺序排列的第一个已选页面；每次只显示一个正文区域。父项展开子菜单，叶子项切换页面并高亮所属父项和自身。
5. 浏览页面、展开依据不会重新读取数据或改变导出选择。改变勾选范围才重新准备预览；期间禁用下载并丢弃旧的异步结果。
6. 确认下载仍使用已准备好的原始 HTML 字符串。预览里临时切换的页签不重新序列化；下载文件初始打开同样的默认首页，全部所选正文与预览一致。
7. 手机/窄窗将六组菜单放在顶部的原生可展开导航中；子菜单不依赖鼠标悬停，表格仍可横向滚动。

外观沿用截图的白色卡片、蓝/青/红/橙/绿色图标、名称、副标题、箭头和选中描边。导出外壳只包含项目名称、站点、ASIN 数量、快照时间及必要来源说明，不带账号、管理入口、收藏操作、抓取或保存按钮。二级菜单采用可点击展开方式，保留原层级和配色；不复制在线路由及悬浮定位的业务代码。

## 4. 安全与数据边界

- 沿用八种内部来源 ID 和只读 reader；新增十个页面 ID 只描述显示范围。不能把页面 ID 直接当接口权限或放宽组织/项目/站点/ASIN/版本校验。
- 同一份 VOC 或关键词来源可供多个选中页面使用，但只渲染被选中的页面；未选页面不得藏在 DOM、template、JSON 或其他载荷中。已选页面自身需要的共用事实不因别的页面取消而误删。
- pageIds 与 includeVariants 必须参与准备/取消/确认的完整身份键。即使 voc-summary 改为 voc-insight 后 reader ID 都是 voc，也必须使旧预览和旧下载资格失效。
- 真正缺数据展示中文状态，读取异常/来源不匹配继续阻止确认；缺失不填零、不跨项目补齐、不重新采集/分析/翻译。
- `script-src 'none'`、`connect-src 'none'` 与 iframe `sandbox=""` 保持不变。折叠和分页使用原生 HTML/CSS，文件无需应用登录；图片仍使用在线安全 HTTPS 地址。
- 原序列化器继续移除导入的脚本、事件、输入行为和危险链接。仅在净化业务正文之后，由可信导航生成器添加固定 radio 控件、label、details 和 CSS；不得全局放行 name、事件或所有业务输入。
- 捕获阶段所有选中页面按可测量宽度完成渲染后再生成隐藏/切换状态；不能先 display:none 再截图图表，避免非首页图表宽高为零。每页保留原生全文、完整行和滚动区域。
- 一个文件仍包含所有所选数据。分页面解决阅读长度，不承诺减小文件大小或大幅缩短准备时间。大量内容通过选择范围减量。
- 打印时隐藏导航、展开所有已选页面的外层，保留完整正文；原生长文/证据折叠状态不自动伪装成新增数据。

## 5. 模块与接口

新增 `app/project-export/snapshot-navigation-catalog.ts`，为本轮导出唯一页面目录。不得在组件内再手写第二份菜单。既有 `module-catalog.ts` 继续负责内部来源及模块可见性。

```ts
type SnapshotPageId = 'overview' | 'images' | 'voc-summary' | 'voc-insight'
  | 'voc-positioning' | 'keyword-analysis' | 'keyword-insight'
  | 'definition' | 'checklist' | 'traffic';
type SnapshotSelection = Readonly<{
  pageIds: readonly SnapshotPageId[];
  includeVariants: boolean;
}>;
type ResolvedSnapshotSelection = Readonly<{
  pageIds: readonly SnapshotPageId[]; // 唯一、固定菜单顺序
  moduleIds: readonly ExportSectionId[]; // 来源 ID 去重
  includeVariants: boolean; // 没有 overview 时归一为 false
}>;
function resolveSnapshotSelection(
  selection: SnapshotSelection, visibleModules: readonly ModuleKey[] | undefined
): ResolvedSnapshotSelection;
```

运行时未知页面 ID 和越权 ID 拒绝，不静默替换；空选择保留为空由界面禁用确认。合法重复项去重。后端无需接受新 ID；在前端受控边界将 resolved.moduleIds 交给原 reader，同时将 pageIds/includeVariants 保存在准备结果中供渲染和确认核验。

新增 `snapshot-navigation-shell.ts`，输入已净化的页面标记、固定目录和转义后的项目标题，输出导航外壳及 CSS；不读接口、不接收任意 CSS/脚本。新增 `snapshot-navigation-styles.ts` 放作用域样式，避免挤占现有序列化器。

```ts
type SnapshotPageMarkup = Readonly<{ id: SnapshotPageId; html: string }>;
function renderSnapshotNavigation(pages: readonly SnapshotPageMarkup[]): string;
// 调用点必须位于业务正文净化之后；校验 ID 唯一且在目录中。
```

控制方式：同名原生 radio 对应十个允许的页面，默认第一个 checked；可信 label 关联固定 ID；CSS :checked 与兄弟选择器控制正文显示、菜单高亮，不依赖应用 JS。radio 视觉隐藏但保留键盘焦点和关联名称。不可使用隐藏属性或 display:none 抹掉所有导航焦点。

`PageSnapshotVoc` 改为显式单页参数 `page: 'voc-summary'|'voc-insight'|'voc-positioning'`；`PageSnapshotKeywords` 改为 `page: 'keyword-analysis'|'keyword-insight'`。外层原先用于模拟页签的 details 移除，页内证据/规则 details 保留。关键词来源说明归属每个被选中页面，不能只存在于已取消的页面。无分析输入时每个已选 VOC 页面独立显示缺失说明。

## 6. 分阶段任务及核验

所有路径相对上述开发工作区。每项完成后局部提交；下面的测试文件是实施时创建，当前只写计划。

### Task 1：页面目录和选择契约

**Files:** 新增 `app/project-export/snapshot-navigation-catalog.ts`；测试 `tests/agent/project-snapshot-navigation-catalog.test.ts`。读取 `app/page.tsx`、`shared/module-visibility-contracts.ts`，不改普通应用导航。

**Consumes:** 真实十页映射、原 ExportSectionId 和 ModuleKey。**Produces:** SnapshotSelection、ResolvedSnapshotSelection、resolveSnapshotSelection 及唯一目录。

- [x] 写失败用例：一级入口六个、叶子十个；没有 market/projects/admin；overview 默认映射 overview+variants，两种关键词页面共用一个 keywords 来源。
- [x] 写边界用例：只选 voc-insight 时页列表不含 summary/positioning；未知或不可见页面拒绝；去重排序；没有 overview 时 includeVariants=false；空选项不制造默认内容。
- [x] 运行 `node --import tsx --test tests/agent/project-snapshot-navigation-catalog.test.ts`，先观察新契约缺失失败，再实现上述纯函数并通过。
- [x] 核对源码实际菜单标签/顺序的对照断言，防止漏页；提交目录和测试。

核心断言（测试中导入 Task 1 的 resolveSnapshotSelection 与 node:assert/strict）：

```ts
assert.deepEqual(resolveSnapshotSelection({
  pageIds: ['voc-insight'], includeVariants: true,
}, ['voc']), {
  pageIds: ['voc-insight'], moduleIds: ['voc'], includeVariants: false,
});
assert.throws(() => resolveSnapshotSelection({
  pageIds: ['voc-summary'], includeVariants: false,
}, ['overview']));
```

### Task 2：导航外壳与双页面样板

**Files:** 新增 `snapshot-navigation-shell.ts`、`snapshot-navigation-styles.ts`；修改 `serialize-page-snapshot.ts` 的净化后装配点；测试 `tests/agent/project-snapshot-navigation-shell.test.tsx`。

**Consumes:** Task 1 目录与两个已净化页面。**Produces:** renderSnapshotNavigation、单文件无脚本导航样板。

- [x] 用两个带不同表格和 SVG 的样本编写失败用例，覆盖默认首选、切换单页、父子高亮和不显示另一页；确认当前长页不满足。
- [x] 生成可信 radio/label/details 外壳及作用域 CSS；保持旧业务正文清理策略，加入专门断言：业务输入仍 disabled/name 被剥离，只有生成器控件可切换。
- [x] 测试鼠标、键盘、窄屏、长二级菜单、文件直接打开和 sandbox iframe；关闭脚本仍可切换，零应用 API。
- [x] 运行 `node --import tsx --test tests/agent/project-snapshot-navigation-shell.test.tsx` 与 `tests/agent/project-page-snapshot.test.tsx`，通过后保存桌面/窄屏样板截图并提交。

### Task 3：十页原内容路由

**Files:** 修改 `page-snapshot-host.tsx`、`page-snapshot-voc.tsx`、`page-snapshot-keywords.tsx`、`read-page-snapshot-sources.ts`，必要时为选中页增加明确类型；测试 `tests/agent/project-snapshot-navigation-pages.test.tsx` 及既有 VOC/关键词/变体快照测试。

**Consumes:** ResolvedSnapshotSelection、现有冻结来源与共享展示组件。**Produces:** 十个可独立捕获的页面，每个页面一份明确的业务根区域。

- [x] 编写十页标题、主要表格及缺失状态的失败用例；参数总览合并可选变体，其他页面按映射复用现有展示。
- [x] 拆出 VOC 三页、关键词两页，不重算分析规则、不追加历史结果、不增加网络 reader。多个子页共享的来源每次准备只读取一份。
- [x] 验证只选一个 VOC/关键词子页面时，不出现其他子页面独有的文本、表格或隐藏载荷。检查页面内所有业务明细仍可原生展开。
- [x] 在捕获阶段为非首页页面验证 SVG/canvas 几何及完整月份，装配导航后才隐藏非当前页；校验图片、颜色、字段和规则说明不丢失。
- [x] 运行 `node --import tsx --test --test-concurrency=1 tests/agent/project-snapshot-navigation-pages.test.tsx tests/agent/project-page-snapshot-voc.test.tsx tests/agent/project-page-snapshot-keywords.test.tsx tests/agent/project-page-snapshot-variants.test.tsx`，通过后提交。

### Task 4：悬浮窗页面级勾选与取消边界

**Files:** 修改 `project-export-dialog.tsx`、`project-export.module.css`、`use-project-export.ts`、`read-export-eligibility.ts`；测试 `tests/agent/project-snapshot-navigation-selection.test.tsx`、既有 `project-page-snapshot-lifecycle.test.tsx`。

**Consumes:** Task 1 选择契约与 Task 3 页面渲染。**Produces:** 同一套父子页面选择驱动预览、准备结果和下载资格。

- [x] 先覆盖父选全选/取消/半选、隐藏无权限节点、空选禁止确认、仅选一页、变体内容选项和菜单顺序。
- [x] 将准备结果身份扩展为 project+session+pageIds+includeVariants，不能只比较 moduleIds；资格核验仍沿用既有来源权限。
- [x] 加入 voc-summary→voc-insight→voc-summary 的晚返回测试，以及确认期间切换两个共用来源的子页、撤销权限、关闭/重开、60 秒超时与重试测试。
- [x] 子页切换仅操作 iframe 内的原生控件，不触发外层选择、reader 或新分析；取消勾选当前页后重新准备默认首个剩余页。
- [x] 运行 `node --import tsx --test --test-concurrency=1 tests/agent/project-snapshot-navigation-selection.test.tsx tests/agent/project-page-snapshot-lifecycle.test.tsx tests/agent/analysis-project-favorites-ui.test.tsx`，通过后提交。

### Task 5：完整文件与普通页面回归

**Files:** 修改 `tests/agent/project-export-download-ui.test.tsx`；新增 `tests/agent/project-snapshot-navigation-file.test.tsx`；真实数据材料只放忽略目录 `test-results/`。

**Consumes:** 全部前述任务。**Produces:** 单文件导航、内容完整及安全边界的最终证据。

- [ ] 八种来源全部准备，核验十页在直接打开文件和预览 iframe 中都可逐一访问；第一次打开与默认首页一致。
- [ ] 对比预览的原始 HTML 与实际下载字节；预览切换页签后再次下载仍同串且来源未重读。新开文件默认首个已选页。
- [ ] 测试只选一页、部分子页、无数据项目；已选缺失页有说明，未选页不能通过文本搜索/隐藏 DOM 找到独有正文。
- [ ] 使用已有儿童漂移车、灯具、滑板车保存输入只读回放；对照参数/变体、图册、VOC 三页、关键词两页、定义、清单和流量，检查完整行数及图表。记录体积、首屏高度和准备耗时，不以减少业务内容换取数字改善。
- [ ] 桌面 1440×1000 与窄屏 390×844，逐页截图；导航不压正文，父子可键盘到达，非当前页不撑高整个报告。打印模式保留所有所选页面的正文。
- [ ] 运行 `node --import tsx --test --test-concurrency=1 tests/agent/project-export-download-ui.test.tsx tests/agent/project-snapshot-navigation-file.test.tsx tests/agent/project-page-snapshot.test.tsx`，重跑既有 20 项来源边界测试；检查普通在线导航和共享组件未受影响。通过后提交。

来源边界命令：`node --conditions=react-server --import tsx --test tests/agent/project-export-html.test.ts tests/agent/project-export-variants.test.ts tests/agent/project-page-snapshot-sources.test.ts tests/agent/project-page-snapshot-traffic-source.test.ts`。预期全部通过；React 展示测试不带 react-server 条件，避免错误加载服务端专用 React 入口。

### Task 6：验收记录与交接

**Files:** 本计划；`openspec/changes/add-favorite-html-export/{tasks,verification}.md`。

- [ ] 核对每个表格行都对应实际测试和截图；全选必须十页，不能仅报告六个入口可见。
- [ ] 执行 `npm run typecheck`、涉及导出文件的定向 ESLint、`npm run build`、`openspec validate add-favorite-html-export --strict` 和本轮完整范围 `git diff --check`。
- [ ] 更新 verification，记录真实测试数、普通页面回归、静态文件零应用 API、现存 lint 基线和外网图片未验证边界。
- [ ] 本地提交并提供可打开的多页面 HTML 示例；待用户另行要求发布时，再核对正式基线、并行开发、备份及活动任务，禁止直接覆盖。

## 7. 审核清单

- [ ] 导航数量和名称：六组、十页，排除市场/收藏/管理。
- [ ] 变体仍在参数总览，保留可选内容；VOC 三页、关键词两页均可独立选择。
- [ ] 一个 HTML 文件，页面切换无脚本/无接口，默认首个已选页面。
- [ ] 选择范围改变重建预览，浏览页签不重建数据，下载正文固定。
- [ ] 只改导出，先本地验收；正式发布需要另行授权。

以上审核项由用户确认后才进入 Task 1。本文件及 OpenSpec 的计划完成不代表功能已实现。
