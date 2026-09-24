# 收藏项目 HTML 快照导出实施计划（已审核，逐模块执行）

> **For agentic workers:** 用户于 2026-09-24 批准实施，要求逐模块推进。进度以 tasks.md 为准；每个模块先核来源，再完成准备、渲染、下载和回归。尚未接入的模块须标明待接入并禁选，不能伪装为业务无数据。

**Goal:** 收藏项目后，勾选模块、悬浮预览并直接下载固定内容的 HTML。

**Architecture:** 复用已有只读结果，在浏览器内整理成独立报告；同一个 HTML 字符串用于预览和下载。图片使用在线地址，不创建服务端导出任务或文件存储。

**Tech Stack:** 现有 Next.js / React / TypeScript、Zod、浏览器 Blob / URL、node:test、Playwright；不新增第三方依赖。

## Global Constraints

- 保留一期按钮、模态悬浮窗及原项目列表/收藏/编辑/加载行为。
- 只有已收藏且有权查看的项目可导出，所选模块遵循当前可见范围。
- 导出已有完整内容，不重新采集、不调用大模型、不启动修复任务。
- 正文、表格、结论、静态图表和样式固定在文件，图片在线读取。
- 不建设导出队列、下载历史、文件存储或过期清理；不要求断网可用。
- 不修改分析规则、数据库结构、供应商连接池或正式数据目录。
- 不混入其他窗口改动，不自动推送、合并或发布。
- 用户已批准实施及其余模块接入，后续验收、合并和发布分别记录。

## Context

工作区分支 codex/favorite-html-export-ui；一期提交为 15ca8322，第一模块及公共下载链路提交为 7a0b8ed4。其余模块在同一隔离工作区实施。未跟踪 .cache 是此前保留的测试缓存，本轮不处理。

可复用的现有代码：
- app/lib/project-display-version-browser.ts：readCurrentProjectDisplayVersion 读取已发布报告版本，校验组织、项目、站点、ASIN、阶段结果，不启动任务。
- app/lib/runtime-analysis-data.ts 与 runtime-analysis-data-server.ts：读取补充数据，但部分来自生成缓存，不能仅凭 ASIN 相同认定为当前项目结果。
- app/lib/saved-analysis-reports.ts：按运行批次和报告 ID 读取已有结果。
- app/lib/local-rule-report-browser.ts：读取已保存规则报告；不能调用其中的保存操作来冒充读取。
- app/lib/traffic-snapshot-browser.ts：既有批次流量快照读取。
- app/lib/amazon-image.ts：页面图片使用 /api/amazon-image 代理，导出需恢复可分享的原始在线地址。
- app/launch-checklist-section.tsx：人工勾选、manualValues、tableValues 在组件 state；收藏页不能恢复已卸载的未保存人工编辑。

## Goals / Non-Goals

**Goals:** 所选已有结果完整、预览与文件一致、后续线上修改不改变文件、接收者无需登录应用阅读正文。

**Non-Goals:** 离线图片、像素级截图、复制整套应用、导出后台、自动补分析、额外修建清单编辑持久化系统。

## Decisions

### 1. 用户流程和状态

收藏项目 → 导出 → 悬浮窗勾选模块 → 准备完整已有内容 → 固定预览 → 确认下载 HTML。

默认勾选当前可见且已接入的模块；用户可取消。分模块接入期间，其余模块明确标为待接入并禁选。准备中和读取失败时禁止下载；已接入但未生成的模块显示“暂无已生成结果”，不悄悄隐藏。没有选择时提示至少选一项。

使用“准备内容 / 可导出 / 读取失败”的真实状态，不制造百分比进度。关闭弹窗取消请求，清理本次内存报告；再次打开重新准备。保留原列表搜索、分页、滚动位置和焦点行为。

报告标注快照准备完成时间；来源更新时间另行展示，不能把快照时间说成数据采集时间。

### 2. 固定内容的方法

