# 原页面 HTML 快照实施计划

## 当前增量与状态（2026-09-27）

下面原页面快照实施部分为已完成阶段的设计记录，已经随 f4646fd6 正式发布；其中历史“待执行”和基线描述不代表当前实现状态。

新增待审核计划：`docs/superpowers/plans/2026-09-27-snapshot-navigation-pages.md`。该计划细化现有呈现方式：一个文件内按照原系统六个一级入口、十个内容页面切换，VOC 和关键词子页面独立选择；变体仍位于参数总览。选择区与成品导航分离，pageIds/includeVariants 纳入冻结身份，内部继续使用既有八种 reader。未选子页面不渲染到文件，已选缺失页保留明确说明。

实现时在已净化正文外构造固定、可信的原生 radio/label/details 导航外壳，使用作用域 CSS 切页；不放宽业务正文序列化，不引入应用脚本，保留 script-src/connect-src none 和空 sandbox。原用于模拟 VOC/关键词页签的外层 details 将由独立页面替代，页面内部依据、全文和规则折叠不变。捕获阶段先完成所有选中页可测量布局，再在成品中隐藏非当前页。

详细接口、页面清单、选择规则、测试和验收均以这份增量计划为准；它替代旧计划“各模块纵向排列”的呈现选择，其余数据、安全及原页面复用约束继续生效。用户 2026-09-27 已批准实施，按 tasks.md 第 11 部分跟进；正式发布仍需另行授权。

> 执行方式：在当前隔离工作区使用 executing-plans 逐项完成；每个模块完成后先核验，再进入下一模块。本文替代原 design.md 中按字段重组独立报告的实施方案。现有发布与测试历史保留在 verification.md。

**Goal:** 收藏项目导出与原业务页面一致的 HTML 快照，保留所选模块的业务展示、图表、表格和可展开详情，固定预览时的数据。

**Architecture:** 沿用现有鉴权、项目绑定及只读来源校验，将冻结的数据交给原页面共享展示组件。在独立只读渲染区域准备所选模块，序列化其真实 DOM 和样式，预览与下载使用同一份 HTML。停止递归展开后端对象、独立拼接字段报告的主链路。

**Tech Stack:** 现有 React / TypeScript、浏览器 DOM、内嵌 CSS、原生 details/summary、现有 SVG 图表、Blob 下载、Playwright 浏览器验收。无新增后端导出服务或数据库迁移。

## Context

- 开发位置：C:/Users/EDY/.codex/worktrees/favorite-html-export-ui/feat-voc-positioning-skill-execution，分支 codex/favorite-html-export-ui，当前基线 ff8fd2bb。
- 2026-09-26 核验正式发布基线 aa150c62，包含其他窗口的市场形态变更。实施前和发版前重新核验，不用旧分支覆盖正式版本。
- 现有儿童漂移车真实导出约 13.9 MB，VOC 63,899 个表格行，整份 71,992 行。主要问题是 exportFields 递归展开所有字段、额外规则/历史结果展开，以及将技术缺口逐条放在报告顶部。
- 已有收藏资格、版本绑定、只读 GET、变体缓存校验、翻译缺失保留原文、预览下载同串等修复继续保留。
- 当前阶段为计划已落盘、实现待执行。本次计划修改不代表新版页面快照已完成或已发布。

## Global Constraints

- 收藏 → 导出 → 悬浮窗选择模块和预览 → 确认下载 HTML，入口与流程不变。
- 收藏仅保存入口；本次预览准备才固定数据。确认下载不得再次拉取正文替换预览。
- 内容范围是原业务页面所选模块，包括原页面可展开、分页或滚动查看的业务内容；不是底层响应对象的全部字段。
- 八个模块全部需要适配；未完成的模块在本地明确禁选，不能静默回退为旧字段长表。所有模块完成前不正式发布半成品。
- 只读取已有数据；禁止发起采集、模型、翻译生成、规范化、保存报告或修复任务。
- 同组织、项目、站点、ASIN 与版本/报告来源约束不放宽。缺失不填零，跨来源不匹配仍报错。
- 图片保持在线 HTTPS；正文与样式无需原应用登录。无离线图片打包承诺。
- 不带应用脚本、React hydration 数据、会话凭据或后台操作。展开/收起用原生 HTML，下载文件不访问应用 API。
- 仅抽取需要复用的展示区域；不重构整个 page.tsx，不改分析算法、权限、连接池或市场模块。
- 收藏页不能恢复其他已卸载页面的未保存清单编辑，继续明确提示。

## Decisions

### 1. 选择原页面共享展示组件，再捕获 DOM

对比三种方式：
1. 直接保存收藏页 outerHTML：只能保存列表，其他模块尚未挂载，不能满足模块选择。
2. 截图：接近视觉，但无法展开内容、复制表格和完整查看未显示的行。
3. **采用：冻结来源 → 原模块展示区域 → DOM 与 CSS 快照。** 复用原页面结构，覆盖所选模块，不另做一套字段报告。

原页面已有独立组件的模块增加明确的只读快照展示模式；混在 page.tsx 的概览表、VOC 矩阵和流量矩阵只抽取展示 JSX。普通页面继续使用同一组件，不改计算与取数逻辑。禁止挂载整个业务页面来触发其中的 effects。

### 2. 读取和展示分离

从 read-export-content.ts 中分离资格/作用域校验与来源读取。新增 read-page-snapshot-sources.ts 返回所选模块的冻结、强类型页面输入；复用现有 reader 的边界检查，不返回 ExportBlock 字段树。

模块的输入类型直接复用原组件 Props 或已有来源契约；不引入任意对象递归渲染器。规则纯计算沿用原页面；当前页面没有展示的历史报告不额外查询或附加，避免跨版本内容重复。

页面与快照共同使用的 JSX 位于 app/project-report-views/；导出专用挂载、序列化和清理位于 app/project-export/。原页面通过依赖注入继续传入已有数据和事件，快照入口只传冻结数据。

### 3. 渲染与冻结边界

新增 page-snapshot-host.tsx 在离屏但可正常布局的独立区域挂载所选展示组件，沿用当前页面 CSS、布局宽度和字体。禁止 display:none 导致图表宽高为零；保持可取消，不改变用户原列表和页面状态。

公共接口：

~~~ts
export type SnapshotPresentation = 'page' | 'snapshot';
export type SnapshotCaptureOptions = Readonly<{
  root: HTMLElement;
  cssText: string;
  title: string;
  capturedAt: string;
}>;
export function serializePageSnapshot(options: SnapshotCaptureOptions): string;
export async function collectPageSnapshotStyles(document: Document, signal: AbortSignal): Promise<string>;
~~~

准备结束条件是所选组件全部提交 DOM、必要的页面数据已读取、两帧布局完成且 SVG/chart 尺寸有效。图片保留在线地址，不等外网图片全部成功加载才允许导出。准备沿用 60 秒超时和取消；样式或某模块准备失败不得输出残缺文件。

collectPageSnapshotStyles 读取应用同源已加载的 style/link 样式并内联，保留 CSS 变量、媒体查询和模块 class；静态资源路径转为允许的绝对地址。无法读取必要样式时明确失败，不只复制 class 名造成无样式报告。

serializePageSnapshot 仅克隆所选业务区域；删除 script、事件属性、操作按钮、表单提交目标、隐藏应用状态与危险 URL；保存已有输入框/勾选值为只读文本或 disabled 控件。保留安全 SVG；如实际遇到 Canvas，则同源安全转换为静态图，不允许图表悄悄为空。转换失败标记该模块准备失败。

图片代理地址还原成允许分享的在线原图地址，不复制登录 cookie。输出 CSP 继续禁止脚本与 API 连接，原生 details 不需要开启 iframe 脚本权限。

### 4. 阅读形态

- 默认展示与原模块相同的摘要、表格、卡片、颜色、图片和图表，新增元信息只有项目、站点、ASIN、快照时间和简短数据时间。
- 技术缺口在对应业务值显示“— / 暂无数据”，必要时合并一条中文说明；不把 catalog.rating、UPSTREAM_EMPTY 等代码逐条放到正文。
- 原页面折叠内容在快照中用 details/summary，默认收起状态沿用页面默认；展开后保留原业务排版，不用逐字段长表替代。
- 内部引用仍用于后台校验，但不主动渲染成正文。运营可见规则说明保留在原来的规则入口内，按原文和版本展示，不在每个模块额外附加完整规则库。
- 页内标签的已有内容映射成标题明确的原生折叠分区；不保留需要 React 回调的失效按钮。排序/筛选固定为本次准备的状态，不伪装成可重新查询。
- 原页面有分页、虚拟列表或“查看全部”时，快照准备包含该模块已有可读业务记录，在原表格/明细区提供滚动或折叠查看。不可只保存当前屏幕一页，也不可展开后台对象所有叶子。
- 当前入口位于收藏页，默认使用所选项目页面的默认展示状态，不承诺捕获另一个浏览器页签尚未保存的筛选/编辑状态。