先读取收藏项目最新元信息，沿已有 sourceProjectId/项目绑定找到分析项目，校验会话、收藏和访问范围。不得凭名称或 ASIN 猜测另一个项目。

优先复用已有已发布显示版本及其绑定结果；补充模块只读匹配的项目、站点、ASIN 和报告/运行批次。对可变来源核验读取期间的版本或更新时间，变化则提示重新准备；稳定的已发布版本不因线上出现更新而自动替换。

在浏览器中建立独立数据副本，只在本次弹窗内缓存，不写 localStorage 或服务端。修改勾选后生成新预览，不能直接下载旧范围。确认时仅重新核验资格，不重新拉取正文替换预览。

允许复用原页面的纯展示计算和格式化；不挂载会触发抓取/保存的整页组件，不为缺失结果重新生成业务结论。

2026-09-24 补充口径：收藏不是数据冻结点。变体/订单使用页面现有共享缓存，通过原接口的 exportStrict=1 只读模式核验授权项目、完整 ASIN 范围、站点及缓存格式，重复读取比较内容（含译名）；明确标注共享缓存与来源时间，不以任务进度证明正文属于某分析批次。没有已发布目录时不借用全局商品投影。

VOC、新品定义和清单共用本次准备期间的已校验读取 Promise；缓存只在一次准备内存活，不跨项目或弹窗。可变来源仍读取两次核对，异常使准备失败。当前页面的纯规则展示与已保存历史报告分别标注，历史版本不得取代当前清单或当前结论；不自动启用评论兜底。保存的规则定义与版本原样保留，当前规则仅供对照。

### 3. 模块来源与完整性清单

| 模块 | 已有入口/内容 | 核验要求 |
|---|---|---|
| 竞品概览 | comparison-overview-card.tsx、page.tsx 概览展示和已发布阶段结果 | 参数、价格、评分、销量及既有趋势等内容块逐一映射，不能只保留参数表 |
| 变体/订单 | runtime-analysis-data 中现有共享 variants/variantOrders 缓存 | 所有已有子体、属性、订单、12 个月趋势及缺失标记；严格授权/格式/读取稳定性校验，不声称运行绑定 |
| 主副图 | listing-images-section.tsx、listing/image_remarks 阶段和备注 overlay | 全部已有图片及对应分析/备注，索引与图片一致 |
| VOC | use-manual-alexa-voc.ts、voc-display-schema.ts、评论阶段 | 七维、已有评论分析及依据；读规范化结果，不发起规范化 |
| 关键词 | keyword-demand-section.tsx、keyword-demand-analysis.ts、keywords 阶段 | 分析与洞察完整内容，复用既有展示计算，不截断在 UI 页码 |
| 新品定义 | saved-analysis-reports.ts、local-rule-report-browser.ts、local-product-definition-section.tsx | 已保存的完整定义、依据与优先级，不只最终表，不自动生成新报告 |
| 立项清单 | launch-checklist-section.tsx、launch-checklist-export.ts | 系统已有内容与可读取的已保存人工项；未保存组件 state 无法恢复，预览明确提示 |
| 竞品流量 | 已发布 traffic 阶段、traffic-snapshot-browser.ts、已有 traffic-analysis 报告 | 流量结构、全部已有子体及结论，保留 Top N/来源不完整标记 |

Task 1 核对八个模块的实际来源与所有展示块，并记录成功样例。此表不是“所有接口已接通”的声明。没有业务结果可显示未生成，不能把“适配器没实现”当作无数据交差。

已有数据缺口按原义呈现；请求失败/来源不匹配必须阻止该模块准备完成。原始来源只有 Top N 时如实说明，不承诺全量市场数据。缺失不填零，不按同 ASIN 调用别的项目结果。

### 4. HTML 生成、预览与下载

新增纯 HTML 渲染入口，复用现有纯展示构建/格式化逻辑，保留白底表格、配色、标题及图表语义。不复制导航、编辑按钮、分析按钮和应用运行脚本。