## 实施顺序与验收

各项按：先写会失败的行为用例 → 最小展示/快照改动 → 测试与截图对照 → 独立提交。每个模块都核对来源、页面对应区域、折叠/分页、文件打开结果，不凭“生成成功”通过。

### Task 1：竞品参数总览样板与公共快照链路

**文件：** 新增 app/project-report-views/competitor-overview.tsx；新增 app/project-export/page-snapshot-host.tsx、read-page-snapshot-sources.ts、serialize-page-snapshot.ts、page-snapshot-styles.ts；修改 app/page.tsx、app/comparison-overview-card.tsx、app/project-export/use-project-export.ts、project-export-dialog.tsx；测试 tests/agent/project-page-snapshot.test.tsx。

- [ ] 固定儿童漂移车及一份灯具数据样例，记录原页面参数表和展开内容截图、字段值、颜色、缺失标记。
- [ ] 浏览器回归先断言：原页面与快照都存在相同的 compare-matrix 指标、产品顺序、价格/缺失值；正文没有原始缺口代码，无采集或写请求。
- [ ] 原样抽取概览展示区域并共享；拆开旧 reader 的来源读取与独立表格生成，保留卖点版本校验和原文兜底。
- [ ] 完成 DOM/CSS 序列化；挂入既有预览和 Blob 下载，严格保持同一字符串。
- [ ] 单模块在独立未登录浏览器打开文件；比较正常和窄窗口截图，检查横向滚动、折叠、图片地址和 SVG。
- [ ] 样板通过后提交，再接后续模块；失败先修公共链路，不扩散到其余七个模块。

**明确用例：** 用浏览器让原页面与快照消费同一份保存样例，比较 compare-matrix 的 innerText 与 computedStyle（字体、背景、边框）；下载文本等于 iframe.srcdoc。准备后改样例价格为 98765，下载仍包含准备时的原价格。断言快照 document.querySelectorAll('script,form[action],button[data-write-action]').length 为 0。

### Task 2：变体 / 订单

**文件：** app/xydc-variant-section.tsx、其实际调用的年/月详情子组件、app/project-export/read-variants-export.ts；新增快照模块 app/project-export/page-snapshot-variants.tsx；测试 tests/agent/project-page-snapshot-variants.test.tsx。

- [ ] 覆盖超过首页展示数的子体、12 个月订单、颜色占比、属性翻译、缺失月份。
- [ ] 复用 XydcVariantSection 卡片/表格，快照模式去除后台年检/请求 effects，完整已有详情转原生折叠。
- [ ] 保留真实颜色、未知颜色口径、数字与来源时间，禁止重新计算一套比例；全部子体可展开，首页不铺满详情。
- [ ] 比较原页面与文件的卡片和详情截图，检查输入 ASIN 范围及无后台调用，通过后提交。

### Task 3：主副图分析

**文件：** app/listing-images-section.tsx、app/project-export/listing-images-export-section.ts 的来源核验；新增 app/project-export/page-snapshot-images.tsx；测试 tests/agent/project-page-snapshot-images.test.tsx。

- [ ] 用超过默认显示列数的图片、含缺备注/补充备注样例建立失败用例。
- [ ] 沿用 ListingImagesSection 图片矩阵、URL 匹配备注和 overlay；显式传入来源，禁用默认全局数据回退。
- [ ] 快照包含全部已有图片，图片预览采用安全原图链接；不带生成备注/重新分析按钮。
- [ ] 检查断开的图片仍有说明，原备注与对应图片不串位，截图通过后提交。

### Task 4：VOC 分析

**文件：** app/page.tsx 中 VOC 七维与 ReviewAnalysisMatrixSection，app/voc-positioning-section.tsx、app/product-launch-recommendation.tsx；抽取 app/project-report-views/voc.tsx；修改 app/project-export/read-voc-definition-export.ts 的共享来源入口；测试 tests/agent/project-page-snapshot-voc.test.tsx。

- [ ] 使用儿童漂移车真实只读样例，记录原页面七维矩阵、评论矩阵、结论及原有规则入口。
- [ ] 共享这些展示区域，删除新快照路径对 exportFields 的依赖；只传当前页面实际需要的已存数据。
- [ ] 七维、好差评和结论保持原版式；原文、依据、规则在原有位置折叠，完整业务条目可展开。
- [ ] 回归一个包含大量内部 decision/source 字段的样例：内部字段数量增加不能增加可见正文行数或被隐藏序列化；原业务记录增加则按原表格增加。
- [ ] 与原页面逐区域截图比对，确认不再生成 63,899 行逐字段表，通过后提交。

### Task 5：关键词调研

**文件：** app/keyword-demand-section.tsx、app/keyword-demand-analysis.ts 的既有纯展示输出；新增 app/project-export/page-snapshot-keywords.tsx；测试 tests/agent/project-page-snapshot-keywords.test.tsx。

- [ ] 覆盖分析/洞察两个页面区域、超过 200 个关键词、月份曲线与规则说明。
- [ ] 复用 KeywordDemandSection，显式传入项目 sources，保留矩阵与图表；为快照准备全部已有词条并保留原有折叠/滚动层级。
- [ ] 未选标签内容不以后台对象附加；所选关键词模块约定含分析和洞察两部分，用原生分区查看。
- [ ] 核对全部词条可查看、缺失不填零、规则不重复平铺，截图通过后提交。

### Task 6：新品定义

**文件：** app/local-product-definition-section.tsx 与 app/page.tsx 定义入口，app/project-export/read-voc-definition-export.ts；新增 app/project-export/page-snapshot-definition.tsx；测试 tests/agent/project-page-snapshot-definition.test.tsx。

- [ ] 样例同时含当前结果与旧报告，建立不自动追加旧结果的用例。
- [ ] 共享当前新品定义各部分与最终表；保留结论、VOC 依据、关键词依据、产品动作、优先级和原有全文展开。
- [ ] 历史结果仅当当前原页面选中它时作为当前显示结果，不额外并列多个版本。保留该结果的规则版本与来源身份检查。
- [ ] 比较当前页面与文件的关键结论、表格列宽、折叠效果，通过后提交。

### Task 7：立项前确认清单

**文件：** app/launch-checklist-section.tsx、app/launch-checklist.ts；新增 app/project-export/page-snapshot-checklist.tsx；测试 tests/agent/project-page-snapshot-checklist.test.tsx。

- [ ] 建立十部分清单与系统/人工字段的用例。
- [ ] 复用原清单排版；可读取的已保存值固定为只读控件/文字，去掉保存入口。
- [ ] 不臆造另一页面未保存的勾选；对应位置保留待填写，顶部只提示一次未保存范围。
- [ ] 检查十部分全部存在、控件当前值写入 DOM、无保存请求，通过后提交。

### Task 8：竞品流量分析

**文件：** app/page.tsx 中流量矩阵与 TrafficAnalysisConclusionSection；抽取 app/project-report-views/traffic.tsx；复用 app/project-export/read-traffic-export.ts 中来源校验；测试 tests/agent/project-page-snapshot-traffic.test.tsx。

- [ ] 覆盖父子体、月份、自然/广告/推荐比例、已有结论与 Top N 限制。
- [ ] 原样复用表格/图表/结论；移除旧快照路径的报告递归展开；项目与运行身份校验保留。
- [ ] 所有已有月份在原区域可查看，无动态接口依赖、无未提供数据的零值评级，通过截图与来源测试后提交。

### Task 9：整体替换与真实验收

**文件：** app/project-export/use-project-export.ts、project-export-dialog.tsx、read-export-content.ts、render-export-html.ts、export-record-blocks.ts；tests/agent/project-export-download-ui.test.tsx；本变更 verification.md。

- [ ] 八模块均完成后将主链路切换至原页面快照；停止旧 exportFields/ExportBlock 递归报告路径，删除仅被旧导出使用的死代码与对应过时断言，保留来源/隔离回归。
- [ ] 对儿童漂移车、灯具、滑板车和缺数据项目做正式数据的只读本地回放，记录每个模块的截图对照、准备耗时、HTML 大小、DOM 行数、默认页面高度。
- [ ] 真实八模块组合、单模块、取消 VOC、读取失败重试、取消/超时、切换项目、取消收藏与权限撤销均验证；未选内容连隐藏 DOM 也不存在。
- [ ] 同一视口下原页面与文件的业务表格、图表、颜色与默认折叠布局逐项一致；仅允许项目快照头、禁用操作和分页转完整可读区域的约定差异。目录列表和侧边导航不进入文件。
- [ ] 独立无登录浏览器打开下载文件，核对预览 HTML 与下载字节相同、原生折叠能操作、零应用 API 请求；公开图片加载与不可用状态分开记录。
- [ ] 原页面的正常交互、分析入口、收藏和权限测试通过，保证共享组件抽取没有改变正式页面行为。
- [ ] 记录实测结果后提交供业务验收。未获后续发布指令不发布；发布时按正式最新基线追加本轮提交，保留其他窗口改动。