预览用 sandbox iframe 的 srcDoc，不授予脚本、表单或同源权限。下载使用同一个 HTML 字符串生成 UTF-8 Blob；禁止下载时重新渲染或拉取正文。

表格含全部行，可横向滚动；详情完整展开或使用原生 details；图表用静态 SVG/已有静态展示输出数值和标签，无需应用 JS。

仅序列化所选模块，未选数据不能藏在 HTML、CSS 隐藏节点或 JSON 内。正文按文本转义，URL 只允许安全协议，不携带 cookie、令牌或不必要会话字段。

文件名：项目名称_站点_快照_北京时间YYYYMMDD-HHmmss.html。去除非法文件名字符并限制项目名长度。发起下载后释放 Blob URL，防重复点击；提示“已发起下载”，不宣称已确认落盘。

### 5. 在线图片边界

图片不下载打包、不转换 Base64、不等待全部加载后才允许导出。将站内图片代理转换为校验过的 HTTPS 原始来源；文件不能依赖 127.0.0.1、局域网地址、登录 cookie 或相对图片路径。

无可分享地址时保留说明文字；在线图片加 alt 和安全原图链接。远端图片以后可能变化或失效，不承诺图片内容也被固定保存。必要 CSS 内嵌，避免样式随线上更新变化。

### 6. 权限与错误

数据准备和下载确认沿用既有会话/权限/收藏读取。应用获知退出、权限撤销或取消收藏后清空待导出内容。已下载文件不提供远程撤回或防篡改认证。

读取失败展示具体模块，用户可重试或取消该模块；重试只能读取已有结果，不能发起分析。后台读接口缺字段时，只补既有读取处理器和契约，不改成导出服务。

## Implementation Plan

任务只在本计划审核通过后执行；文件路径以下均相对本工作区。

### Task 1：核实数据来源，建立验收样例

**Files:** 本 design.md 来源表；新增 tests/agent/project-export-sources.test.ts；读取上述现有 helpers。
- 核对收藏 ID → 分析项目 → 已发布版本/运行批次/报告 ID 的真实链路。
- 对八个模块记录字段、全部内容块、分页/详情、完整性标记和可变来源版本。
- 准备不同类目的脱敏样例，包括同 ASIN 不同项目、来源缺失、人工清单未保存和来源只有 Top N。
- 先编写来源失败用例，证明不能串项目、不能虚构数据、不能触发写入或供应商请求。
- 既有接口如缺必要只读字段，明确具体字段与改动文件后补充；不新建导出存储。
**完成标准：** 八个模块均有可核验结果路径或明确业务无结果状态，没有以“尚未实现”代替无结果。

### Task 2：读取并固定完整内容

**Create:** app/project-export/export-contracts.ts、read-export-content.ts、export-source-adapters.ts。
**Modify:** module-catalog.ts；**Test:** tests/agent/project-export-sources.test.ts。

约定接口：
- ExportRequest：sessionIdentity、organizationId、libraryProjectId、moduleIds、signal。
- PreparedExportContent：schemaVersion、项目元信息、capturedAt、所选模块数据和来源版本、明确缺失说明。
- readExportContent(request, readers)：返回 PreparedExportContent；readers 仅封装 Task 1 核实的 GET 读取。
- 模块业务状态区分 ready 与 missing；读取异常携带 moduleId 抛出，不能当成 missing。

先补失败测试，再实现和验证：分页完整性、深复制后不随源对象变化、请求取消、晚返回、项目/会话切换、来源不匹配与读取期间变更。测试请求日志不允许 POST/PUT/PATCH/DELETE 或供应商调用。

### Task 3：生成静态 HTML 并下载

**Create:** app/project-export/render-export-html.ts、export-html-styles.ts、download-export-html.ts。
**Test:** tests/agent/project-export-html.test.ts。

约定接口：
- renderExportHtml(content: PreparedExportContent): string。
- buildExportFileName(projectName: string, marketplace: string, capturedAt: string): string。
- downloadExportHtml(html: string, fileName: string): void。