## 统一检查命令

~~~powershell
node --import tsx --test tests/agent/project-page-snapshot*.test.tsx tests/agent/project-export-download-ui.test.tsx
node --conditions=react-server --import tsx --test tests/agent/project-export-sources.test.ts tests/agent/project-export-variants.test.ts tests/agent/project-export-traffic.test.ts tests/agent/selling-point-published-source.test.ts tests/agent/selling-point-translation-http.test.ts
npm run typecheck
npx eslint app/project-export app/project-report-views
openspec validate add-favorite-html-export --strict
git diff --check
~~~

浏览器用例不与 react-server 条件混跑。构建与原页面相关回归在 Task 9 一并执行；阶段内仅运行对应已创建测试文件，避免把尚未接入模块当成测试通过。

## Risks / Trade-offs

- 原组件可能在挂载时抓取、轮询或创建后台任务：拆分展示层或显式 snapshot 模式，在失败用例中拦截一切非计划请求；禁止靠不传回调来猜测无副作用。
- CSS 只复制 class 会丢失样式：收集真实页面 CSS 并内联，另浏览器不登录验证；快照 CSS 只对导出文档生效。
- 折叠组件只在展开后挂载：准备完整内容并转原生 details，不能只 clone 当前可见 DOM。
- SVG 依赖宽高或渐变 id：以有效宽度渲染，每模块 id 必须唯一，浏览器截图验证。
- 所有记录确实较多时文件仍可能较大：完整保留业务记录，用原有折叠和滚动控制默认阅读长度；不以删除记录换取速度，也不预先承诺固定 MB 或秒数。
- 单 HTML 无法保留整套应用交互：只保留原生查看操作，编辑、分析、查询和后台同步不复制。

## Migration Plan

开发工作区完成全部样板和模块验证；未完成时仅本地禁用相应导出选择。保留现有正式导出直到整体替换通过。无数据库/数据目录变动，无迁移任务。若发布后需回退，只回退本次页面快照呈现改动，不能退掉 aa150c62 中的来源修复或其他窗口的功能。

## 2026-09-27 线上验收修复增量

真实项目“ 三轮滑板车1 ”当前发布目录为空，5 个 VOC 状态为 3 timeout、1 model-output、1 success。原页面新品定义通过 LocalVocDefinition 核验规范化状态，而快照直接挂载 LocalProductDefinitionSection，漏掉等待/失败状态。修复读取当前批次的只读状态，校验 ASIN、稳定性及成功 revision 的落库可见性；已知失败/等待输出状态页，API 读取异常阻止准备并允许重试。保留已保存输入、未完成原因和已有其他模块；不重跑模型、不填造目录、不跨项目补数。原页面和快照共享安全中文失败说明。VOC 矩阵/洞察与清单本身仍使用原页面现有的展示规则，不扩大归一化闸门到原来不依赖该闸门的组件。

悬浮窗占用可用视口，头尾固定，正文外层不滚动；选择区单独滚动，iframe 自适应剩余高度。增加收起/展开选择按钮，收起不改变选择、冻结 HTML 或下载内容。窄屏保留有限高度选择区，并可收起后阅读完整正文。成品 HTML 导航和业务表格本身的必要滚动保留。

## 2026-09-27 导出导航固定与轻量 UI 优化

用户验收要求固定成品 HTML 左侧导航并优化页面 UI。范围仍为快照页面，不改变正式业务页、数据来源、父子菜单与十页映射。定位发现导出样式给 html/body 同时设置 overflow:auto，body 随内容展开却成为 sticky 的最近滚动祖先，实际文档滚动时导航会离开视口。

修复让 html 负责文档滚动、body overflow:visible，桌面导航 sticky 距顶 16px、限制可用视口高度，超长目录内部滚动。窄屏沿用可折叠菜单，不固定占满屏幕。UI 使用 224px 白色目录栏、简化边框/阴影、紧凑子项、淡色选中背景，保留模块色和键盘焦点；去掉布局内部额外的 1600px 宽度限制与 20px 重复留白，让正文利用现有外层 1800px 宽度。表格原文、数字、图表与业务规则不改。

验证：实际生成文件和 sandbox 预览向下滚动后导航仍可见；低高度视口能滚到末项；无脚本切页、键盘选择、窄屏折叠及打印全部页保持。再次发布需用户单独要求；已下载旧 HTML 是固定文件，需要发布后重新导出才能带上新样式。