先添加全量行/详情、中文、特殊字符、缺失值、未选模块排除、URL、文件名用例，再实现。渲染函数无网络调用；下载只用传入字符串，不抓取正文。已选图表必须保留数值和标签，不用一句“图表略”替代。

### Task 4：接入已有悬浮窗

**Create:** app/project-export/use-project-export.ts。
**Modify:** project-export-dialog.tsx、project-export.module.css、project-library-panel.tsx、app/page.tsx。
**Test:** 新增 tests/agent/project-export-download-ui.test.tsx；扩展 analysis-project-favorites-ui.test.tsx。

状态：idle → preparing → ready，读取失败为 error，确认资格时为 checking，关闭/失效清空。会话、项目或选择范围变化使旧响应失效。

用 hook 管理准备/取消/固定 HTML，业务页面只传递作用域。srcDoc 和下载使用同一个字符串。改变选择先禁用旧确认状态，再准备新预览。保留键盘操作、焦点恢复、列表刷新和窄屏行为。

浏览器用例先失败再通过；确认空选择禁用、读取失败可重试、取消中止请求、权限撤销阻止下载、已选范围不混入其他模块。

### Task 5：验收并记录结果

**Modify:** 本变更 verification.md 追加二期结果，保留一期事实。按范围本地提交，不发布。

| 用例 | 验收结果 |
|---|---|
| 未收藏、未知状态、权限不可见 | 不提供有效导出；未授权内容不入文件 |
| 只选两个模块 | 只含两个模块，移除后连隐藏数据也不存在 |
| 100 行表格、至少两个 ASIN、折叠详情 | 全部已有内容保留，缺失不填零 |
| 预览后线上结果更新 | 下载正文与原预览一致，不读取新正文替换 |
| 读取失败、重试、取消 | 错误明确，不静默少导，不触发采集/模型 |
| 同 ASIN 不同项目、晚响应和会话切换 | 无串项目或跨会话结果 |
| 已有缺口、未保存清单人工项 | 预览和文件明确标注，无伪造完整性 |
| 标题/评论/备注含 HTML | 安全显示，不执行输入脚本 |
| 独立浏览器打开下载文件 | 无原登录会话也能看正文和样式；图片走在线来源，无分析/刷新请求 |
| 小/大项目性能 | 分别记录读取耗时、生成耗时、文件大小，不预先承诺固定秒数 |

执行命令：
- node node_modules/tsx/dist/cli.mjs --test tests/agent/project-export-sources.test.ts tests/agent/project-export-html.test.ts tests/agent/project-export-download-ui.test.tsx tests/agent/analysis-project-favorites-ui.test.tsx tests/agent/project-library-pagination.test.ts
- npm run typecheck
- node node_modules/eslint/bin/eslint.js app/project-export tests/agent/project-export-sources.test.ts tests/agent/project-export-html.test.ts tests/agent/project-export-download-ui.test.tsx
- openspec validate add-favorite-html-export --strict
- git diff --check

期望：相关回归、类型检查、定向 lint 通过，OpenSpec 有效，无空白错误；集成文件原有 lint 诊断单独对比基线，不声称全仓清零。

## Risks / Trade-offs

- 屏幕可能只渲染一页 → 读取完整已有结果后生成，不保存当前屏幕 DOM。
- 历史来源归属不足 → 明确无法校验，不按同 ASIN 找别的结果替代。
- 清单人工项仅在组件内存 → 提示未保存范围，此次不新建编辑持久化能力。
- 在线图片会变化/失效 → 图片保持在线依赖，正文和样式固定。
- 大报告占用浏览器内存 → 实测、准备状态和可取消，不静默截断。
- 文件可被接收者自行编辑 → 不提供防篡改或远程撤回。

## Migration Plan

无数据库或运行目录迁移。一期前端保留；二期已获批准并逐项实现与验收。验收后的合并/发布另行按用户指令处理。
